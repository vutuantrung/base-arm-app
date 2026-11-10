import { EventEmitter } from 'node:events';
import { ApplicationLifecycleManager, type ApplicationRuntimeView } from './application-lifecycle-manager.js';

export interface RuntimeMonitoringOptions {
  intervalMs?: number;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
}

export type RecoveryState = 'IDLE' | 'SCHEDULED' | 'RECOVERING' | 'EXHAUSTED' | 'MANUALLY_STOPPED';
export interface RuntimeMonitorStatus {
  application: ApplicationRuntimeView;
  recovery: {
    state: RecoveryState;
    attempts: number;
    nextAttemptAt?: string;
    lastError?: string;
  };
}

interface TrackedApplication {
  expectedRunning: boolean;
  attempts: number;
  state: RecoveryState;
  nextAttemptAt?: number;
  lastError?: string;
}

const DEFAULTS = {
  intervalMs: 1000,
  readinessTimeoutMs: 15000,
  readinessPollMs: 250,
  restartBaseDelayMs: 500,
  restartMaxDelayMs: 30000,
};

/**
 * Observes managed processes and performs bounded recovery.
 * A disconnected ARM WebSocket or UNKNOWN readiness is not evidence of process death.
 */
export class ApplicationRuntimeMonitor extends EventEmitter {
  private readonly tracked = new Map<string, TrackedApplication>();
  private readonly busy = new Set<string>();
  private readonly options: Required<RuntimeMonitoringOptions>;
  private interval?: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly lifecycle: ApplicationLifecycleManager,
    options: RuntimeMonitoringOptions = {},
  ) {
    super();
    this.options = { ...DEFAULTS, ...options };
    if (Object.values(this.options).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('Monitoring options must be positive integers');
    }
    if (this.options.restartBaseDelayMs > this.options.restartMaxDelayMs) {
      throw new Error('restartBaseDelayMs cannot exceed restartMaxDelayMs');
    }
  }

  /**
   * On Supervisor restart, adopt already-running managed applications.
   * A stopped process is not implicitly restarted without a persisted intent.
   */
  async restoreRunningApplications(): Promise<void> {
    this.assertOpen();
    for (const view of await this.lifecycle.listApplications()) {
      if (view.process.status !== 'RUNNING') continue;
      const state = this.track(view.applicationId);
      state.expectedRunning = true;
      state.state = 'IDLE';
    }
  }

  startMonitoring(): void {
    this.assertOpen();
    if (this.interval) return;
    this.interval = setInterval(() => { void this.tick().catch(error => this.emit('monitor.error', error)); },
      this.options.intervalMs);
    this.interval.unref();
  }

  stopMonitoring(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  /** Called when the Supervisor no longer needs monitoring; leaves children running. */
  close(): void {
    this.stopMonitoring();
    this.closed = true;
    this.lifecycle.close();
  }

  async startApplication(applicationId: string): Promise<RuntimeMonitorStatus> {
    return this.withApplicationLock(applicationId, async () => {
      const view = await this.lifecycle.startApplication(applicationId);
      const tracked = this.track(applicationId);
      tracked.expectedRunning = true;
      tracked.state = 'IDLE';
      tracked.attempts = 0;
      tracked.nextAttemptAt = undefined;
      tracked.lastError = undefined;
      await this.waitForReadiness(applicationId, view);
      return this.inspectApplication(applicationId);
    });
  }

  async stopApplication(applicationId: string): Promise<RuntimeMonitorStatus> {
    return this.withApplicationLock(applicationId, async () => {
      // Do not schedule restarts after a deliberate stop.
      const tracked = this.track(applicationId);
      tracked.expectedRunning = false;
      tracked.state = 'MANUALLY_STOPPED';
      tracked.nextAttemptAt = undefined;
      await this.lifecycle.stopApplication(applicationId);
      return this.inspectApplication(applicationId);
    });
  }

  async restartApplication(applicationId: string): Promise<RuntimeMonitorStatus> {
    return this.withApplicationLock(applicationId, async () => {
      const view = await this.lifecycle.restartApplication(applicationId);
      const tracked = this.track(applicationId);
      tracked.expectedRunning = true;
      tracked.state = 'IDLE';
      tracked.attempts = 0;
      tracked.nextAttemptAt = undefined;
      tracked.lastError = undefined;
      await this.waitForReadiness(applicationId, view);
      return this.inspectApplication(applicationId);
    });
  }

  async activateRelease(applicationId: string, version: string): Promise<void> {
    await this.withApplicationLock(applicationId, async () => {
      const tracked = this.track(applicationId);
      tracked.expectedRunning = false;
      tracked.state = 'MANUALLY_STOPPED';
      tracked.nextAttemptAt = undefined;
      await this.lifecycle.activateRelease(applicationId, version);
    });
  }

  async inspectApplication(applicationId: string): Promise<RuntimeMonitorStatus> {
    const application = await this.lifecycle.inspectApplication(applicationId);
    const state = this.track(applicationId);
    return {
      application,
      recovery: {
        state: state.state,
        attempts: state.attempts,
        ...(state.nextAttemptAt ? { nextAttemptAt: new Date(state.nextAttemptAt).toISOString() } : {}),
        ...(state.lastError ? { lastError: state.lastError } : {}),
      },
    };
  }

  async listApplications(): Promise<RuntimeMonitorStatus[]> {
    const applications = await this.lifecycle.listApplications();
    return Promise.all(applications.map(item => this.inspectApplication(item.applicationId)));
  }

  /**
   * Single sequential sampling cycle; exported for deterministic tests.
   * Recovery is scheduled only after a previously managed RUNNING process exits.
   */
  async tick(): Promise<void> {
    this.assertOpen();
    const applications = await this.lifecycle.listApplications();
    for (const application of applications) {
      if (this.busy.has(application.applicationId)) continue;
      await this.withApplicationLock(application.applicationId, async () => {
        await this.observe(application.applicationId);
      });
    }
  }

  private async observe(applicationId: string): Promise<void> {
    const view = await this.lifecycle.inspectApplication(applicationId);
    const state = this.track(applicationId);
    if (!state.expectedRunning) return;
    if (view.process.status === 'RUNNING') {
      // Readiness is telemetry, not an OS crash signal.
      return;
    }
    if (view.process.status === 'UNKNOWN') return; // PID identity is unverified.
    const manifest = (await this.lifecycle.storage.readRelease(applicationId, view.version))?.manifest;
    if (!manifest) return;
    const policy = manifest.lifecycle;
    if (policy.restartPolicy === 'never' || policy.maxRestarts === 0) {
      state.expectedRunning = false;
      state.state = 'EXHAUSTED';
      this.emit('recovery.exhausted', { applicationId, reason: 'restart disabled' });
      return;
    }
    if (state.attempts >= policy.maxRestarts) {
      state.expectedRunning = false;
      state.state = 'EXHAUSTED';
      this.emit('recovery.exhausted', { applicationId, attempts: state.attempts });
      return;
    }
    if (!state.nextAttemptAt) this.scheduleRecovery(applicationId, state);
    if (Date.now() < state.nextAttemptAt!) return;
    await this.attemptRecovery(applicationId, state);
  }

  private scheduleRecovery(applicationId: string, state: TrackedApplication): void {
    const delay = Math.min(this.options.restartMaxDelayMs,
      this.options.restartBaseDelayMs * 2 ** Math.min(state.attempts, 30));
    state.nextAttemptAt = Date.now() + delay;
    state.state = 'SCHEDULED';
    this.emit('recovery.scheduled', { applicationId, attempt: state.attempts + 1, delayMs: delay });
  }

  private async attemptRecovery(
    applicationId: string, state: TrackedApplication,
  ): Promise<void> {
    state.attempts++;
    state.state = 'RECOVERING';
    state.nextAttemptAt = undefined;
    try {
      const started = await this.lifecycle.startApplication(applicationId);
      await this.waitForReadiness(applicationId, started);
      state.state = 'IDLE';
      state.lastError = undefined;
      this.emit('recovery.succeeded', { applicationId, attempts: state.attempts });
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.state = 'SCHEDULED';
      this.emit('recovery.failed', { applicationId, attempts: state.attempts, error: state.lastError });
      // A process that started but failed readiness may still be RUNNING.
      // Never launch a second process while the first remains alive.
      const current = await this.lifecycle.inspectApplication(applicationId);
      if (current.process.status === 'RUNNING') {
        state.expectedRunning = false;
        state.state = 'EXHAUSTED';
        this.emit('recovery.exhausted', { applicationId, reason: 'process running but not ready' });
      }
    }
  }

  private async waitForReadiness(applicationId: string, initial: ApplicationRuntimeView): Promise<void> {
    if (initial.readiness === 'NOT_CONFIGURED') return;
    const deadline = Date.now() + this.options.readinessTimeoutMs;
    while (Date.now() < deadline) {
      const current = await this.lifecycle.inspectApplication(applicationId);
      if (current.process.status !== 'RUNNING') throw new Error('Process exited during startup');
      if (current.readiness === 'HEALTHY') return;
      await new Promise<void>(resolve => setTimeout(resolve, this.options.readinessPollMs));
    }
    throw new Error(`ARM readiness timeout: ${applicationId}`);
  }

  private track(applicationId: string): TrackedApplication {
    let state = this.tracked.get(applicationId);
    if (!state) {
      state = { expectedRunning: false, attempts: 0, state: 'IDLE' };
      this.tracked.set(applicationId, state);
    }
    return state;
  }

  private async withApplicationLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.busy.has(id)) throw new Error(`Application operation in progress: ${id}`);
    this.busy.add(id);
    try { return await action(); }
    finally { this.busy.delete(id); }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ApplicationRuntimeMonitor is closed');
  }
}

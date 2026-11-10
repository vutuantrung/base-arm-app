import { EventEmitter } from 'node:events';
import { ApplicationLifecycleManager, type ApplicationRuntimeView } from './application-lifecycle-manager.js';
import { RuntimeStateStore, type DurableRuntimeRecord } from './runtime-state-store.js';

export interface RuntimeMonitoringOptions {
  intervalMs?: number;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  stableResetMs?: number;
}

export type RecoveryState = 'IDLE' | 'SCHEDULED' | 'RECOVERING' | 'EXHAUSTED' | 'MANUALLY_STOPPED';
export interface RuntimeMonitorStatus {
  application: ApplicationRuntimeView;
  recovery: {
    state: RecoveryState;
    attempts: number;
    nextAttemptAt?: string;
    lastError?: string;
    desired?: 'RUNNING' | 'STOPPED';
    lastExit?: DurableRuntimeRecord['lastExit'];
  };
}

interface TrackedApplication {
  expectedRunning: boolean;
  attempts: number;
  state: RecoveryState;
  nextAttemptAt?: number;
  lastError?: string;
  releaseVersion?: string;
  lastExit?: DurableRuntimeRecord['lastExit'];
  stableSince?: number;
}

const DEFAULTS = {
  intervalMs: 1000,
  readinessTimeoutMs: 15000,
  readinessPollMs: 250,
  restartBaseDelayMs: 500,
  restartMaxDelayMs: 30000,
  stableResetMs: 60000,
};

/**
 * Observes managed processes and performs bounded recovery.
 * A disconnected ARM WebSocket or UNKNOWN readiness is not evidence of process death.
 */
export class ApplicationRuntimeMonitor extends EventEmitter {
  private readonly tracked = new Map<string, TrackedApplication>();
  private readonly busy = new Set<string>();
  private readonly recoveryPaused = new Set<string>();
  private readonly options: Required<RuntimeMonitoringOptions>;
  private interval?: NodeJS.Timeout;
  private closed = false;
  private readonly exits = new Map<string, DurableRuntimeRecord['lastExit']>();
  private readonly onExit = (event: { id: string; code: number | null; signal: NodeJS.Signals | null }) => {
    this.exits.set(event.id, {
      kind: event.signal ? 'SIGNALED' : event.code === null ? 'UNKNOWN' : 'EXITED',
      ...(event.code === null ? {} : { code: event.code }),
      ...(event.signal ? { signal: event.signal } : {}),
      observedAt: new Date().toISOString(),
    });
  };

  constructor(
    readonly lifecycle: ApplicationLifecycleManager,
    options: RuntimeMonitoringOptions = {},
    private readonly store?: RuntimeStateStore,
  ) {
    super();
    this.options = { ...DEFAULTS, ...options };
    this.lifecycle.processes?.on?.('exit', this.onExit);
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
      const state = this.track(view.applicationId);
      const saved = await this.store?.read(view.applicationId);
      if (saved && saved.releaseVersion === view.version) {
        state.expectedRunning = saved.desired === 'RUNNING';
        state.attempts = saved.attempts;
        state.state = saved.recoveryState;
        state.nextAttemptAt = saved.nextAttemptAt ? Date.parse(saved.nextAttemptAt) : undefined;
        state.lastError = saved.lastError;
        state.releaseVersion = saved.releaseVersion;
        state.lastExit = saved.lastExit;
        if (state.state === 'RECOVERING') {
          state.state = 'SCHEDULED';
          state.nextAttemptAt = Date.now() + this.options.restartBaseDelayMs;
          await this.persist(view.applicationId, state);
        }
      } else {
        state.expectedRunning = view.process.status === 'RUNNING';
        state.state = 'IDLE';
        state.releaseVersion = view.version;
        await this.persist(view.applicationId, state);
      }
    }
  }

  /** Prevent an automatic restart while a release transaction owns this app. */
  async pauseRecovery(applicationId: string): Promise<void> {
    this.recoveryPaused.add(applicationId);
    const deadline = Date.now() + 10000;
    while (this.busy.has(applicationId)) {
      if (Date.now() >= deadline) {
        this.recoveryPaused.delete(applicationId);
        throw new Error('Timed out waiting for recovery lock: ' + applicationId);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  }

  resumeRecovery(applicationId: string): void {
    this.recoveryPaused.delete(applicationId);
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
    this.lifecycle.processes?.off?.('exit', this.onExit);
    this.lifecycle.close();
  }

  async startApplication(applicationId: string): Promise<RuntimeMonitorStatus> {
    return this.withApplicationLock(applicationId, async () => {
      const state = this.track(applicationId);
      const view = await this.lifecycle.inspectApplication(applicationId);
      state.releaseVersion = view.version;
      state.expectedRunning = true;
      state.state = 'IDLE';
      state.attempts = 0;
      state.nextAttemptAt = undefined;
      state.lastError = undefined;
      state.lastExit = undefined;
      this.exits.delete(applicationId);
      await this.persist(applicationId, state);
      this.exits.delete(applicationId);
      const started = await this.lifecycle.startApplication(applicationId);
      await this.waitForReadiness(applicationId, started);
      return this.inspectApplication(applicationId);
    });
  }

  async stopApplication(applicationId: string): Promise<RuntimeMonitorStatus> {
    return this.withApplicationLock(applicationId, async () => {
      const state = this.track(applicationId);
      const view = await this.lifecycle.inspectApplication(applicationId);
      state.releaseVersion = view.version;
      state.expectedRunning = false;
      state.state = 'MANUALLY_STOPPED';
      state.nextAttemptAt = undefined;
      await this.persist(applicationId, state);
      await this.lifecycle.stopApplication(applicationId);
      return this.inspectApplication(applicationId);
    });
  }

  async restartApplication(applicationId: string): Promise<RuntimeMonitorStatus> {
    return this.withApplicationLock(applicationId, async () => {
      const state = this.track(applicationId);
      const view = await this.lifecycle.inspectApplication(applicationId);
      state.releaseVersion = view.version;
      state.expectedRunning = true;
      state.state = 'IDLE';
      state.attempts = 0;
      state.nextAttemptAt = undefined;
      state.lastError = undefined;
      state.lastExit = undefined;
      this.exits.delete(applicationId);
      await this.persist(applicationId, state);
      const started = await this.lifecycle.restartApplication(applicationId);
      await this.waitForReadiness(applicationId, started);
      return this.inspectApplication(applicationId);
    });
  }

  async activateRelease(applicationId: string, version: string): Promise<void> {
    await this.withApplicationLock(applicationId, async () => {
      await this.lifecycle.activateRelease(applicationId, version);
      const state = this.track(applicationId);
      state.releaseVersion = version;
      state.expectedRunning = false;
      state.state = 'MANUALLY_STOPPED';
      state.attempts = 0;
      state.nextAttemptAt = undefined;
      state.lastError = undefined;
      await this.persist(applicationId, state);
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
        desired: state.expectedRunning ? 'RUNNING' : 'STOPPED',
        ...(state.lastExit ? { lastExit: state.lastExit } : {}),
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
      if (this.busy.has(application.applicationId) || this.recoveryPaused.has(application.applicationId)) continue;
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
      if (!state.stableSince) state.stableSince = Date.now();
      if (state.attempts > 0 && Date.now() - state.stableSince >= this.options.stableResetMs) {
        state.attempts = 0;
        state.lastError = undefined;
        await this.persist(applicationId, state);
      }
      return;
    }
    state.stableSince = undefined;
    if (!state.lastExit) {
      state.lastExit = this.exits.get(applicationId) ?? {
        kind: 'UNKNOWN', observedAt: new Date().toISOString(),
      };
    } else if (this.exits.has(applicationId)) {
      state.lastExit = this.exits.get(applicationId);
    }
    if (view.process.status === 'UNKNOWN') return; // PID identity is unverified.
    const manifest = (await this.lifecycle.storage.readRelease(applicationId, view.version))?.manifest;
    if (!manifest) return;
    const policy = manifest.lifecycle;
    if (policy.restartPolicy === 'on-failure' &&
        state.lastExit?.kind === 'EXITED' && state.lastExit.code === 0) {
      state.expectedRunning = false;
      state.state = 'IDLE';
      state.nextAttemptAt = undefined;
      await this.persist(applicationId, state);
      this.emit('process.completed', { applicationId, exitCode: 0 });
      return;
    }
    if (policy.restartPolicy === 'never' || policy.maxRestarts === 0) {
      state.expectedRunning = false;
      state.state = 'EXHAUSTED';
      await this.persist(applicationId, state);
      this.emit('recovery.exhausted', { applicationId, reason: 'restart disabled' });
      return;
    }
    if (state.attempts >= policy.maxRestarts) {
      state.expectedRunning = false;
      state.state = 'EXHAUSTED';
      await this.persist(applicationId, state);
      this.emit('recovery.exhausted', { applicationId, attempts: state.attempts });
      return;
    }
    if (!state.nextAttemptAt) await this.scheduleRecovery(applicationId, state);
    if (Date.now() < state.nextAttemptAt!) return;
    await this.attemptRecovery(applicationId, state);
  }

  private async scheduleRecovery(applicationId: string, state: TrackedApplication): Promise<void> {
    const delay = Math.min(this.options.restartMaxDelayMs,
      this.options.restartBaseDelayMs * 2 ** Math.min(state.attempts, 30));
    state.nextAttemptAt = Date.now() + delay;
    state.state = 'SCHEDULED';
    await this.persist(applicationId, state);
    this.emit('recovery.scheduled', { applicationId, attempt: state.attempts + 1, delayMs: delay });
  }

  private async attemptRecovery(
    applicationId: string, state: TrackedApplication,
  ): Promise<void> {
    state.attempts++;
    state.state = 'RECOVERING';
    state.nextAttemptAt = undefined;
    await this.persist(applicationId, state);
    try {
      const started = await this.lifecycle.startApplication(applicationId);
      await this.waitForReadiness(applicationId, started);
      state.state = 'IDLE';
      state.lastError = undefined;
      state.lastExit = undefined;
      state.stableSince = Date.now();
      await this.persist(applicationId, state);
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
      await this.persist(applicationId, state);
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

  private async persist(applicationId: string, state: TrackedApplication): Promise<void> {
    if (!this.store) return;
    const releaseVersion = state.releaseVersion ??
      (await this.lifecycle.inspectApplication(applicationId)).version;
    state.releaseVersion = releaseVersion;
    await this.store.write({
      schemaVersion: 1,
      applicationId,
      releaseVersion,
      desired: state.expectedRunning ? 'RUNNING' : 'STOPPED',
      recoveryState: state.state,
      attempts: state.attempts,
      ...(state.nextAttemptAt ? { nextAttemptAt: new Date(state.nextAttemptAt).toISOString() } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(state.lastExit ? { lastExit: state.lastExit } : {}),
      updatedAt: new Date().toISOString(),
    });
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

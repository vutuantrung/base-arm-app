import { randomUUID } from 'node:crypto';
import type { RolloutRuntimePort, ReleaseOperationsPort } from './runtime-ports.js';

import { RolloutJournal, type RolloutOperation } from './rollout-journal.js';

export interface SafeRolloutOptions {
  stabilityWindowMs?: number;
  pollMs?: number;
}

export interface StartRolloutRequest {
  version: string;
  /** Allow a non-ARM package to pass by process identity alone. Defaults to false. */
  allowProcessOnly?: boolean;
}

/**
 * Durable, compensating release switch. This is a saga, not a filesystem
 * transaction: journal checkpoints precede side effects, and recovery
 * conservatively restores the previous release.
 */
export class SafeRolloutManager {
  readonly journal: RolloutJournal;
  private readonly locks = new Set<string>();
  private readonly stabilityWindowMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly monitor: RolloutRuntimePort,
    private readonly releases: ReleaseOperationsPort,
    storageRoot: string,
    options: SafeRolloutOptions = {},
  ) {
    this.journal = new RolloutJournal(storageRoot);
    this.stabilityWindowMs = options.stabilityWindowMs ?? 1500;
    this.pollMs = options.pollMs ?? 250;
    if (![this.stabilityWindowMs, this.pollMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Invalid rollout timing configuration');
    }
  }

  isBusy(applicationId: string): boolean {
    return this.locks.has(applicationId);
  }

  async getLatest(applicationId: string): Promise<RolloutOperation | undefined> {
    return this.journal.read(applicationId);
  }

  async rollout(applicationId: string, input: StartRolloutRequest): Promise<RolloutOperation> {
    return this.exclusive(applicationId, async () => {
      const operation = await this.prepare(applicationId, input);
      await this.monitor.pauseRecovery(applicationId);
      try {
        return await this.apply(operation);
      } finally {
        this.monitor.resumeRecovery(applicationId);
      }
    });
  }

  /**
   * Run before exposing the HTTP management API and before starting monitoring.
   * A partially completed operation is rolled back rather than committed by guesswork.
   */
  async recoverIncompleteRollouts(): Promise<RolloutOperation[]> {
    const pending = (await this.journal.list()).filter(item =>
      !this.isTerminal(item.phase) && item.phase !== 'NEEDS_ATTENTION');
    const results: RolloutOperation[] = [];
    for (const item of pending) {
      const result = await this.exclusive(item.applicationId, async () => {
        await this.monitor.pauseRecovery(item.applicationId);
        try {
          return await this.compensate(item, 'Supervisor restarted during rollout');
        } finally {
          this.monitor.resumeRecovery(item.applicationId);
        }
      });
      results.push(result);
    }
    return results;
  }

  private async prepare(applicationId: string, input: StartRolloutRequest): Promise<RolloutOperation> {
    const previous = await this.journal.read(applicationId);
    if (previous && !this.isTerminal(previous.phase)) {
      throw new Error('Unfinished rollout requires recovery first');
    }
    const status = await this.monitor.inspectApplication(applicationId);
    const current = status.application.version;
    if (current === input.version) throw new Error('Target release already active');
    const candidate = await this.releases.deployments.storage.readRelease(applicationId, input.version);
    if (!candidate) throw new Error('Installed target release not found');
    if (!candidate.manifest.arm.enabled && input.allowProcessOnly !== true) {
      throw new Error('ARM readiness required; set allowProcessOnly for test packages');
    }
    if (status.application.process.status === 'UNKNOWN') {
      throw new Error('Unverified PID: unsafe to switch release');
    }
    const now = new Date().toISOString();
    const operation: RolloutOperation = {
      schemaVersion: 1, operationId: randomUUID(), applicationId,
      fromVersion: current, toVersion: input.version,
      previousDesired: status.recovery.desired === 'RUNNING' ||
        status.application.process.status === 'RUNNING' ? 'RUNNING' : 'STOPPED',
      allowProcessOnly: input.allowProcessOnly === true,
      phase: 'PREPARED', createdAt: now, updatedAt: now,
    };
    await this.journal.write(operation);
    return operation;
  }

  private async apply(initial: RolloutOperation): Promise<RolloutOperation> {
    let operation = initial;
    try {
      operation = await this.journal.transition(operation, 'STOPPING_OLD');
      await this.stopIfRunning(operation.applicationId);
      operation = await this.journal.transition(operation, 'ACTIVATING_NEW');
      await this.releases.activateRelease(operation.applicationId, operation.toVersion);
      operation = await this.journal.transition(operation, 'STARTING_NEW');
      await this.monitor.startApplication(operation.applicationId);
      operation = await this.journal.transition(operation, 'VERIFYING');
      await this.verifyStable(operation);
      operation = await this.journal.transition(operation, 'SUCCEEDED');
      // The journal is authoritative. Audit failures must never roll back a healthy app.
      try {
        await this.releases.audit.append({
          action: 'ACTIVATE', outcome: 'SUCCEEDED', applicationId: operation.applicationId,
          previousVersion: operation.fromVersion, version: operation.toVersion,
        });
      } catch {
        // An incomplete audit can be reconstructed from the rollout journal.
      }
      return operation;
    } catch (error) {
      if (operation.phase === 'SUCCEEDED') throw error;
      return this.compensate(operation, this.describe(error));
    }
  }

  private async verifyStable(operation: RolloutOperation): Promise<void> {
    const deadline = Date.now() + this.stabilityWindowMs;
    while (true) {
      const { application } = await this.monitor.inspectApplication(operation.applicationId);
      if (application.version !== operation.toVersion || application.process.status !== 'RUNNING') {
        throw new Error('Target process exited during rollout verification');
      }
      if (application.readiness !== 'HEALTHY' &&
          !(operation.allowProcessOnly && application.readiness === 'NOT_CONFIGURED')) {
        throw new Error('Target release is not ready');
      }
      if (Date.now() >= deadline) return;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(this.pollMs, deadline - Date.now())));
    }
  }

  private async compensate(operation: RolloutOperation, message: string): Promise<RolloutOperation> {
    let current = await this.journal.transition(operation, 'ROLLING_BACK', message);
    try {
      const status = await this.monitor.inspectApplication(current.applicationId);
      const oldIsAlreadyRunning = status.application.version === current.fromVersion &&
        status.application.process.status === 'RUNNING' &&
        current.previousDesired === 'RUNNING';
      if (!oldIsAlreadyRunning) await this.stopIfRunning(current.applicationId);
      if (status.application.version !== current.fromVersion) {
        await this.releases.activateRelease(current.applicationId, current.fromVersion);
      }
      if (current.previousDesired === 'RUNNING' && !oldIsAlreadyRunning) {
        await this.monitor.startApplication(current.applicationId);
        const restored = await this.monitor.inspectApplication(current.applicationId);
        if (restored.application.process.status !== 'RUNNING') {
          throw new Error('Previous process failed to restart');
        }
      }
      current = await this.journal.transition(current, 'ROLLED_BACK');
      try {
        await this.releases.audit.append({
          action: 'ROLLBACK', outcome: 'SUCCEEDED', applicationId: current.applicationId,
          previousVersion: current.toVersion, version: current.fromVersion,
          reason: message,
        });
      } catch {
        // The terminal rollout journal retains the outcome.
      }
    } catch (error) {
      current = await this.journal.transition(current, 'NEEDS_ATTENTION',
        message + '; rollback error: ' + this.describe(error));
      try {
        await this.releases.audit.append({
          action: 'ROLLBACK', outcome: 'FAILED', applicationId: current.applicationId,
          version: current.fromVersion, reason: current.error,
        });
      } catch {
        // Preserve NEEDS_ATTENTION rather than masking original rollback failure.
      }
    }
    return current;
  }

  private async stopIfRunning(applicationId: string): Promise<void> {
    const status = await this.monitor.inspectApplication(applicationId);
    if (status.application.process.status === 'UNKNOWN') {
      throw new Error('Unverified PID: refusing unsafe process stop');
    }
    if (status.application.process.status === 'RUNNING') {
      await this.monitor.stopApplication(applicationId);
    }
  }

  private isTerminal(phase: RolloutOperation['phase']): boolean {
    return phase === 'SUCCEEDED' || phase === 'ROLLED_BACK';
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400);
  }

  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error('Invalid application ID');
    if (this.locks.has(id)) throw new Error('Rollout in progress: ' + id);
    this.locks.add(id);
    try { return await work(); }
    finally { this.locks.delete(id); }
  }
}

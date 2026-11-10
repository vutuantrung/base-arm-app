import { DeploymentManager } from './deployment/deployment-manager.js';
import type { DeploymentReceipt, InstalledRelease } from './deployment/deployment-types.js';
import { ApplicationRuntimeMonitor } from './application-runtime-monitor.js';
import { DeploymentAuditLog } from './deployment-audit-log.js';
import { ReleaseHistoryStore, type ReleaseTransition } from './release-history-store.js';

export interface ReleaseManagementOptions {
  storageRoot: string;
}

/**
 * Orchestrates deployments and release selection, without owning child processes.
 * Release activation is deliberately stop-before-switch, never an implicit restart.
 */
export class ApplicationReleaseManager {
  readonly deployments: DeploymentManager;
  readonly audit: DeploymentAuditLog;
  readonly history: ReleaseHistoryStore;
  private readonly activeOperations = new Set<string>();

  constructor(
    private readonly monitor: ApplicationRuntimeMonitor,
    options: ReleaseManagementOptions,
  ) {
    this.deployments = new DeploymentManager({ storageRoot: options.storageRoot });
    this.audit = new DeploymentAuditLog(options.storageRoot);
    this.history = new ReleaseHistoryStore(options.storageRoot);
  }

  async installZip(path: string): Promise<DeploymentReceipt> {
    try {
      const receipt = await this.deployments.installZip(path);
      await this.audit.append({
        action: 'INSTALL',
        outcome: 'SUCCEEDED',
        applicationId: receipt.release.applicationId,
        version: receipt.release.version,
      });
      return receipt;
    } catch (error) {
      await this.audit.append({
        action: 'INSTALL', outcome: 'FAILED', reason: this.describe(error),
      });
      throw error;
    }
  }

  async listReleases(applicationId: string): Promise<InstalledRelease[]> {
    this.assertValidId(applicationId);
    return this.deployments.storage.listReleases(applicationId);
  }

  async activateRelease(applicationId: string, version: string): Promise<ReleaseTransition | null> {
    return this.exclusive(applicationId, async () => {
      try {
        const fromVersion = await this.activeVersion(applicationId);
        if (fromVersion === version) return null;
        await this.monitor.activateRelease(applicationId, version);
        const transition = this.transition('ACTIVATE', fromVersion, version);
        await this.history.record(applicationId, transition);
        await this.audit.append({
          action: 'ACTIVATE', outcome: 'SUCCEEDED',
          applicationId, version, previousVersion: fromVersion,
        });
        return transition;
      } catch (error) {
        await this.audit.append({
          action: 'ACTIVATE', outcome: 'FAILED',
          applicationId, version, reason: this.describe(error),
        });
        throw error;
      }
    });
  }

  async rollbackRelease(applicationId: string): Promise<ReleaseTransition> {
    return this.exclusive(applicationId, async () => {
      let targetVersion: string | undefined;
      try {
        const currentVersion = await this.activeVersion(applicationId);
        if (!currentVersion) throw new Error('No active release for rollback');
        const history = await this.history.list(applicationId);
        const previous = [...history].reverse()
          .find(item => item.toVersion === currentVersion && item.fromVersion);
        targetVersion = previous?.fromVersion;
        if (!targetVersion) throw new Error('No previous release available for rollback');
        await this.monitor.activateRelease(applicationId, targetVersion);
        const transition = this.transition('ROLLBACK', currentVersion, targetVersion);
        await this.history.record(applicationId, transition);
        await this.audit.append({
          action: 'ROLLBACK', outcome: 'SUCCEEDED',
          applicationId, version: targetVersion, previousVersion: currentVersion,
        });
        return transition;
      } catch (error) {
        await this.audit.append({
          action: 'ROLLBACK', outcome: 'FAILED',
          applicationId, version: targetVersion, reason: this.describe(error),
        });
        throw error;
      }
    });
  }

  async listAudit(applicationId?: string, limit = 100) {
    if (applicationId) this.assertValidId(applicationId);
    return this.audit.list(applicationId, limit);
  }

  private async activeVersion(applicationId: string): Promise<string | undefined> {
    const apps = await this.monitor.lifecycle.listApplications();
    return apps.find(item => item.applicationId === applicationId)?.version;
  }

  private transition(
    action: ReleaseTransition['action'], fromVersion: string | undefined,
    toVersion: string,
  ): ReleaseTransition {
    return { action, ...(fromVersion ? { fromVersion } : {}),
      toVersion, changedAt: new Date().toISOString() };
  }

  private assertValidId(id: string): void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id)) {
      throw new Error('Invalid application ID');
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 250) : 'Unknown error';
  }

  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.assertValidId(id);
    if (this.activeOperations.has(id)) throw new Error(`Release operation in progress: ${id}`);
    this.activeOperations.add(id);
    try { return await action(); }
    finally { this.activeOperations.delete(id); }
  }
}

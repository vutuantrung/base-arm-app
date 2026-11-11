import type { InstalledRelease } from '../../package-manager/src/deployment-types.js';
import type { DeploymentAuditEntry } from './deployment-audit-log.js';

/** Domain ports: deployment code never imports a concrete runtime monitor. */
export interface ReleaseRuntimePort {
  activateRelease(applicationId: string, version: string): Promise<void>;
  lifecycle: {
    listApplications(): Promise<Array<{ applicationId: string; version: string }>>;
  };
}

export interface RolloutRuntimeStatus {
  application: {
    version: string;
    process: { status: 'RUNNING' | 'STOPPED' | 'UNKNOWN' };
    readiness: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN' | 'NOT_CONFIGURED';
  };
  recovery: { desired?: 'RUNNING' | 'STOPPED' };
}

export interface RolloutRuntimePort {
  pauseRecovery(applicationId: string): Promise<void>;
  resumeRecovery(applicationId: string): void;
  inspectApplication(applicationId: string): Promise<RolloutRuntimeStatus>;
  startApplication(applicationId: string): Promise<unknown>;
  stopApplication(applicationId: string): Promise<unknown>;
}

export interface ReleaseOperationsPort {
  deployments: {
    storage: {
      readRelease(applicationId: string, version: string):
        Promise<InstalledRelease | undefined>;
    };
  };
  audit: {
    append(entry: Omit<DeploymentAuditEntry, 'id' | 'timestamp'>): Promise<unknown>;
  };
  activateRelease(applicationId: string, version: string): Promise<unknown>;
}

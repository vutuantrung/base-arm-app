import type { ProcessView, ProcessManager } from '../../process-manager/src/index.js';
import type { ApplicationStorage } from '../../package-manager/src/index.js';

export interface RuntimeApplicationView {
  applicationId: string;
  version: string;
  process: ProcessView;
  readiness: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN' | 'NOT_CONFIGURED';
}

/** Monitoring depends on a lifecycle port, not a concrete application manager. */
export interface RuntimeLifecyclePort {
  readonly processes: Pick<ProcessManager, 'on' | 'off'>;
  readonly storage: Pick<ApplicationStorage, 'readRelease'>;
  listApplications(): Promise<RuntimeApplicationView[]>;
  inspectApplication(applicationId: string): Promise<RuntimeApplicationView>;
  startApplication(applicationId: string): Promise<RuntimeApplicationView>;
  stopApplication(applicationId: string): Promise<RuntimeApplicationView>;
  restartApplication(applicationId: string): Promise<RuntimeApplicationView>;
  activateRelease(applicationId: string, version: string): Promise<unknown>;
  close(): void;
}

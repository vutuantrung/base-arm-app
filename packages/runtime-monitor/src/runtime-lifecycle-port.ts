import type { ProcessView } from '../../process-manager/src/index.js';
import type { ApplicationStorage } from '../../package-manager/src/index.js';

export interface RuntimeApplicationView {
  applicationId: string;
  version: string;
  process: ProcessView;
  readiness: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN' | 'NOT_CONFIGURED';
}

/** Exit notification payload provided by the process owner. */
export interface ProcessExitNotification {
  id: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Minimal event subscription contract. Returning void intentionally avoids
 * tying the contract to EventEmitter's fluent concrete `this` type.
 */
export interface ProcessExitEventSource {
  on(event: 'exit', listener: (event: ProcessExitNotification) => void): void;
  off(event: 'exit', listener: (event: ProcessExitNotification) => void): void;
}

/** Monitoring depends on a lifecycle port, not a concrete application manager. */
export interface RuntimeLifecyclePort {
  readonly processes: ProcessExitEventSource;
  readonly storage: Pick<ApplicationStorage, 'readRelease'>;
  listApplications(): Promise<RuntimeApplicationView[]>;
  inspectApplication(applicationId: string): Promise<RuntimeApplicationView>;
  startApplication(applicationId: string): Promise<RuntimeApplicationView>;
  stopApplication(applicationId: string): Promise<RuntimeApplicationView>;
  restartApplication(applicationId: string): Promise<RuntimeApplicationView>;
  activateRelease(applicationId: string, version: string): Promise<unknown>;
  close(): void;
}

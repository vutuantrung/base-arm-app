import type { ProcessView } from '../../process-manager/src/index.js';

export interface EndpointRuntimeReader {
  listApplications(): Promise<Array<{
    application: { applicationId: string; process: ProcessView };
  }>>;
}

export interface BlueGreenEndpointReader {
  inspect(): {
    state: { applicationId: string; active?: 'blue' | 'green' };
    proxy: { slot: 'blue' | 'green'; port: number } | undefined;
    blue: ProcessView | undefined;
    green: ProcessView | undefined;
  };
  publicPort(): number;
}

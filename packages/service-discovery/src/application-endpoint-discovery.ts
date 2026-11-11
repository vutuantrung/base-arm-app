import type { EndpointRuntimeReader, BlueGreenEndpointReader } from './endpoint-reader-ports.js';

export interface DiscoveredEndpoint {
  applicationId: string;
  instanceId: string;
  url: string;
  host: '127.0.0.1';
  port: number;
  mode: 'singleton' | 'blue-green';
  reachable: true;
}

/** Reports only verified live processes with reachable local HTTP endpoints. */
export class ApplicationEndpointDiscovery {
  constructor(
    private readonly monitor: EndpointRuntimeReader,
    private readonly blueGreen?: BlueGreenEndpointReader,
  ) {}

  async list(): Promise<DiscoveredEndpoint[]> {
    const applications = await this.monitor.listApplications();
    const result: DiscoveredEndpoint[] = [];
    const bg = this.blueGreen?.inspect();
    for (const app of applications) {
      const id = app.application.applicationId;
      if (bg && bg.state.applicationId === id && bg.proxy) continue;
      const process = app.application.process;
      if (process.status !== 'RUNNING' || !process.port) continue;
      if (!await this.reachable(process.port)) continue;
      result.push(this.create(id, id + '-managed', process.port, 'singleton'));
    }

    if (bg?.proxy && bg.state.active) {
      const active = bg.state.active;
      const view = active === 'blue' ? bg.blue : bg.green;
      if (view?.status === 'RUNNING' && view.port &&
          await this.reachable(view.port) &&
          await this.reachable(this.blueGreen!.publicPort())) {
        result.push(this.create(bg.state.applicationId,
          `${bg.state.applicationId}-${active}`,
          this.blueGreen!.publicPort(), 'blue-green'));
      }
    }
    return result;
  }

  async find(applicationId: string): Promise<DiscoveredEndpoint | undefined> {
    return (await this.list()).find(item => item.applicationId === applicationId);
  }

  private create(
    applicationId: string, instanceId: string,
    port: number, mode: DiscoveredEndpoint['mode'],
  ): DiscoveredEndpoint {
    return {
      applicationId, instanceId, host: '127.0.0.1', port,
      url: `http://127.0.0.1:${port}`, mode, reachable: true,
    };
  }

  private async reachable(port: number): Promise<boolean> {
    try {
      // A valid HTTP response, even 404, proves an HTTP server accepted the
      // connection; it does not establish business readiness.
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(400),
      });
      await response.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }
}

import type { EndpointDirectory, HttpEndpoint } from '../../contracts/src/index.js';
import { ApplicationEndpointDiscovery } from './application-endpoint-discovery.js';

/** Maps live HTTP discovery to the public R1 directory contract. */
export class EndpointDirectoryAdapter implements EndpointDirectory {
  constructor(private readonly discovery: ApplicationEndpointDiscovery) {}

  async find(applicationId: string): Promise<HttpEndpoint | undefined> {
    const endpoint = await this.discovery.find(applicationId);
    return endpoint ? this.project(endpoint) : undefined;
  }

  async list(): Promise<readonly HttpEndpoint[]> {
    return (await this.discovery.list()).map(endpoint => this.project(endpoint));
  }

  private project(endpoint: {
    applicationId: string; instanceId: string; url: string;
    host: string; port: number; mode: 'singleton' | 'blue-green';
  }): HttpEndpoint {
    return {
      applicationId: endpoint.applicationId,
      instanceId: endpoint.instanceId,
      url: endpoint.url,
      host: endpoint.host,
      port: endpoint.port,
      mode: endpoint.mode,
    };
  }
}

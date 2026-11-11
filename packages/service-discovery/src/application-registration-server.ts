import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ApplicationRegistry, ApplicationRegistration, ApplicationDiscoveryStatus, DiscoveryQuery } from './application-registry.js';
import type { RemoteArmMetricsCollector } from './remote-arm-metrics-collector.js';

export interface RegistrationServerOptions {
  token: string;
  host?: string;
  port?: number;
}

const DISCOVERY_STATUSES = new Set<ApplicationDiscoveryStatus>([
  'REGISTERED', 'CONNECTED', 'STALE', 'DISCONNECTED', 'EXPIRED',
]);

type UnregisterRequest = Pick<ApplicationRegistration, 'applicationId' | 'instanceId'>;

function hasStringField(value: unknown, field: string): boolean {
  return typeof value === 'object' && value !== null &&
    typeof (value as Record<string, unknown>)[field] === 'string';
}

function isRegistrationRequest(value: unknown): value is ApplicationRegistration {
  return hasStringField(value, 'applicationId') &&
    hasStringField(value, 'instanceId') &&
    hasStringField(value, 'metricsUrl');
}

function isUnregisterRequest(value: unknown): value is UnregisterRequest {
  return hasStringField(value, 'applicationId') &&
    hasStringField(value, 'instanceId');
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 8192) throw new Error('Body too large');
  }
  return JSON.parse(raw);
}

/** Authenticated registration and discovery API; binds loopback by default. */
export class ApplicationRegistrationServer {
  readonly http: Server;
  private readonly host: string;
  private readonly port: number;

  constructor(
    private readonly registry: ApplicationRegistry,
    private readonly collector: RemoteArmMetricsCollector,
    private readonly options: RegistrationServerOptions,
  ) {
    if (!options.token) throw new Error('Registration token must not be empty');
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 3200;
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch(error => this.handleRequestError(res, error));
    });
  }

  private handleRequestError(res: ServerResponse, error: unknown): void {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req.headers.authorization, this.options.token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/applications/register' && req.method === 'POST') {
      await this.handleRegistration(req, res);
      return;
    }
    if (pathname === '/applications' && req.method === 'GET') {
      this.handleListApplications(url, res);
      return;
    }
    if (pathname === '/applications/transitions' && req.method === 'GET') {
      sendJson(res, 200, { transitions: this.registry.recentTransitions() });
      return;
    }
    if (req.method === 'GET' && pathname.startsWith('/applications/')) {
      this.handleApplicationDetail(pathname, res);
      return;
    }
    if (pathname === '/applications/unregister' && req.method === 'POST') {
      await this.handleUnregister(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  private async handleRegistration(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const value = await readJsonBody(req);
    if (!isRegistrationRequest(value)) {
      sendJson(res, 400, { error: 'Invalid registration request' });
      return;
    }

    const registration = this.registry.register({
      applicationId: value.applicationId,
      instanceId: value.instanceId,
      metricsUrl: value.metricsUrl,
    });
    sendJson(res, 200, { registration });
  }

  private parseDiscoveryQuery(url: URL): DiscoveryQuery {
    const rawStatus = url.searchParams.get('status');
    if (rawStatus && !DISCOVERY_STATUSES.has(rawStatus as ApplicationDiscoveryStatus)) {
      throw new Error('Invalid discovery status');
    }
    const includeExpired = url.searchParams.get('includeExpired');
    if (includeExpired !== null && includeExpired !== 'true' && includeExpired !== 'false') {
      throw new Error('Invalid includeExpired flag');
    }
    const applicationId = url.searchParams.get('applicationId') ?? undefined;
    return {
      ...(rawStatus ? { status: rawStatus as ApplicationDiscoveryStatus } : {}),
      ...(applicationId ? { applicationId } : {}),
      includeExpired: includeExpired === 'true' || rawStatus === 'EXPIRED',
    };
  }

  private handleListApplications(url: URL, res: ServerResponse): void {
    const query = this.parseDiscoveryQuery(url);
    const applications = this.registry.list(query).map(app => ({
      ...app,
      monitoring: this.collector.get(app.id) ?? null,
      fresh: this.collector.isFresh(app.id),
    }));
    sendJson(res, 200, { applications });
  }

  private handleApplicationDetail(pathname: string, res: ServerResponse): void {
    const match = /^\/applications\/([^/]+)\/instances\/([^/]+)$/.exec(pathname);
    if (!match) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const id = `${match[1]}/${match[2]}`;
    const application = this.registry.get(id);
    if (!application) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    sendJson(res, 200, {
      application,
      monitoring: this.collector.get(id) ?? null,
      fresh: this.collector.isFresh(id),
    });
  }

  private async handleUnregister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const value = await readJsonBody(req);
    if (!isUnregisterRequest(value)) {
      sendJson(res, 400, { error: 'Invalid unregister request' });
      return;
    }

    const id = `${value.applicationId}/${value.instanceId}`;
    sendJson(res, this.registry.unregister(id) ? 200 : 404, { id });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.http.close(error => error ? reject(error) : resolve()));
  }
}

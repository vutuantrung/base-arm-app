import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ApplicationRegistry, ApplicationRegistration } from './application-registry.js';
import type { RemoteArmMetricsCollector } from './remote-arm-metrics-collector.js';

export interface RegistrationServerOptions {
  token: string;
  host?: string;
  port?: number;
}

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

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/applications/register' && req.method === 'POST') {
      await this.handleRegistration(req, res);
      return;
    }
    if (pathname === '/applications' && req.method === 'GET') {
      this.handleListApplications(res);
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

  private handleListApplications(res: ServerResponse): void {
    const applications = this.registry.list().map(app => ({
      ...app,
      monitoring: this.collector.get(app.id) ?? null,
      fresh: this.collector.isFresh(app.id),
    }));
    sendJson(res, 200, { applications });
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

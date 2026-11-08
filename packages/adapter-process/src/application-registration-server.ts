import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ApplicationRegistry, ApplicationRegistration } from './application-registry.js';
import type { RemoteArmMetricsCollector } from './remote-arm-metrics-collector.js';

export interface RegistrationServerOptions {
  token: string;
  host?: string;
  port?: number;
}

function authorized(provided: string | undefined, expected: string): boolean {
  if (!provided?.startsWith('Bearer ')) return false;
  const a = Buffer.from(provided.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 8192) throw new Error('Body too large');
  }
  return JSON.parse(text);
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
      void this.handle(req, res).catch(error => send(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req.headers.authorization, this.options.token)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/applications/register' && req.method === 'POST') {
      const value = await body(req) as Partial<ApplicationRegistration> | null;
      if (!value || typeof value !== 'object' ||
          typeof value.applicationId !== 'string' ||
          typeof value.instanceId !== 'string' ||
          typeof value.metricsUrl !== 'string') {
        send(res, 400, { error: 'Invalid registration request' });
        return;
      }
      const record = this.registry.register({
        applicationId: value.applicationId,
        instanceId: value.instanceId,
        metricsUrl: value.metricsUrl,
      });
      send(res, 200, { registration: record });
      return;
    }

    if (pathname === '/applications' && req.method === 'GET') {
      send(res, 200, {
        applications: this.registry.list().map(app => ({
          ...app,
          monitoring: this.collector.get(app.id) ?? null,
          fresh: this.collector.isFresh(app.id),
        })),
      });
      return;
    }

    if (pathname === '/applications/unregister' && req.method === 'POST') {
      const value = await body(req) as { applicationId?: string; instanceId?: string } | null;
      if (!value || typeof value.applicationId !== 'string' || typeof value.instanceId !== 'string') {
        send(res, 400, { error: 'Invalid unregister request' });
        return;
      }
      const id = `${value.applicationId}/${value.instanceId}`;
      send(res, this.registry.unregister(id) ? 200 : 404, { id });
      return;
    }
    send(res, 404, { error: 'not_found' });
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApplicationRuntimeMonitor } from './application-runtime-monitor.js';

export interface ApplicationManagementApiOptions {
  host?: string;
  port?: number;
  bearerToken: string;
  maxBodyBytes?: number;
}

/** Loopback-only administrative API with explicit bearer authentication. */
export class ApplicationManagementApi {
  readonly http: Server;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBodyBytes: number;

  constructor(
    private readonly monitor: ApplicationRuntimeMonitor,
    private readonly options: ApplicationManagementApiOptions,
  ) {
    if (!options.bearerToken || options.bearerToken.length < 16) {
      throw new Error('Management API requires a bearer token of at least 16 characters');
    }
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 3300;
    this.maxBodyBytes = options.maxBodyBytes ?? 4096;
    if (!['127.0.0.1', '::1'].includes(this.host)) {
      throw new Error('Management API must bind to loopback');
    }
    this.http = createServer((req, res) => { void this.handleRequest(req, res); });
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
    await new Promise<void>((resolve, reject) => {
      this.http.close(error => error ? reject(error) : resolve());
    });
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const candidate = req.headers.authorization ?? '';
    const expected = `Bearer ${this.options.bearerToken}`;
    const actualBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.respond(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/applications' && req.method === 'GET') {
        this.respond(res, 200, await this.monitor.listApplications());
        return;
      }
      const match = /^\/applications\/([A-Za-z][A-Za-z0-9_.-]{0,63})(?:\/(activate|start|stop|restart))?$/.exec(pathname);
      if (!match) {
        this.respond(res, 404, { error: 'not_found' });
        return;
      }
      const [, id, action] = match;
      if (!action && req.method === 'GET') {
        this.respond(res, 200, await this.monitor.inspectApplication(id));
        return;
      }
      if (!action || req.method !== 'POST') {
        this.respond(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const body = await this.readJsonBody(req);
      this.respond(res, 200, await this.executeAction(id, action, body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const invalid = /invalid|missing|body|version|required/i.test(message);
      const conflict = /in progress|running|pending|already/i.test(message);
      const notFound = /not found|No active release|Unknown process/i.test(message);
      this.respond(res, invalid ? 400 : conflict ? 409 : notFound ? 404 : 500,
        { error: invalid ? 'bad_request' : conflict ? 'conflict' : notFound ? 'not_found' : 'internal_error',
          message: invalid || conflict || notFound ? message : undefined });
    }
  }

  private async executeAction(
    id: string, action: string, body: Record<string, unknown>,
  ): Promise<unknown> {
    switch (action) {
      case 'activate':
        if (typeof body.version !== 'string') throw new Error('version is required');
        await this.monitor.activateRelease(id, body.version);
        return this.monitor.inspectApplication(id);
      case 'start': return this.monitor.startApplication(id);
      case 'stop': return this.monitor.stopApplication(id);
      case 'restart': return this.monitor.restartApplication(id);
      default: throw new Error('Invalid action');
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const data = Buffer.from(chunk as Uint8Array);
      size += data.length;
      if (size > this.maxBodyBytes) throw new Error('Request body too large');
      chunks.push(data);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('Invalid JSON body'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid JSON body');
    }
    return parsed as Record<string, unknown>;
  }

  private respond(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { ApplicationReleaseManager } from '../../deployment-manager/src/index.js';
import type { SafeRolloutManager } from '../../deployment-manager/src/index.js';
import type { BlueGreenDeploymentManager } from './blue-green-deployment-manager.js';
import type { ArmTelemetryReader } from './arm-telemetry-reader.js';
import type { ApplicationRegistry } from './application-registry.js';
import type { RemoteArmMetricsCollector } from './remote-arm-metrics-collector.js';
import { ApplicationRuntimeMonitor } from './application-runtime-monitor.js';
import type { ApplicationEndpointDiscovery } from './application-endpoint-discovery.js';

export interface ApplicationManagementApiOptions {
  host?: string;
  port?: number;
  bearerToken: string;
  maxBodyBytes?: number;
  maxUploadBytes?: number;
  releaseManager?: ApplicationReleaseManager;
  rolloutManager?: SafeRolloutManager;
  blueGreenManager?: BlueGreenDeploymentManager;
  telemetryReader?: ArmTelemetryReader;
  registrationRegistry?: ApplicationRegistry;
  registrationCollector?: RemoteArmMetricsCollector;
  endpointDiscovery?: ApplicationEndpointDiscovery;
  discoveryToken?: string;
}

/** Loopback-only administrative API with explicit bearer authentication. */
export class ApplicationManagementApi {
  readonly http: Server;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBodyBytes: number;
  private readonly maxUploadBytes: number;

  constructor(
    private readonly monitor: ApplicationRuntimeMonitor,
    private readonly options: ApplicationManagementApiOptions,
  ) {
    if (!options.bearerToken || options.bearerToken.length < 16) {
      throw new Error('Management API requires a bearer token of at least 16 characters');
    }
    if (options.discoveryToken && options.discoveryToken.length < 16) {
      throw new Error('Discovery API requires a token of at least 16 characters');
    }
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 3300;
    this.maxBodyBytes = options.maxBodyBytes ?? 4096;
    this.maxUploadBytes = options.maxUploadBytes ?? 50 * 1024 * 1024;
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

  private isAuthorized(req: IncomingMessage, token = this.options.bearerToken): boolean {
    const candidate = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    const actualBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const discovery = /^\/runtime\/endpoints(?:\/([A-Za-z][A-Za-z0-9_.-]{0,63}))?$/.exec(pathname);
    if (discovery && req.method === 'GET') {
      if (!this.isAuthorized(req) &&
        (!this.options.discoveryToken ||
          !this.isAuthorized(req, this.options.discoveryToken))) {
        this.respond(res, 401, { error: 'unauthorized' });
        return;
      }
      if (!this.options.endpointDiscovery) {
        this.respond(res, 404, { error: 'discovery_disabled' });
        return;
      }
      try {
        const item = discovery[1]
          ? await this.options.endpointDiscovery.find(discovery[1])
          : await this.options.endpointDiscovery.list();
        this.respond(res, item === undefined ? 404 : 200, item ?? { error: 'not_found' });
      } catch {
        this.respond(res, 500, { error: 'internal_error' });
      }
      return;
    }
    if (!this.isAuthorized(req)) {
      this.respond(res, 401, { error: 'unauthorized' });
      return;
    }
    try {
      if (pathname === '/deployments/upload' && req.method === 'POST') {
        if (!this.options.releaseManager) throw new Error('Deployment API unavailable');
        this.respond(res, 201, await this.handleZipUpload(req));
        return;
      }
      if (pathname === '/deployments/audit' && req.method === 'GET') {
        if (!this.options.releaseManager) throw new Error('Deployment API unavailable');
        this.respond(res, 200, await this.options.releaseManager.listAudit());
        return;
      }
      const releasesMatch = /^\/applications\/([A-Za-z][A-Za-z0-9_.-]{0,63})\/(releases|audit)$/.exec(pathname);
      if (releasesMatch && req.method === 'GET') {
        if (!this.options.releaseManager) throw new Error('Deployment API unavailable');
        const [, applicationId, resource] = releasesMatch;
        this.respond(res, 200, resource === 'releases'
          ? await this.options.releaseManager.listReleases(applicationId)
          : await this.options.releaseManager.listAudit(applicationId));
        return;
      }
      const rolloutMatch = /^\/applications\/([A-Za-z][A-Za-z0-9_.-]{0,63})\/rollout$/.exec(pathname);
      if (rolloutMatch) {
        if (!this.options.rolloutManager) throw new Error('Rollout API unavailable');
        const applicationId = rolloutMatch[1];
        if (req.method === 'GET') {
          const operation = await this.options.rolloutManager.getLatest(applicationId);
          this.respond(res, operation ? 200 : 404, operation ?? { error: 'not_found' });
          return;
        }
        if (req.method === 'POST') {
          const body = await this.readJsonBody(req);
          if (typeof body.version !== 'string' ||
              (body.allowProcessOnly !== undefined && typeof body.allowProcessOnly !== 'boolean')) {
            throw new Error('Invalid rollout request: version required, allowProcessOnly must be boolean');
          }
          const outcome = await this.options.rolloutManager.rollout(applicationId, {
            version: body.version, allowProcessOnly: body.allowProcessOnly === true,
          });
          this.respond(res, outcome.phase === 'SUCCEEDED' ? 200 :
            outcome.phase === 'ROLLED_BACK' ? 409 : 500, outcome);
          return;
        }
        this.respond(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const bg = this.options.blueGreenManager;
      if (pathname === '/blue-green' && req.method === 'GET') {
        if (!bg) throw new Error('Blue/Green deployment is not configured');
        this.respond(res, 200, bg.inspect());
        return;
      }
      if (pathname === '/blue-green/deploy' && req.method === 'POST') {
        if (!bg) throw new Error('Blue/Green deployment is not configured');
        const body = await this.readJsonBody(req);
        if (typeof body.version !== 'string') throw new Error('Invalid release version');
        this.respond(res, 200, await bg.deploy(body.version));
        return;
      }
      if (pathname === '/runtime/bridge/applications' && req.method === 'GET') {
        const registry = this.options.registrationRegistry;
        const collector = this.options.registrationCollector;
        if (!registry || !collector) {
          this.respond(res, 404, { error: 'bridge_disabled' });
          return;
        }
        this.respond(res, 200, registry.list().map(app => ({
          ...app,
          monitoring: collector.get(app.id) ?? null,
          fresh: collector.isFresh(app.id),
        })));
        return;
      }
      const telemetryMatch = /^\/runtime\/instances\/([A-Za-z][A-Za-z0-9_.-]{0,63})\/telemetry$/.exec(pathname);
      if (telemetryMatch && req.method === 'GET') {
        if (!this.options.telemetryReader) {
          this.respond(res, 404, { error: 'telemetry_disabled' });
          return;
        }
        const snapshot = await this.options.telemetryReader.read(telemetryMatch[1]);
        this.respond(res, snapshot ? 200 : 404, snapshot ?? { error: 'not_found' });
        return;
      }
      if (pathname === '/applications' && req.method === 'GET') {
        this.respond(res, 200, await this.monitor.listApplications());
        return;
      }
      const match = /^\/applications\/([A-Za-z][A-Za-z0-9_.-]{0,63})(?:\/(activate|rollback|start|stop|restart))?$/.exec(pathname);
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
      if (this.options.rolloutManager?.isBusy(id)) {
        this.respond(res, 409, { error: 'rollout_in_progress' });
        return;
      }
      const body = await this.readJsonBody(req);
      this.respond(res, 200, await this.executeAction(id, action, body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const tooLarge = /too large|size limit/i.test(message);
      const invalid = /invalid|missing|body|version|required|not a zip|unsupported zip/i.test(message);
      const conflict = /in progress|running|pending|already|cannot replace/i.test(message);
      const notFound = /not found|No active release|Unknown process/i.test(message);
      this.respond(res, tooLarge ? 413 : invalid ? 400 : conflict ? 409 : notFound ? 404 : 500,
        { error: tooLarge ? 'payload_too_large' : invalid ? 'bad_request' : conflict ? 'conflict' : notFound ? 'not_found' : 'internal_error',
          message: tooLarge || invalid || conflict || notFound ? message : undefined });
    }
  }

  private async executeAction(
    id: string, action: string, body: Record<string, unknown>,
  ): Promise<unknown> {
    switch (action) {
      case 'activate':
        if (typeof body.version !== 'string') throw new Error('version is required');
        if (this.options.releaseManager) {
          await this.options.releaseManager.activateRelease(id, body.version);
        } else {
          await this.monitor.activateRelease(id, body.version);
        }
        return this.monitor.inspectApplication(id);
      case 'rollback':
        if (!this.options.releaseManager) throw new Error('Deployment API unavailable');
        await this.options.releaseManager.rollbackRelease(id);
        return this.monitor.inspectApplication(id);
      case 'start': return this.monitor.startApplication(id);
      case 'stop': return this.monitor.stopApplication(id);
      case 'restart': return this.monitor.restartApplication(id);
      default: throw new Error('Invalid action');
    }
  }

  private async handleZipUpload(req: IncomingMessage): Promise<unknown> {
    const releases = this.options.releaseManager;
    if (!releases) throw new Error('Deployment API unavailable');
    if (req.headers['content-type'] !== 'application/zip') {
      throw new Error('Invalid content-type: application/zip required');
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > this.maxUploadBytes) throw new Error('Upload too large');
    const { mkdir } = await import('node:fs/promises');
    const directory = join(releases.deployments.storage.root, 'uploads');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(directory, 'incoming-'));
    const archive = join(temporary, 'package.zip');
    let received = 0;
    const maxUploadBytes = this.maxUploadBytes;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxUploadBytes) callback(new Error('Upload too large'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
      return await releases.installZip(archive);
    } finally {
      await rm(temporary, { recursive: true, force: true });
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

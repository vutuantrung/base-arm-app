import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProcessManager, type ProcessView } from './process-manager.js';
import { ArmRuntimeInjector } from './arm-runtime-injector.js';
import { ApplicationStorage } from './deployment/application-storage.js';
import { BlueGreenHttpProxy, type ProxyTarget } from './blue-green-http-proxy.js';

type Slot = 'blue' | 'green';
interface SlotRecord { version: string; port: number }
export interface BlueGreenState {
  schemaVersion: 1;
  applicationId: string;
  active?: Slot;
  blue?: SlotRecord;
  green?: SlotRecord;
  updatedAt: string;
}

export interface BlueGreenOptions {
  storageRoot: string;
  applicationId: string;
  proxyPort: number;
  bluePort: number;
  greenPort: number;
  healthPath?: string;
  healthTimeoutMs?: number;
  drainTimeoutMs?: number;
  injector?: ArmRuntimeInjector;
}

const APP_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,55}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Separate process IDs and ports keep both releases live simultaneously.
 * Never operates on the legacy singleton process ID for this application.
 */
export class BlueGreenDeploymentManager {
  readonly processes: ProcessManager;
  readonly storage: ApplicationStorage;
  readonly proxy: BlueGreenHttpProxy;
  private state: BlueGreenState;
  private readonly ports: Record<Slot, number>;
  private deploying = false;
  private initialized = false;
  private readonly healthPath: string;
  private readonly healthTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly filename: string;

  constructor(private readonly options: BlueGreenOptions) {
    if (!APP_ID.test(options.applicationId)) throw new Error('Invalid application ID');
    if (new Set([options.proxyPort, options.bluePort, options.greenPort]).size !== 3) {
      throw new Error('Proxy and slot ports must be different');
    }
    for (const port of [options.proxyPort, options.bluePort, options.greenPort]) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid deployment port');
    }
    this.ports = { blue: options.bluePort, green: options.greenPort };
    this.storage = new ApplicationStorage(options.storageRoot);
    this.processes = new ProcessManager(join(this.storage.root, 'state', 'blue-green-processes.json'), options.injector);
    this.proxy = new BlueGreenHttpProxy(options.proxyPort);
    this.filename = join(this.storage.root, 'applications', options.applicationId, 'blue-green.json');
    this.healthPath = options.healthPath ?? '/health';
    if (!this.healthPath.startsWith('/') || this.healthPath.startsWith('//')) {
      throw new Error('Health path must be a local path');
    }
    this.healthTimeoutMs = options.healthTimeoutMs ?? 8000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 10000;
    this.state = {
      schemaVersion: 1, applicationId: options.applicationId,
      updatedAt: new Date().toISOString(),
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) throw new Error('BlueGreenDeploymentManager already initialized');
    const saved = await this.loadState();
    if (saved) this.state = saved;
    const specs = await Promise.all(
      (['blue', 'green'] as Slot[]).filter(slot => this.state[slot])
        .map(async slot => this.buildSpec(slot, this.state[slot]!.version)),
    );
    await this.processes.initialize(specs);
    // Never route traffic to an unavailable / unverified target after restart.
    if (this.state.active) {
      const current = await this.processes.inspect(this.processId(this.state.active));
      if (current.status === 'RUNNING' &&
          await this.isHealthy(this.ports[this.state.active])) {
        this.proxy.switchTo({ slot: this.state.active, port: this.ports[this.state.active] });
      }
    }
    await this.proxy.listen();
    this.initialized = true;
  }

  async deploy(version: string): Promise<BlueGreenState> {
    this.assertInitialized();
    if (this.deploying) throw new Error('Blue/Green deployment in progress');
    if (!VERSION.test(version)) throw new Error('Invalid release version');
    const existing = this.getActive();
    if (existing?.version === version) throw new Error('Target release already serving traffic');
    const candidate = await this.storage.readRelease(this.options.applicationId, version);
    if (!candidate) throw new Error('Installed target release not found');
    // Phase 7 refuses the older singleton process: migrating a direct-port
    // legacy deployment is an explicit one-time maintenance operation.
    this.deploying = true;
    const target: Slot = this.state.active === 'blue' ? 'green' : 'blue';
    let switched = false;
    try {
      await this.prepareSlot(target, version);
      await this.awaitHealthy(target);
      const previous = this.state.active;
      // The proxy switch is immediate for NEW requests. Existing requests
      // retain the backend they selected when they entered the proxy.
      this.proxy.switchTo({ slot: target, port: this.ports[target] });
      switched = true;
      this.state.active = target;
      await this.persist();
      if (previous) {
        const drained = await this.proxy.drain(previous, this.drainTimeoutMs);
        if (!drained) {
          // Never kill a backend that still has in-flight traffic.
          // It remains available until an operator retries cleanup.
          return this.snapshot();
        }
        await this.processes.stop(this.processId(previous));
      }
      return this.snapshot();
    } catch (error) {
      if (switched) {
        if (!existing) throw error;
        const oldSlot = existing.slot;
        const verified = await this.processes.inspect(this.processId(oldSlot));
        if (verified.status === 'RUNNING' && await this.isHealthy(this.ports[oldSlot])) {
          this.proxy.switchTo({ slot: oldSlot, port: this.ports[oldSlot] });
          this.state.active = oldSlot;
          await this.persist();
        } else {
          throw new Error('Deployment failed after traffic switch; manual recovery required: ' +
            (error instanceof Error ? error.message : String(error)));
        }
      }
      // Stop only the candidate that never became the active target.
      if (this.state.active !== target) {
        await this.processes.stop(this.processId(target)).catch(() => {});
      }
      throw error;
    } finally {
      this.deploying = false;
    }
  }

  inspect(): { state: BlueGreenState; proxy: ProxyTarget | undefined; blue: ProcessView | undefined; green: ProcessView | undefined } {
    this.assertInitialized();
    return {
      state: this.snapshot(),
      proxy: this.proxy.current(),
      blue: this.processes.list().find(item => item.id === this.processId('blue')),
      green: this.processes.list().find(item => item.id === this.processId('green')),
    };
  }

  async close(): Promise<void> {
    await this.proxy.close();
    this.processes.close(); // Detached child processes deliberately survive.
  }

  private async prepareSlot(slot: Slot, version: string): Promise<void> {
    const id = this.processId(slot);
    if (this.state[slot]) {
      const current = await this.processes.inspect(id);
      if (current.status === 'UNKNOWN') throw new Error('Unverified PID on candidate slot');
      if (current.status === 'RUNNING') {
        if (this.proxy.current()?.slot === slot) {
          throw new Error('Cannot replace the live traffic target');
        }
        await this.processes.stop(id);
      }
    }
    await this.processes.registerSpec(await this.buildSpec(slot, version));
    this.state[slot] = { version, port: this.ports[slot] };
    await this.persist();
    await this.processes.start(id);
  }

  private async buildSpec(slot: Slot, version: string) {
    const release = await this.storage.readRelease(this.options.applicationId, version);
    if (!release) throw new Error('Installed release not found: ' + version);
    if (release.manifest.arm.enabled &&
      this.options.injector?.bridgeEnabledFor(this.options.applicationId)) {
      throw new Error('ARM Client Bridge cannot replace an app with embedded ARM SDK');
    }
    return {
      id: this.processId(slot),
      entry: release.entry,
      cwd: release.directory,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(this.ports[slot]),
        ARM_APPLICATION_ID: this.options.applicationId,
        ARM_INSTANCE_ID: `${this.options.applicationId}-${slot}`,
      },
    };
  }

  private async awaitHealthy(slot: Slot): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      const process = await this.processes.inspect(this.processId(slot));
      if (process.status !== 'RUNNING') throw new Error('Candidate exited before readiness');
      if (await this.isHealthy(this.ports[slot])) return;
      await delay(100);
    }
    throw new Error('Candidate health probe timed out');
  }

  private async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${this.healthPath}`, {
        signal: AbortSignal.timeout(500),
      });
      return response.status === 200;
    } catch { return false; }
  }

  private getActive(): { slot: Slot; version: string } | undefined {
    const slot = this.state.active;
    if (!slot) return undefined;
    const record = this.state[slot];
    return record ? { slot, version: record.version } : undefined;
  }

  private processId(slot: Slot): string { return `${this.options.applicationId}-${slot}`; }

  private snapshot(): BlueGreenState {
    return JSON.parse(JSON.stringify(this.state)) as BlueGreenState;
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    await mkdir(join(this.storage.root, 'applications', this.options.applicationId), { recursive: true });
    const tmp = this.filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify(this.state, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(tmp, this.filename);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  private async loadState(): Promise<BlueGreenState | undefined> {
    let content: string;
    try { content = await readFile(this.filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const candidate: unknown = JSON.parse(content);
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid blue/green state');
    const data = candidate as Record<string, unknown>;
    if (data.schemaVersion !== 1 || data.applicationId !== this.options.applicationId ||
      (data.active !== undefined && data.active !== 'blue' && data.active !== 'green')) {
      throw new Error('Invalid blue/green state');
    }
    for (const slot of ['blue', 'green'] as Slot[]) {
      if (data[slot] === undefined) continue;
      const item = data[slot] as Record<string, unknown>;
      if (!item || typeof item.version !== 'string' || !VERSION.test(item.version) ||
          item.port !== this.ports[slot]) throw new Error('Invalid blue/green slot');
    }
    return candidate as BlueGreenState;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Call initialize() before deploying');
  }
}

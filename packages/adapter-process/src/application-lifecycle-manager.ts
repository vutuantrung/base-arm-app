import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationStorage } from './deployment/application-storage.js';
import { validateApplicationManifest } from './deployment/application-package-validator.js';
import type { InstalledRelease } from './deployment/deployment-types.js';
import { ProcessManager, type ProcessSpec, type ProcessView } from './process-manager.js';
import { ArmRuntimeInjector } from './arm-runtime-injector.js';

export interface ActiveRelease {
  applicationId: string;
  version: string;
  activatedAt: string;
}

export type ApplicationReadiness = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN' | 'NOT_CONFIGURED';

export interface ApplicationRuntimeView {
  applicationId: string;
  version: string;
  process: ProcessView;
  readiness: ApplicationReadiness;
}

export interface ApplicationLifecycleOptions {
  storageRoot: string;
  processStateFile?: string;
  /** HTTP connect/read deadline of a single ARM readiness check. */
  healthTimeoutMs?: number;
  /** Shared token for the deployed ARM metrics endpoint, if configured. */
  metricsToken?: string;
  /** Additional *trusted* environment values. No untrusted manifest env is executed. */
  env?: Record<string, string>;
  injector?: ArmRuntimeInjector;
}

const APPLICATION_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Phase 2: Installed release -> active release -> managed Node.js process.
 *
 * ProcessManager owns OS process operations and PID verification.
 * This service owns only release selection and the deployment/process handoff.
 */
export class ApplicationLifecycleManager {
  readonly storage: ApplicationStorage;
  readonly processes: ProcessManager;
  private readonly active = new Map<string, ActiveRelease>();
  private initialized = false;
  private readonly operations = new Set<string>();

  constructor(private readonly options: ApplicationLifecycleOptions) {
    this.storage = new ApplicationStorage(options.storageRoot);
    this.processes = new ProcessManager(
      options.processStateFile ?? join(this.storage.root, 'state', 'processes.json'),
      options.injector,
    );
  }

  /** Loads persisted release selections before PID reconciliation. */
  async initialize(): Promise<void> {
    if (this.initialized) throw new Error('ApplicationLifecycleManager already initialized');
    const selections = await this.loadActiveReleases();
    const specs: ProcessSpec[] = [];
    for (const selection of selections) {
      const release = await this.requireRelease(selection.applicationId, selection.version);
      specs.push(this.createProcessSpec(release));
      this.active.set(selection.applicationId, selection);
    }
    await this.processes.initialize(specs);
    this.initialized = true;
  }

  async activateRelease(applicationId: string, version: string): Promise<ActiveRelease> {
    this.assertInitialized();
    return this.lock(applicationId, async () => {
      const release = await this.requireRelease(applicationId, version);
      this.assertNotRunning(applicationId, await this.currentProcess(applicationId));
      const spec = this.createProcessSpec(release);
      await this.processes.registerSpec(spec);
      const selection = { applicationId, version, activatedAt: new Date().toISOString() };
      await this.persistSelection(selection);
      this.active.set(applicationId, selection);
      return selection;
    });
  }

  async startApplication(applicationId: string): Promise<ApplicationRuntimeView> {
    this.assertInitialized();
    return this.lock(applicationId, async () => {
      const release = await this.requireActiveRelease(applicationId);
      await this.processes.start(applicationId);
      return this.getApplicationStatusForRelease(release);
    });
  }

  async stopApplication(applicationId: string): Promise<ApplicationRuntimeView> {
    this.assertInitialized();
    return this.lock(applicationId, async () => {
      const release = await this.requireActiveRelease(applicationId);
      await this.processes.stop(applicationId, release.manifest.lifecycle.stopTimeoutMs);
      return this.getApplicationStatusForRelease(release);
    });
  }

  async restartApplication(applicationId: string): Promise<ApplicationRuntimeView> {
    this.assertInitialized();
    return this.lock(applicationId, async () => {
      const release = await this.requireActiveRelease(applicationId);
      await this.processes.restart(applicationId, release.manifest.lifecycle.stopTimeoutMs);
      return this.getApplicationStatusForRelease(release);
    });
  }

  async inspectApplication(applicationId: string): Promise<ApplicationRuntimeView> {
    this.assertInitialized();
    return this.getApplicationStatusForRelease(await this.requireActiveRelease(applicationId));
  }

  async listApplications(): Promise<ApplicationRuntimeView[]> {
    this.assertInitialized();
    const result: ApplicationRuntimeView[] = [];
    for (const applicationId of this.active.keys()) {
      result.push(await this.inspectApplication(applicationId));
    }
    return result;
  }

  /** Only closes Supervisor-side bookkeeping. Detached child apps keep running. */
  close(): void {
    this.processes.close();
  }

  private async currentProcess(applicationId: string): Promise<ProcessView | undefined> {
    if (!this.active.has(applicationId)) return undefined;
    return this.processes.inspect(applicationId);
  }

  private assertNotRunning(applicationId: string, view: ProcessView | undefined): void {
    if (view && view.status !== 'STOPPED') {
      throw new Error(`Stop application ${applicationId} before changing its release`);
    }
  }

  private async getApplicationStatusForRelease(
    release: InstalledRelease,
  ): Promise<ApplicationRuntimeView> {
    const process = await this.processes.inspect(release.applicationId);
    const readiness = await this.checkReadiness(release, process);
    return { applicationId: release.applicationId, version: release.version, process, readiness };
  }

  private async checkReadiness(
    release: InstalledRelease, process: ProcessView,
  ): Promise<ApplicationReadiness> {
    if (!release.manifest.arm.enabled) return 'NOT_CONFIGURED';
    if (process.status !== 'RUNNING') return 'UNKNOWN';
    const port = release.manifest.arm.metricsPort;
    if (!port) return 'UNKNOWN';
    try {
      const response = await fetch(`http://127.0.0.1:${port}/reliability/ready`, {
        headers: this.options.metricsToken
          ? { authorization: `Bearer ${this.options.metricsToken}` }
          : undefined,
        signal: AbortSignal.timeout(this.options.healthTimeoutMs ?? 1500),
      });
      if (response.status === 200) return 'HEALTHY';
      if (response.status === 503) return 'UNHEALTHY';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  private createProcessSpec(release: InstalledRelease): ProcessSpec {
    const port = release.manifest.arm.metricsPort;
    return {
      id: release.applicationId,
      entry: release.entry,
      cwd: release.directory,
      env: {
        ...this.options.env,
        NODE_ENV: 'production',
        ARM_APPLICATION_ID: release.applicationId,
        ARM_INSTANCE_ID: `${release.applicationId}-managed`,
        ...(port && release.manifest.arm.enabled ? { ARM_PORT: String(port) } : {}),
        ...(this.options.metricsToken ? { ARM_METRICS_TOKEN: this.options.metricsToken } : {}),
      },
      ...(port && release.manifest.arm.enabled
        ? { metricsUrl: `ws://127.0.0.1:${port}/metrics/ws`,
            metricsToken: this.options.metricsToken }
        : {}),
    };
  }

  private async requireActiveRelease(applicationId: string): Promise<InstalledRelease> {
    const selection = this.active.get(applicationId);
    if (!selection) throw new Error(`No active release for ${applicationId}; call activateRelease first`);
    return this.requireRelease(applicationId, selection.version);
  }

  private async requireRelease(applicationId: string, version: string): Promise<InstalledRelease> {
    this.assertValidIdentity(applicationId, version);
    const release = await this.storage.readRelease(applicationId, version);
    if (!release || release.applicationId !== applicationId || release.version !== version) {
      throw new Error(`Installed release not found: ${applicationId}@${version}`);
    }
    const manifest = validateApplicationManifest(release.manifest);
    if (manifest.applicationId !== applicationId || manifest.version !== version) {
      throw new Error('Stored deployment metadata does not match release identity');
    }
    return release;
  }

  private assertValidIdentity(applicationId: string, version: string): void {
    if (!APPLICATION_ID.test(applicationId) || !RELEASE_VERSION.test(version)) {
      throw new Error('Invalid application id or release version');
    }
  }

  private async loadActiveReleases(): Promise<ActiveRelease[]> {
    const applicationsDir = join(this.storage.root, 'applications');
    let names: string[];
    try {
      names = await readdir(applicationsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const selections: ActiveRelease[] = [];
    for (const name of names) {
      if (!APPLICATION_ID.test(name)) continue;
      const file = join(applicationsDir, name, 'active.json');
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const selection: unknown = JSON.parse(raw);
      if (!this.isActiveRelease(selection) || selection.applicationId !== name) {
        throw new Error(`Invalid active release record: ${name}`);
      }
      selections.push(selection);
    }
    return selections;
  }

  private isActiveRelease(value: unknown): value is ActiveRelease {
    if (!value || typeof value !== 'object') return false;
    const data = value as Record<string, unknown>;
    return typeof data.applicationId === 'string' &&
      typeof data.version === 'string' &&
      typeof data.activatedAt === 'string' &&
      APPLICATION_ID.test(data.applicationId) && RELEASE_VERSION.test(data.version);
  }

  private async persistSelection(selection: ActiveRelease): Promise<void> {
    const directory = join(this.storage.root, 'applications', selection.applicationId);
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'active.json');
    const tmp = join(directory, `active.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(selection, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Call initialize() before managing apps');
  }

  private async lock<T>(applicationId: string, action: () => Promise<T>): Promise<T> {
    if (this.operations.has(applicationId)) {
      throw new Error(`Application operation in progress: ${applicationId}`);
    }
    this.operations.add(applicationId);
    try { return await action(); }
    finally { this.operations.delete(applicationId); }
  }
}

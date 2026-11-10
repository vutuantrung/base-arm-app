import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, rename, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ProcessSpec {
  id: string;
  entry: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** ARM WebSocket endpoint provided by the child app. */
  metricsUrl?: string;
  /** Bearer token if its ARM MetricsServer requires authentication. */
  metricsToken?: string;
}

export interface ManagedProcessState {
  id: string;
  pid: number;
  /** Linux /proc start time, used to defend against PID reuse. */
  startTime?: string;
  startedAt: string;
}

export type ProcessStatus = 'RUNNING' | 'STOPPED' | 'UNKNOWN';

export interface ProcessView {
  id: string;
  pid?: number;
  status: ProcessStatus;
  adopted: boolean;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function linuxStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    // Fields after "(comm)" begin with field 3 (state).
    return stat.slice(end + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

/**
 * Detached process supervisor. close() never terminates managed apps.
 * Only explicitly stop(id) and restart(id) can terminate a process.
 *
 * One supervisor instance should own the registry file at a time.
 */
export class ProcessManager extends EventEmitter {
  private readonly specs = new Map<string, ProcessSpec>();
  private readonly states = new Map<string, ManagedProcessState>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly locks = new Set<string>();
  private initialized = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile: string) {
    super();
  }

  async initialize(specs: ProcessSpec[]): Promise<void> {
    if (this.initialized) throw new Error('ProcessManager already initialized');
    const ids = new Set<string>();
    for (const spec of specs) {
      this.validateSpec(spec);
      if (ids.has(spec.id)) throw new Error(`Duplicate process id: ${spec.id}`);
      ids.add(spec.id);
      this.specs.set(spec.id, spec);
    }

    let saved: ManagedProcessState[] = [];
    try {
      const json: unknown = JSON.parse(await readFile(this.stateFile, 'utf8'));
      if (!Array.isArray(json)) throw new Error('Invalid registry format');
      saved = json as ManagedProcessState[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    for (const record of saved) {
      if (!this.specs.has(record.id) || !Number.isSafeInteger(record.pid) || record.pid < 1) continue;
      this.states.set(record.id, record);
    }
    this.initialized = true;
    await this.reconcile();
  }

  /**
   * Add an installed release without restarting the Supervisor.
   * A different specification can replace the previous one only if stopped.
   */
  async registerSpec(spec: ProcessSpec): Promise<void> {
    this.assertInitialized();
    this.validateSpec(spec);
    await this.lock(spec.id, async () => {
      const previous = this.specs.get(spec.id);
      if (previous && JSON.stringify(previous) === JSON.stringify(spec)) return;
      if (previous && (await this.inspectExistingProcess(spec.id))) {
        throw new Error(`Cannot replace running process specification: ${spec.id}`);
      }
      this.specs.set(spec.id, { ...spec });
    });
  }

  private async inspectExistingProcess(id: string): Promise<boolean> {
    const state = this.states.get(id);
    if (!state) return false;
    if (await this.verify(state)) return true;
    if (isAlive(state.pid)) {
      throw new Error(`Unverified PID ${state.pid}; refusing spec replacement`);
    }
    this.states.delete(id);
    await this.persist();
    return false;
  }

  private validateSpec(spec: ProcessSpec): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(spec.id)) {
      throw new Error(`Invalid process id: ${spec.id}`);
    }
    if (!spec.entry) throw new Error('entry is required');
    if (spec.metricsUrl && !/^wss?:\/\//.test(spec.metricsUrl)) {
      throw new Error('metricsUrl must be WebSocket URL');
    }
  }

  async inspect(id: string): Promise<ProcessView> {
    this.assertInitialized();
    this.getSpec(id);
    const state = this.states.get(id);
    if (!state) return { id, status: 'STOPPED', adopted: false };
    const verified = await this.verify(state);
    return {
      id, pid: state.pid,
      status: verified ? 'RUNNING' : isAlive(state.pid) ? 'UNKNOWN' : 'STOPPED',
      adopted: !this.children.has(id),
    };
  }

  list(): ProcessView[] {
    return [...this.specs.keys()].map(id => {
      const state = this.states.get(id);
      return {
        id,
        pid: state?.pid,
        status: state && isAlive(state.pid) ? 'RUNNING' : state ? 'UNKNOWN' : 'STOPPED',
        adopted: !!state && !this.children.has(id),
      };
    });
  }

  getSpec(id: string): ProcessSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new Error(`Unknown process: ${id}`);
    return spec;
  }

  private async verify(state: ManagedProcessState): Promise<boolean> {
    if (!isAlive(state.pid)) return false;
    if (process.platform === 'linux') {
      try {
        const stat = await readFile(`/proc/${state.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        // field 3: process state; a zombie is not operational.
        if (fields[0] === 'Z' || fields[0] === 'X') return false;
        return !!state.startTime && fields[19] === state.startTime;
      } catch { return false; }
    }
    // Other platforms cannot safely verify an adopted PID with this adapter.
    return this.children.get(state.id)?.pid === state.pid;
  }

  async reconcile(): Promise<void> {
    this.assertInitialized();
    let changed = false;
    for (const [id, state] of this.states) {
      if (!(await this.verify(state))) {
        // On platforms without a process identity, do not assume the PID
        // belongs to a managed app and do not automatically respawn it.
        if (process.platform !== 'linux' && isAlive(state.pid)) {
          this.emit('unverified', { id, pid: state.pid });
          continue;
        }
        this.states.delete(id);
        changed = true;
        this.emit('exited', { id, pid: state.pid });
      } else if (!this.children.has(id)) {
        this.emit('adopted', { id, pid: state.pid });
      }
    }
    if (changed) await this.persist();
  }

  async start(id: string): Promise<ManagedProcessState> {
    this.assertInitialized();
    return this.lock(id, async () => {
      const spec = this.getSpec(id);
      const existing = this.states.get(id);
      if (existing) {
        if (await this.verify(existing)) return existing;
        if (isAlive(existing.pid)) {
          throw new Error(`Unverified PID ${existing.pid}; refusing duplicate start`);
        }
      }
      return this.launch(id, spec);
    });
  }

  private async launch(id: string, spec: ProcessSpec): Promise<ManagedProcessState> {
      const child = spawn(process.execPath, [spec.entry, ...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (!child.pid) throw new Error('Spawn did not return a PID');
      child.unref();

      const state: ManagedProcessState = {
        id, pid: child.pid, startedAt: new Date().toISOString(),
        startTime: await linuxStartTime(child.pid),
      };
      // Persist before considering the process managed.
      try {
        this.states.set(id, state);
        await this.persist();
      } catch (error) {
        this.states.delete(id);
        child.kill();
        throw error;
      }
      this.children.set(id, child);
      child.once('exit', (code, signal) => {
        if (this.children.get(id) === child) this.children.delete(id);
        // Do not auto-delete persistent state here: reconciling and
        // recording exit are asynchronous and could race with a new spawn.
        this.emit('exit', { id, pid: state.pid, code, signal });
      });
      this.emit('started', { ...state });
      return state;
  }

  async stop(id: string, timeoutMs = 5000): Promise<void> {
    this.assertInitialized();
    return this.lock(id, async () => this.stopUnlocked(id, timeoutMs));
  }

  async restart(id: string, timeoutMs = 5000): Promise<ManagedProcessState> {
    this.assertInitialized();
    return this.lock(id, async () => {
      await this.stopUnlocked(id, timeoutMs);
      return this.launch(id, this.getSpec(id));
    });
  }

  private async stopUnlocked(id: string, timeoutMs: number): Promise<void> {
    this.getSpec(id);
    const state = this.states.get(id);
    if (!state) return;
    if (!(await this.verify(state))) {
      if (isAlive(state.pid)) throw new Error(`Unsafe to signal unverified PID ${state.pid}`);
      this.states.delete(id);
      await this.persist();
      return;
    }
    process.kill(state.pid, 'SIGTERM');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && (await this.verify(state))) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (await this.verify(state)) {
      throw new Error(`Process ${id} did not stop within ${timeoutMs}ms`);
    }
    this.states.delete(id);
    await this.persist();
    this.emit('stopped', { id, pid: state.pid });
  }

  /** Deliberately leaves detached apps running when supervisor exits. */
  close(): void {
    this.removeAllListeners();
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Call initialize() before managing processes');
  }

  private async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(id)) throw new Error(`Operation already pending: ${id}`);
    this.locks.add(id);
    try { return await fn(); }
    finally { this.locks.delete(id); }
  }

  private async persist(): Promise<void> {
    const save = async () => {
      await mkdir(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.states.values()], null, 2), { mode: 0o600 });
      await rename(tmp, this.stateFile);
    };
    const next = this.persistQueue.then(save, save);
    this.persistQueue = next.then(() => {}, () => {});
    await next;
  }
}

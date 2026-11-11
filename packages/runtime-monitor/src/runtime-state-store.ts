import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DesiredProcessState = 'RUNNING' | 'STOPPED';
export type DurableRecoveryState = 'IDLE' | 'SCHEDULED' | 'RECOVERING' | 'EXHAUSTED' | 'MANUALLY_STOPPED';

export interface DurableRuntimeRecord {
  schemaVersion: 1;
  applicationId: string;
  releaseVersion: string;
  desired: DesiredProcessState;
  recoveryState: DurableRecoveryState;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  lastExit?: { kind: 'EXITED' | 'SIGNALED' | 'UNKNOWN'; code?: number; signal?: string; observedAt: string };
  updatedAt: string;
}

const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const STATES = new Set<DurableRecoveryState>(['IDLE', 'SCHEDULED', 'RECOVERING', 'EXHAUSTED', 'MANUALLY_STOPPED']);

export class RuntimeStateStore {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}

  async read(applicationId: string): Promise<DurableRuntimeRecord | undefined> {
    this.validateId(applicationId);
    let text: string;
    try {
      text = await readFile(this.pathOf(applicationId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!this.isRecord(value, applicationId)) throw new Error(`Invalid runtime state for ${applicationId}`);
    return value;
  }

  async write(record: DurableRuntimeRecord): Promise<void> {
    if (!this.isRecord(record, record.applicationId)) throw new Error('Invalid runtime state record');
    const previous = this.pending.get(record.applicationId) ?? Promise.resolve();
    const snapshot = JSON.stringify(record, null, 2);
    const task = previous.catch(() => {}).then(() => this.writeAtomic(record.applicationId, snapshot));
    this.pending.set(record.applicationId, task);
    try {
      await task;
    } finally {
      if (this.pending.get(record.applicationId) === task) this.pending.delete(record.applicationId);
    }
  }

  private async writeAtomic(id: string, contents: string): Promise<void> {
    const destination = this.pathOf(id);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } catch (error) {
      const { rm } = await import('node:fs/promises');
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private pathOf(id: string): string {
    return join(this.root, 'applications', id, 'runtime-state.json');
  }

  private validateId(id: string): void {
    if (!ID.test(id)) throw new Error('Invalid application ID');
  }

  private isRecord(value: unknown, id: string): value is DurableRuntimeRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
    return typeof id === 'string' && ID.test(id) &&
      row.schemaVersion === 1 && row.applicationId === id &&
      typeof row.releaseVersion === 'string' && VERSION.test(row.releaseVersion) &&
      (row.desired === 'RUNNING' || row.desired === 'STOPPED') &&
      STATES.has(row.recoveryState as DurableRecoveryState) &&
      Number.isSafeInteger(row.attempts) && (row.attempts as number) >= 0 &&
      (row.nextAttemptAt === undefined || date(row.nextAttemptAt)) &&
      (row.lastError === undefined || typeof row.lastError === 'string') &&
      date(row.updatedAt) &&
      (row.lastExit === undefined || this.isExit(row.lastExit));
  }

  private isExit(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return ['EXITED', 'SIGNALED', 'UNKNOWN'].includes(String(row.kind)) &&
      (row.code === undefined || Number.isInteger(row.code)) &&
      (row.signal === undefined || typeof row.signal === 'string') &&
      typeof row.observedAt === 'string' && Number.isFinite(Date.parse(row.observedAt));
  }
}

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type RolloutPhase =
  | 'PREPARED' | 'STOPPING_OLD' | 'ACTIVATING_NEW' | 'STARTING_NEW'
  | 'VERIFYING' | 'ROLLING_BACK' | 'SUCCEEDED' | 'ROLLED_BACK' | 'NEEDS_ATTENTION';

export interface RolloutOperation {
  schemaVersion: 1;
  operationId: string;
  applicationId: string;
  fromVersion: string;
  toVersion: string;
  previousDesired: 'RUNNING' | 'STOPPED';
  allowProcessOnly: boolean;
  phase: RolloutPhase;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const PHASES = new Set<RolloutPhase>([
  'PREPARED', 'STOPPING_OLD', 'ACTIVATING_NEW', 'STARTING_NEW',
  'VERIFYING', 'ROLLING_BACK', 'SUCCEEDED', 'ROLLED_BACK', 'NEEDS_ATTENTION',
]);

/** One durable journal file per app, replaced atomically after each checkpoint. */
export class RolloutJournal {
  constructor(private readonly root: string) {}

  async read(applicationId: string): Promise<RolloutOperation | undefined> {
    const filename = this.filenameFor(applicationId);
    let raw: string;
    try { raw = await readFile(filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const operation: unknown = JSON.parse(raw);
    if (!this.isOperation(operation) || operation.applicationId !== applicationId) {
      throw new Error('Invalid rollout journal: ' + applicationId);
    }
    return operation;
  }

  async write(operation: RolloutOperation): Promise<void> {
    if (!this.isOperation(operation)) throw new Error('Invalid rollout journal');
    const filename = this.filenameFor(operation.applicationId);
    await mkdir(join(this.root, 'applications', operation.applicationId), { recursive: true, mode: 0o700 });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(operation, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async transition(operation: RolloutOperation, phase: RolloutPhase, error?: string): Promise<RolloutOperation> {
    const updated: RolloutOperation = {
      ...operation, phase, updatedAt: new Date().toISOString(),
      ...(error ? { error: error.slice(0, 500) } : {}),
    };
    await this.write(updated);
    return updated;
  }

  async list(): Promise<RolloutOperation[]> {
    let applicationIds: string[];
    try { applicationIds = await readdir(join(this.root, 'applications')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const items = await Promise.all(applicationIds.filter(id => IDENTIFIER.test(id)).map(id => this.read(id)));
    return items.filter((item): item is RolloutOperation => item !== undefined);
  }

  private filenameFor(applicationId: string): string {
    if (!IDENTIFIER.test(applicationId)) throw new Error('Invalid application ID');
    return join(this.root, 'applications', applicationId, 'rollout.json');
  }

  private isOperation(value: unknown): value is RolloutOperation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const x = value as Record<string, unknown>;
    return x.schemaVersion === 1 && typeof x.operationId === 'string' && x.operationId.length > 0 &&
      typeof x.applicationId === 'string' && IDENTIFIER.test(x.applicationId) &&
      typeof x.fromVersion === 'string' && VERSION.test(x.fromVersion) &&
      typeof x.toVersion === 'string' && VERSION.test(x.toVersion) &&
      (x.previousDesired === 'RUNNING' || x.previousDesired === 'STOPPED') &&
      typeof x.allowProcessOnly === 'boolean' && PHASES.has(x.phase as RolloutPhase) &&
      typeof x.createdAt === 'string' && Number.isFinite(Date.parse(x.createdAt)) &&
      typeof x.updatedAt === 'string' && Number.isFinite(Date.parse(x.updatedAt)) &&
      (x.error === undefined || typeof x.error === 'string');
  }
}

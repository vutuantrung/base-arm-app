import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ReleaseTransition {
  fromVersion?: string;
  toVersion: string;
  changedAt: string;
  action: 'ACTIVATE' | 'ROLLBACK';
}

const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/** Durable transition history. The last fromVersion is the rollback candidate. */
export class ReleaseHistoryStore {
  constructor(private readonly storageRoot: string) {}

  async list(applicationId: string): Promise<ReleaseTransition[]> {
    const file = this.pathFor(applicationId);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(parsed) || !parsed.every(row => this.isTransition(row))) {
        throw new Error('Invalid release transition history');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async record(applicationId: string, transition: ReleaseTransition): Promise<void> {
    if (!this.isTransition(transition)) throw new Error('Invalid release transition');
    const previous = await this.list(applicationId);
    const updated = [...previous, transition];
    const file = this.pathFor(applicationId);
    const temporary = file + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(updated, null, 2), {
        flag: 'wx', mode: 0o600,
      });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private pathFor(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid application ID');
    return join(this.storageRoot, 'applications', id, 'release-history.json');
  }

  private isTransition(value: unknown): value is ReleaseTransition {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row.toVersion === 'string' && VERSION.test(row.toVersion) &&
      (row.fromVersion === undefined || (typeof row.fromVersion === 'string' && VERSION.test(row.fromVersion))) &&
      (row.action === 'ACTIVATE' || row.action === 'ROLLBACK') &&
      typeof row.changedAt === 'string' && Number.isFinite(Date.parse(row.changedAt));
  }
}

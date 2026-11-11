import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DeploymentAuditAction = 'INSTALL' | 'ACTIVATE' | 'ROLLBACK';
export type DeploymentAuditOutcome = 'SUCCEEDED' | 'FAILED';

export interface DeploymentAuditEntry {
  id: string;
  timestamp: string;
  action: DeploymentAuditAction;
  outcome: DeploymentAuditOutcome;
  applicationId?: string;
  version?: string;
  previousVersion?: string;
  reason?: string;
}

/** Append-only JSONL audit trail. One writer must own the storage root. */
export class DeploymentAuditLog {
  private pending: Promise<void> = Promise.resolve();
  private readonly filename: string;

  constructor(storageRoot: string) {
    this.filename = join(storageRoot, 'audit', 'deployments.jsonl');
  }

  async append(entry: Omit<DeploymentAuditEntry, 'id' | 'timestamp'>): Promise<DeploymentAuditEntry> {
    const record: DeploymentAuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    const write = async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      await appendFile(this.filename, JSON.stringify(record) + '\n', { mode: 0o600 });
    };
    const next = this.pending.then(write, write);
    this.pending = next.then(() => {}, () => {});
    await next;
    return record;
  }

  async list(applicationId?: string, limit = 100): Promise<DeploymentAuditEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid audit limit');
    }
    let data: string;
    try {
      data = await readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = data.trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as DeploymentAuditEntry);
    return records.filter(item => !applicationId || item.applicationId === applicationId)
      .slice(-limit).reverse();
  }
}

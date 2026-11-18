import { appendFileSync, closeSync, constants, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const PROCESS_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const RUN_ID = /^\d{13}-[A-Za-z0-9]{6}$/;
export type ProcessLogStream = 'stdout' | 'stderr' | 'diagnostics';
export interface ProcessLogTail {
  processId: string;
  runId: string;
  stream: ProcessLogStream;
  sizeBytes: number;
  truncated: boolean;
  text: string;
}

export interface ProcessLogSession {
  stdout: number;
  stderr: number;
  closeParentDescriptors(): void;
  record(event: 'launch' | 'spawned' | 'exit' | 'launch_failed',
    details?: { pid?: number; code?: number | string | null; signal?: string | null }): void;
}

/** Operator-owned storage, outside immutable releases. Child FDs survive host shutdown. */
export class ChildProcessLogs {
  constructor(private readonly root: string) {}

  openLaunch(processId: string, applicationId: string, instanceId: string,
    releaseVersion?: string): ProcessLogSession {
    const directory = this.processDirectory(processId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const run = mkdtempSync(join(directory, Date.now() + '-'));
    const stdout = openSync(join(run, 'stdout.log'), 'ax', 0o600);
    let stderr: number;
    try { stderr = openSync(join(run, 'stderr.log'), 'ax', 0o600); }
    catch (error) { closeSync(stdout); throw error; }
    const diagnostics = join(run, 'diagnostics.log');
    let closed = false;
    const session: ProcessLogSession = {
      stdout, stderr,
      closeParentDescriptors() {
        if (closed) return;
        closed = true;
        try { closeSync(stdout); } finally { closeSync(stderr); }
      },
      record(event, details) {
        // Diagnostics must never throw from an asynchronous process exit listener.
        try {
          appendFileSync(diagnostics, JSON.stringify({
            timestamp: new Date().toISOString(), event, processId,
            applicationId, instanceId, releaseVersion, ...details,
          }) + '\n', { mode: 0o600, flag: 'a' });
        } catch { /* Child output remains independent of diagnostic journal. */ }
      },
    };
    session.record('launch');
    return session;
  }

  async listRuns(processId: string): Promise<string[]> {
    try {
      const entries = await readdir(this.processDirectory(processId), { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory() && RUN_ID.test(entry.name))
        .map(entry => entry.name).sort().reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async readTail(processId: string, stream: ProcessLogStream, maxBytes = 16384,
    runId?: string): Promise<ProcessLogTail | undefined> {
    const directory = this.processDirectory(processId);
    if (!['stdout', 'stderr', 'diagnostics'].includes(stream)) throw new Error('Invalid log stream');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) {
      throw new Error('Invalid log byte limit (1–65536)');
    }
    if (runId !== undefined && !RUN_ID.test(runId)) throw new Error('Invalid log run');
    const selected = runId ?? (await this.listRuns(processId))[0];
    if (!selected) return undefined;
    try {
      const file = await open(join(directory, selected, stream + '.log'),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('Invalid log file');
        const size = stat.size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, size - length);
        return { processId, runId: selected, stream, sizeBytes: size,
          truncated: size > length, text: buffer.subarray(0, bytesRead).toString('utf8') };
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private processDirectory(processId: string): string {
    if (!PROCESS_ID.test(processId) || basename(processId) !== processId) {
      throw new Error('Invalid process id');
    }
    return join(this.root, processId);
  }
}

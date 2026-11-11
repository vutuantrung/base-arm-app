import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface ArmRuntimeTelemetry {
  schemaVersion: 1;
  applicationId: string;
  instanceId: string;
  pid: number;
  timestamp: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  eventLoopUtilization: number;
  eventLoopDelayMeanMs: number;
  eventLoopDelayMaxMs: number;
  requestsStarted: number;
  responsesFinished: number;
  responses5xx: number;
  uncaughtExceptions: number;
  lastErrorType?: string;
}

/** Best-effort, PID-scoped telemetry. Never assume a stale file describes a live process. */
export class ArmTelemetryReader {
  constructor(private readonly telemetryRoot: string) {}

  async read(instanceId: string): Promise<ArmRuntimeTelemetry | undefined> {
    if (!ID.test(instanceId)) throw new Error('Invalid ARM instance ID');
    let data: unknown;
    try { data = JSON.parse(await readFile(join(this.telemetryRoot, instanceId + '.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!this.isTelemetry(data) || data.instanceId !== instanceId) {
      throw new Error('Invalid ARM runtime telemetry');
    }
    return data;
  }

  private isTelemetry(input: unknown): input is ArmRuntimeTelemetry {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const x = input as Record<string, unknown>;
    return x.schemaVersion === 1 &&
      typeof x.applicationId === 'string' && ID.test(x.applicationId) &&
      typeof x.instanceId === 'string' && ID.test(x.instanceId) &&
      Number.isSafeInteger(x.pid) && (x.pid as number) > 0 &&
      typeof x.timestamp === 'string' && Number.isFinite(Date.parse(x.timestamp)) &&
      ['uptimeSec', 'rssBytes', 'heapUsedBytes', 'eventLoopUtilization',
        'eventLoopDelayMeanMs', 'eventLoopDelayMaxMs', 'requestsStarted',
        'responsesFinished', 'responses5xx', 'uncaughtExceptions']
        .every(key => typeof x[key] === 'number' && Number.isFinite(x[key]));
  }
}

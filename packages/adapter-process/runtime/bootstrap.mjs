/**
 * Supervisor-owned Node.js preload; no app dependency or source rewrite.
 * Telemetry is best-effort and never changes application exception semantics.
 */
import { isMainThread } from 'node:worker_threads';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';

const id = process.env.ARM_APPLICATION_ID;
const instance = process.env.ARM_INSTANCE_ID;
const directory = process.env.ARM_TELEMETRY_ROOT;
const INTERVAL = Number(process.env.ARM_SAMPLE_INTERVAL_MS ?? 1000);
const VALID_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

if (isMainThread && process.env.ARM_INJECTION_ENABLED === '1') {
  if (!id || !instance || !VALID_ID.test(id) || !VALID_ID.test(instance) ||
    !directory || !Number.isSafeInteger(INTERVAL) || INTERVAL < 250) {
    throw new Error('Invalid Supervisor ARM injection configuration');
  }

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let requests = 0;
  let completed = 0;
  let serverErrors = 0;
  let uncaught = 0;
  let writing = false;
  let lastUtilization = performance.eventLoopUtilization();
  let lastError;

  // diagnostics_channel subscribers never wrap or replace HTTP methods.
  diagnosticsChannel.channel('http.server.request.start').subscribe(() => { requests++; });
  diagnosticsChannel.channel('http.server.response.finish').subscribe(message => {
    completed++;
    if (message?.response?.statusCode >= 500) serverErrors++;
  });
  process.on('uncaughtExceptionMonitor', error => {
    uncaught++;
    lastError = error instanceof Error ? error.name : 'UnknownError';
  });

  async function sample() {
    if (writing) return;
    writing = true;
    const delta = performance.eventLoopUtilization(lastUtilization);
    lastUtilization = performance.eventLoopUtilization();
    const snapshot = {
      schemaVersion: 1,
      applicationId: id,
      instanceId: instance,
      pid: process.pid,
      timestamp: new Date().toISOString(),
      uptimeSec: process.uptime(),
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      eventLoopUtilization: delta.utilization,
      eventLoopDelayMeanMs: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : 0,
      eventLoopDelayMaxMs: histogram.max / 1e6,
      requestsStarted: requests,
      responsesFinished: completed,
      responses5xx: serverErrors,
      uncaughtExceptions: uncaught,
      ...(lastError ? { lastErrorType: lastError } : {}),
    };
    histogram.reset();
    const file = join(directory, instance + '.json');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch {
      // Telemetry must not crash or block the business process.
    } finally {
      writing = false;
    }
  }

  const timer = setInterval(() => { void sample(); }, INTERVAL);
  timer.unref();
  void sample();
}

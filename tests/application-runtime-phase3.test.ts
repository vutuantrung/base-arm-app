import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationRuntimeMonitor } from '../packages/adapter-process/src/application-runtime-monitor.js';
import { ApplicationManagementApi } from '../packages/adapter-process/src/application-management-api.js';
import type { ApplicationLifecycleManager, ApplicationRuntimeView } from '../packages/adapter-process/src/application-lifecycle-manager.js';
import type { InstalledRelease } from '../packages/adapter-process/src/deployment/deployment-types.js';

type ProcessMode = 'RUNNING' | 'STOPPED';
function createFixture(restartPolicy: 'never' | 'on-failure' | 'always' = 'on-failure', maxRestarts = 2) {
  let status: ProcessMode = 'STOPPED';
  let pid = 100;
  let starts = 0;
  const calls: string[] = [];
  const view = (): ApplicationRuntimeView => ({
    applicationId: 'payment-service',
    version: '1.0.0',
    process: { id: 'payment-service', pid: status === 'RUNNING' ? pid : undefined,
      status, adopted: false },
    readiness: 'NOT_CONFIGURED',
  });
  const release = {
    manifest: {
      lifecycle: {
        restartPolicy, maxRestarts, autoStart: false, stopTimeoutMs: 1000,
      },
    },
  } as InstalledRelease;
  const lifecycle = {
    storage: { readRelease: async () => release },
    async listApplications() { return [view()]; },
    async inspectApplication() { return view(); },
    async startApplication() { starts++; status = 'RUNNING'; pid++; calls.push('start'); return view(); },
    async stopApplication() { status = 'STOPPED'; calls.push('stop'); return view(); },
    async restartApplication() { status = 'RUNNING'; pid++; calls.push('restart'); return view(); },
    async activateRelease() { calls.push('activate'); },
    close() { calls.push('close'); },
  } as unknown as ApplicationLifecycleManager;
  return {
    lifecycle, calls, get starts() { return starts; },
    crash() { status = 'STOPPED'; },
    get status() { return status; },
  };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('Phase 3 recovers unexpected process exit using backoff; manual stop suppresses restart', async () => {
  const fixture = createFixture('on-failure', 2);
  const monitor = new ApplicationRuntimeMonitor(fixture.lifecycle, {
    restartBaseDelayMs: 10, restartMaxDelayMs: 50, intervalMs: 20,
  });
  try {
    await monitor.startApplication('payment-service');
    fixture.crash();
    await monitor.tick();
    assert.equal((await monitor.inspectApplication('payment-service')).recovery.state, 'SCHEDULED');
    await sleep(20);
    await monitor.tick();
    assert.equal(fixture.starts, 2);
    assert.equal((await monitor.inspectApplication('payment-service')).recovery.state, 'IDLE');
    await monitor.stopApplication('payment-service');
    await monitor.tick();
    await sleep(20);
    await monitor.tick();
    assert.equal(fixture.starts, 2);
    assert.equal((await monitor.inspectApplication('payment-service')).recovery.state, 'MANUALLY_STOPPED');
  } finally {
    monitor.close();
  }
});

test('Phase 3 honors disabled policy and maximum restart attempts', async () => {
  const fixture = createFixture('never', 0);
  const monitor = new ApplicationRuntimeMonitor(fixture.lifecycle, {
    restartBaseDelayMs: 10, restartMaxDelayMs: 20,
  });
  try {
    await monitor.startApplication('payment-service');
    fixture.crash();
    await monitor.tick();
    const status = await monitor.inspectApplication('payment-service');
    assert.equal(status.recovery.state, 'EXHAUSTED');
    assert.equal(fixture.starts, 1);
  } finally { monitor.close(); }
});

test('Phase 3 administrative API authenticates and handles start/stop', async () => {
  const fixture = createFixture();
  const monitor = new ApplicationRuntimeMonitor(fixture.lifecycle);
  const api = new ApplicationManagementApi(monitor, {
    port: 0, bearerToken: 'super-secret-management-token',
  });
  await api.start();
  try {
    const addr = api.http.address();
    if (!addr || typeof addr === 'string') throw new Error('Missing API address');
    const url = `http://127.0.0.1:${addr.port}`;
    const unauthorized = await fetch(url + '/applications');
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: 'Bearer super-secret-management-token' };
    const list = await fetch(url + '/applications', { headers });
    assert.equal(list.status, 200);
    const started = await fetch(url + '/applications/payment-service/start', {
      method: 'POST', headers,
    });
    assert.equal(started.status, 200);
    assert.equal(fixture.status, 'RUNNING');
    const stopped = await fetch(url + '/applications/payment-service/stop', {
      method: 'POST', headers,
    });
    assert.equal(stopped.status, 200);
    assert.equal(fixture.status, 'STOPPED');
    const malformed = await fetch(url + '/applications/payment-service/activate', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: '{"version":true}',
    });
    assert.equal(malformed.status, 400);
  } finally {
    await api.stop();
    monitor.close();
  }
});

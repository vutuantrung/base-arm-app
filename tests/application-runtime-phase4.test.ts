import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { RuntimeStateStore } from '../packages/adapter-process/src/runtime-state-store.js';
import { ApplicationRuntimeMonitor } from '../packages/adapter-process/src/application-runtime-monitor.js';
import type { ApplicationLifecycleManager, ApplicationRuntimeView } from '../packages/adapter-process/src/application-lifecycle-manager.js';
import type { InstalledRelease } from '../packages/adapter-process/src/deployment/deployment-types.js';

function createLifecycle() {
  const processes = new EventEmitter();
  let mode: 'RUNNING' | 'STOPPED' = 'STOPPED';
  let pid = 100;
  let starts = 0;
  const current = (): ApplicationRuntimeView => ({
    applicationId: 'payment-service',
    version: '1.0.0',
    process: { id: 'payment-service', status: mode, pid: mode === 'RUNNING' ? pid : undefined, adopted: false },
    readiness: 'NOT_CONFIGURED',
  });
  const release = { manifest: { lifecycle: {
    restartPolicy: 'on-failure', maxRestarts: 2, stopTimeoutMs: 1000,
  } } } as InstalledRelease;
  const lifecycle = {
    processes,
    storage: { readRelease: async () => release },
    listApplications: async () => [current()],
    inspectApplication: async () => current(),
    startApplication: async () => { mode = 'RUNNING'; starts++; pid++; return current(); },
    stopApplication: async () => { mode = 'STOPPED'; return current(); },
    restartApplication: async () => { mode = 'RUNNING'; starts++; pid++; return current(); },
    activateRelease: async () => {},
    close: () => {},
  } as unknown as ApplicationLifecycleManager;
  return {
    lifecycle,
    get starts() { return starts; },
    kill(code: number | null = null, signal: NodeJS.Signals | null = 'SIGKILL') {
      mode = 'STOPPED';
      processes.emit('exit', { id: 'payment-service', code, signal });
    },
  };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('durable desired state, backoff and retry attempts survive Supervisor recreation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arm-phase4-'));
  const fixture = createLifecycle();
  const store = new RuntimeStateStore(dir);
  const options = { restartBaseDelayMs: 30, restartMaxDelayMs: 60, intervalMs: 10 };
  let first: ApplicationRuntimeMonitor | undefined;
  let second: ApplicationRuntimeMonitor | undefined;
  try {
    first = new ApplicationRuntimeMonitor(fixture.lifecycle, options, store);
    await first.startApplication('payment-service');
    fixture.kill();
    await first.tick();
    const scheduled = await first.inspectApplication('payment-service');
    assert.equal(scheduled.recovery.state, 'SCHEDULED');
    assert.equal(scheduled.recovery.desired, 'RUNNING');
    assert.equal((await store.read('payment-service'))?.recoveryState, 'SCHEDULED');
    first.close();

    second = new ApplicationRuntimeMonitor(fixture.lifecycle, options, store);
    await second.restoreRunningApplications();
    const restored = await second.inspectApplication('payment-service');
    assert.equal(restored.recovery.state, 'SCHEDULED');
    assert.equal(restored.recovery.nextAttemptAt, scheduled.recovery.nextAttemptAt);
    await sleep(50);
    await second.tick();
    assert.equal(fixture.starts, 2);
    assert.equal((await store.read('payment-service'))?.attempts, 1);

    await second.stopApplication('payment-service');
    second.close();
    second = new ApplicationRuntimeMonitor(fixture.lifecycle, options, store);
    await second.restoreRunningApplications();
    assert.equal((await second.inspectApplication('payment-service')).recovery.desired, 'STOPPED');
    await sleep(50);
    await second.tick();
    assert.equal(fixture.starts, 2);
    const file = JSON.parse(await readFile(join(dir, 'applications/payment-service/runtime-state.json'), 'utf8'));
    assert.equal(file.schemaVersion, 1);
  } finally {
    second?.close();
    first?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('exit code zero is a completed run for on-failure policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arm-phase4-'));
  const fixture = createLifecycle();
  const monitor = new ApplicationRuntimeMonitor(fixture.lifecycle, {
    restartBaseDelayMs: 10, restartMaxDelayMs: 20,
  }, new RuntimeStateStore(dir));
  try {
    await monitor.startApplication('payment-service');
    fixture.kill(0, null);
    await monitor.tick();
    assert.equal(fixture.starts, 1);
    assert.equal((await monitor.inspectApplication('payment-service')).recovery.desired, 'STOPPED');
    assert.equal((await monitor.inspectApplication('payment-service')).recovery.state, 'IDLE');
  } finally {
    monitor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('RuntimeStateStore rejects malformed records instead of resetting crash budgets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arm-phase4-'));
  const store = new RuntimeStateStore(dir);
  try {
    await assert.rejects(store.write({
      schemaVersion: 1,
      applicationId: '../escape',
      releaseVersion: '1.0.0',
      desired: 'RUNNING',
      recoveryState: 'IDLE',
      attempts: 0,
      updatedAt: new Date().toISOString(),
    }), /Invalid/);
    assert.equal(await store.read('payment-service'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeRolloutManager } from '../packages/adapter-process/src/safe-rollout-manager.js';
import { ApplicationReleaseManager } from '../packages/adapter-process/src/application-release-manager.js';
import { ApplicationManagementApi } from '../packages/adapter-process/src/application-management-api.js';
import type { ApplicationRuntimeMonitor, RuntimeMonitorStatus } from '../packages/adapter-process/src/application-runtime-monitor.js';
import type { InstalledRelease } from '../packages/adapter-process/src/deployment/deployment-types.js';

async function inWorkspace(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arm-phase6-'));
  try { await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function fakeRuntime() {
  let version = '1.0.0';
  let running = true;
  let failNewStart = false;
  let unhealthy = false;
  let paused = false;
  const actions: string[] = [];
  const inspect = (): RuntimeMonitorStatus => ({
    application: {
      applicationId: 'payment-service', version,
      process: { id: 'payment-service', status: running ? 'RUNNING' : 'STOPPED', adopted: false },
      readiness: running ? (unhealthy ? 'UNHEALTHY' : 'HEALTHY') : 'UNKNOWN',
    },
    recovery: { state: running ? 'IDLE' : 'MANUALLY_STOPPED', desired: running ? 'RUNNING' : 'STOPPED', attempts: 0 },
  });
  const monitor = {
    lifecycle: {
      async listApplications() { return [inspect().application]; },
    },
    async inspectApplication() { return inspect(); },
    async listApplications() { return [inspect()]; },
    async pauseRecovery() { paused = true; actions.push('pause'); },
    resumeRecovery() { paused = false; actions.push('resume'); },
    async stopApplication() { running = false; actions.push('stop'); return inspect(); },
    async activateRelease(_id: string, target: string) {
      if (running) throw new Error('Stop application before changing its release');
      version = target;
      actions.push('activate:' + target);
    },
    async startApplication() {
      actions.push('start:' + version);
      if (failNewStart && version === '1.1.0') throw new Error('Startup failed');
      running = true;
      return inspect();
    },
  } as unknown as ApplicationRuntimeMonitor;
  return {
    monitor, actions,
    get version() { return version; },
    get running() { return running; },
    get paused() { return paused; },
    failNewStart() { failNewStart = true; },
    setUnhealthy(flag: boolean) { unhealthy = flag; },
    resetToIncomplete() { version = '1.1.0'; running = true; },
  };
}

async function installFakeRelease(root: string, version: string, armEnabled = true): Promise<void> {
  const directory = join(root, 'applications', 'payment-service', 'releases', version);
  await mkdir(directory, { recursive: true });
  const metadata = {
    applicationId: 'payment-service', version, directory,
    entry: join(directory, 'main.js'), sha256: 'test', installedAt: new Date().toISOString(),
    manifest: { arm: { enabled: armEnabled }, lifecycle: { stopTimeoutMs: 1000 } },
  } as InstalledRelease;
  await writeFile(join(directory, '.deployment.json'), JSON.stringify(metadata));
}

test('Phase 6 rollout commits verified release, journals checkpoints and pauses recovery', async () => {
  await inWorkspace(async root => {
    await installFakeRelease(root, '1.1.0');
    const fake = fakeRuntime();
    const releases = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    const rollout = new SafeRolloutManager(fake.monitor, releases, root,
      { stabilityWindowMs: 20, pollMs: 5 });
    const result = await rollout.rollout('payment-service', { version: '1.1.0' });
    assert.equal(result.phase, 'SUCCEEDED');
    assert.equal(fake.version, '1.1.0');
    assert.equal(fake.running, true);
    assert.equal(fake.paused, false);
    assert.ok(fake.actions.indexOf('stop') < fake.actions.indexOf('activate:1.1.0'));
    assert.ok(fake.actions.indexOf('activate:1.1.0') < fake.actions.indexOf('start:1.1.0'));
    const record = JSON.parse(await readFile(join(root, 'applications/payment-service/rollout.json'), 'utf8'));
    assert.equal(record.phase, 'SUCCEEDED');
    assert.equal((await releases.history.list('payment-service')).length, 1);
  });
});

test('Phase 6 failed start compensates to previous RUNNING version', async () => {
  await inWorkspace(async root => {
    await installFakeRelease(root, '1.1.0');
    const fake = fakeRuntime();
    fake.failNewStart();
    const releases = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    const rollout = new SafeRolloutManager(fake.monitor, releases, root,
      { stabilityWindowMs: 10, pollMs: 5 });
    const result = await rollout.rollout('payment-service', { version: '1.1.0' });
    assert.equal(result.phase, 'ROLLED_BACK');
    assert.equal(fake.version, '1.0.0');
    assert.equal(fake.running, true);
    assert.ok(result.error?.includes('Startup failed'));
    assert.equal(fake.paused, false);
  });
});

test('Phase 6 replays unfinished journal conservatively on daemon restart', async () => {
  await inWorkspace(async root => {
    await installFakeRelease(root, '1.1.0');
    const fake = fakeRuntime();
    fake.resetToIncomplete();
    const releases = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    const manager = new SafeRolloutManager(fake.monitor, releases, root,
      { stabilityWindowMs: 10, pollMs: 5 });
    const now = new Date().toISOString();
    await manager.journal.write({
      schemaVersion: 1, operationId: 'fixture-1', applicationId: 'payment-service',
      fromVersion: '1.0.0', toVersion: '1.1.0', previousDesired: 'RUNNING',
      allowProcessOnly: false, phase: 'VERIFYING', createdAt: now, updatedAt: now,
    });
    const recovered = await manager.recoverIncompleteRollouts();
    assert.equal(recovered[0].phase, 'ROLLED_BACK');
    assert.equal(fake.version, '1.0.0');
    assert.equal(fake.running, true);
    assert.deepEqual(await manager.recoverIncompleteRollouts(), []);
  });
});

test('Phase 6 rejects non-ARM rollout unless process-only mode is explicitly enabled', async () => {
  await inWorkspace(async root => {
    await installFakeRelease(root, '1.1.0', false);
    const fake = fakeRuntime();
    const releases = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    const manager = new SafeRolloutManager(fake.monitor, releases, root);
    await assert.rejects(
      manager.rollout('payment-service', { version: '1.1.0' }),
      /ARM readiness required/,
    );
    assert.equal(fake.version, '1.0.0');
  });
});

test('Phase 6 HTTP route validates token and returns rollout operation', async () => {
  await inWorkspace(async root => {
    await installFakeRelease(root, '1.1.0');
    const fake = fakeRuntime();
    const releases = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    const rollout = new SafeRolloutManager(fake.monitor, releases, root,
      { stabilityWindowMs: 10, pollMs: 5 });
    const api = new ApplicationManagementApi(fake.monitor, {
      bearerToken: 'long-test-rollout-secret',
      port: 0, releaseManager: releases, rolloutManager: rollout,
    });
    await api.start();
    try {
      const address = api.http.address();
      if (!address || typeof address === 'string') throw new Error('Missing API port');
      const url = `http://127.0.0.1:${address.port}/applications/payment-service/rollout`;
      assert.equal((await fetch(url)).status, 401);
      const headers = { authorization: 'Bearer long-test-rollout-secret', 'content-type': 'application/json' };
      const started = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify({ version: '1.1.0' }),
      });
      assert.equal(started.status, 200);
      assert.equal((await started.json() as {phase: string}).phase, 'SUCCEEDED');
      assert.equal((await fetch(url, { headers })).status, 200);
    } finally {
      await api.stop();
    }
  });
});

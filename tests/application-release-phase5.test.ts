import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationReleaseManager } from '../packages/adapter-process/src/application-release-manager.js';
import { ApplicationManagementApi } from '../packages/adapter-process/src/application-management-api.js';
import type { ApplicationRuntimeMonitor } from '../packages/adapter-process/src/application-runtime-monitor.js';
import type { ApplicationRuntimeView } from '../packages/adapter-process/src/application-lifecycle-manager.js';
import type { DeploymentReceipt } from '../packages/adapter-process/src/deployment/deployment-types.js';

async function fixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'arm-phase5-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function mockMonitor() {
  let version: string | undefined;
  let running = false;
  const changed: string[] = [];
  const current = (): ApplicationRuntimeView[] => version ? [{
    applicationId: 'payment-service',
    version,
    process: { id: 'payment-service', status: running ? 'RUNNING' : 'STOPPED', adopted: false },
    readiness: 'NOT_CONFIGURED',
  }] : [];
  const monitor = {
    lifecycle: { listApplications: async () => current() },
    async activateRelease(_id: string, nextVersion: string) {
      if (running) throw new Error('Stop application before changing its release');
      version = nextVersion;
      changed.push(nextVersion);
    },
    async inspectApplication() {
      return { application: current()[0], recovery: { state: 'MANUALLY_STOPPED', attempts: 0 } };
    },
    async listApplications() { return current().map(application => ({
      application, recovery: { state: 'IDLE', attempts: 0 },
    })); },
  } as unknown as ApplicationRuntimeMonitor;
  return { monitor, changed, setRunning(value: boolean) { running = value; },
    get version() { return version; } };
}

test('Phase 5 records activation history, rollback and rejects running release switches', async () => {
  await fixture(async root => {
    const fake = mockMonitor();
    const manager = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    const first = await manager.activateRelease('payment-service', '1.0.0');
    assert.equal(first?.fromVersion, undefined);
    assert.equal(fake.version, '1.0.0');
    const second = await manager.activateRelease('payment-service', '1.1.0');
    assert.equal(second?.fromVersion, '1.0.0');
    fake.setRunning(true);
    await assert.rejects(manager.rollbackRelease('payment-service'), /Stop application/);
    assert.equal(fake.version, '1.1.0');
    fake.setRunning(false);
    const back = await manager.rollbackRelease('payment-service');
    assert.equal(back.fromVersion, '1.1.0');
    assert.equal(back.toVersion, '1.0.0');
    assert.deepEqual(fake.changed, ['1.0.0', '1.1.0', '1.0.0']);
    assert.equal((await manager.history.list('payment-service')).length, 3);
    const audit = await manager.listAudit('payment-service');
    assert.equal(audit[0].action, 'ROLLBACK');
    assert.equal(audit[0].outcome, 'SUCCEEDED');
    assert.equal(audit[1].outcome, 'FAILED');
  });
});

test('Phase 5 accepts authenticated binary ZIP upload and enforces streaming limit', async () => {
  await fixture(async root => {
    const fake = mockMonitor();
    const releases = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    let received: Buffer | undefined;
    releases.deployments.installZip = async path => {
      received = await readFile(path);
      return {
        alreadyInstalled: false,
        release: {
          applicationId: 'payment-service',
          version: '1.0.0',
          directory: root,
          entry: join(root, 'dist/main.js'),
          sha256: 'test',
          installedAt: new Date().toISOString(),
          manifest: {} as DeploymentReceipt['release']['manifest'],
        },
      };
    };
    const api = new ApplicationManagementApi(fake.monitor, {
      bearerToken: 'a-very-long-secret-token',
      releaseManager: releases,
      maxUploadBytes: 1024,
      port: 0,
    });
    await api.start();
    try {
      const addr = api.http.address();
      if (!addr || typeof addr === 'string') throw new Error('No bound address');
      const base = `http://127.0.0.1:${addr.port}`;
      const token = { authorization: 'Bearer a-very-long-secret-token' };
      const denied = await fetch(base + '/deployments/upload', {
        method: 'POST', headers: { 'content-type': 'application/zip' }, body: Buffer.from('fake'),
      });
      assert.equal(denied.status, 401);
      const accepted = await fetch(base + '/deployments/upload', {
        method: 'POST', headers: { ...token, 'content-type': 'application/zip' },
        body: Buffer.from('example-zip-bytes'),
      });
      assert.equal(accepted.status, 201);
      assert.equal(received?.toString(), 'example-zip-bytes');
      const rejected = await fetch(base + '/deployments/upload', {
        method: 'POST', headers: { ...token, 'content-type': 'application/zip' },
        body: Buffer.alloc(2048),
      });
      assert.equal(rejected.status, 413);
      const audit = await fetch(base + '/deployments/audit', { headers: token });
      assert.equal(audit.status, 200);
    } finally {
      await api.stop();
    }
  });
});

test('Phase 5 refuses rollback without activation history', async () => {
  await fixture(async root => {
    const fake = mockMonitor();
    const manager = new ApplicationReleaseManager(fake.monitor, { storageRoot: root });
    await assert.rejects(manager.rollbackRelease('payment-service'), /No active release/);
    assert.equal((await manager.listAudit('payment-service'))[0].outcome, 'FAILED');
  });
});

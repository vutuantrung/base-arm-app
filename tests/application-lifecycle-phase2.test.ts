import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationLifecycleManager } from '../packages/adapter-process/src/application-lifecycle-manager.js';
import type { ApplicationManifest, InstalledRelease } from '../packages/adapter-process/src/deployment/deployment-types.js';

function manifest(version: string): ApplicationManifest {
  return {
    schemaVersion: '1.0',
    applicationId: 'payment-service',
    version,
    runtime: { type: 'nodejs', nodeVersion: '>=22', entry: 'dist/main.js' },
    install: { strategy: 'npm-ci', buildRequired: false },
    arm: { enabled: false },
    lifecycle: {
      autoStart: false,
      restartPolicy: 'never',
      maxRestarts: 0,
      stopTimeoutMs: 5000,
    },
  };
}

async function createInstalledRelease(storageRoot: string, version: string): Promise<InstalledRelease> {
  const directory = join(storageRoot, 'applications', 'payment-service', 'releases', version);
  await mkdir(join(directory, 'dist'), { recursive: true });
  const release: InstalledRelease = {
    applicationId: 'payment-service',
    version,
    directory,
    entry: join(directory, 'dist/main.js'),
    sha256: 'test-' + version,
    installedAt: new Date().toISOString(),
    manifest: manifest(version),
  };
  await writeFile(release.entry, 'setInterval(() => {}, 1000);\n');
  await writeFile(join(directory, '.deployment.json'), JSON.stringify(release));
  return release;
}

test('Phase 2 activation starts, inspects, restarts and stops installed Node.js app', async () => {
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(join(tmpdir(), 'arm-phase2-'));
  const manager = new ApplicationLifecycleManager({ storageRoot: root });
  let pid: number | undefined;
  try {
    await createInstalledRelease(root, '1.0.0');
    await manager.initialize();
    const selected = await manager.activateRelease('payment-service', '1.0.0');
    assert.equal(selected.version, '1.0.0');
    assert.deepEqual(await manager.storage.listReleases('payment-service').then(x => x.map(y => y.version)), ['1.0.0']);
    const started = await manager.startApplication('payment-service');
    pid = started.process.pid;
    assert.equal(started.process.status, 'RUNNING');
    assert.equal(started.readiness, 'NOT_CONFIGURED');
    assert.equal((await manager.startApplication('payment-service')).process.pid, pid);
    assert.equal((await manager.inspectApplication('payment-service')).version, '1.0.0');

    await createInstalledRelease(root, '1.1.0');
    await assert.rejects(manager.activateRelease('payment-service', '1.1.0'), /Stop application/);
    const restarted = await manager.restartApplication('payment-service');
    assert.equal(restarted.process.status, 'RUNNING');
    assert.notEqual(restarted.process.pid, pid);
    pid = restarted.process.pid;
    const stopped = await manager.stopApplication('payment-service');
    assert.equal(stopped.process.status, 'STOPPED');
    pid = undefined;
    const activated = await manager.activateRelease('payment-service', '1.1.0');
    assert.equal(activated.version, '1.1.0');
    assert.equal(JSON.parse(await readFile(join(root, 'applications/payment-service/active.json'), 'utf8')).version, '1.1.0');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Phase 2 preserves active release and adopts detached PID on Supervisor restart', async () => {
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(join(tmpdir(), 'arm-phase2-'));
  const first = new ApplicationLifecycleManager({ storageRoot: root });
  let second: ApplicationLifecycleManager | undefined;
  let pid: number | undefined;
  try {
    await createInstalledRelease(root, '1.0.0');
    await first.initialize();
    await first.activateRelease('payment-service', '1.0.0');
    pid = (await first.startApplication('payment-service')).process.pid;
    first.close();
    second = new ApplicationLifecycleManager({ storageRoot: root });
    await second.initialize();
    const inspected = await second.inspectApplication('payment-service');
    assert.equal(inspected.version, '1.0.0');
    assert.equal(inspected.process.adopted, true);
    assert.equal(inspected.process.pid, pid);
    await second.stopApplication('payment-service');
    pid = undefined;
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    second?.close();
    first.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Phase 2 rejects activation of missing release and requires initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-phase2-'));
  const manager = new ApplicationLifecycleManager({ storageRoot: root });
  try {
    await assert.rejects(manager.startApplication('payment-service'), /initialize/);
    await manager.initialize();
    await assert.rejects(manager.activateRelease('payment-service', '1.0.0'), /not found/);
    await assert.rejects(manager.activateRelease('bad\/id', '1.0.0'), /Invalid application/);
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

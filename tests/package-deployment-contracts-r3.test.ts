import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackageCatalog, ReleaseSelector } from '../packages/contracts/src/index.js';
import {
  ApplicationStorage, PackageCatalogAdapter, DeploymentManager, validateApplicationManifest,
} from '../packages/package-manager/src/index.js';
import {
  ApplicationReleaseManager, ReleaseSelectorAdapter, ReleaseHistoryStore,
  RolloutJournal, DeploymentAuditLog,
} from '../packages/deployment-manager/src/index.js';
import type { ReleaseRuntimePort } from '../packages/deployment-manager/src/index.js';
import { DeploymentManager as OldDeploymentManager } from '../packages/adapter-process/src/deployment/deployment-manager.js';
import { ApplicationReleaseManager as OldReleaseManager } from '../packages/adapter-process/src/application-release-manager.js';
import { SafeRolloutManager as OldRolloutManager } from '../packages/adapter-process/src/safe-rollout-manager.js';
import { SafeRolloutManager } from '../packages/deployment-manager/src/index.js';
import { validateApplicationManifest as OldValidator } from '../packages/adapter-process/src/deployment/application-package-validator.js';

async function fixture(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arm-r3-modules-'));
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function makeRelease(root: string, version: string): Promise<void> {
  const dir = join(root, 'applications', 'payment-service', 'releases', version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.deployment.json'), JSON.stringify({
    applicationId: 'payment-service', version,
    directory: dir, entry: join(dir, 'main.js'),
    sha256: 'test', installedAt: new Date().toISOString(),
    manifest: { schemaVersion: '1.0', arm: { enabled: false } },
  }));
}

test('R3 compatibility re-exports preserve implementation identity', () => {
  assert.equal(OldDeploymentManager, DeploymentManager);
  assert.equal(OldReleaseManager, ApplicationReleaseManager);
  assert.equal(OldRolloutManager, SafeRolloutManager);
  assert.equal(OldValidator, validateApplicationManifest);
});

test('R3 PackageCatalogAdapter projects immutable release metadata', async () => {
  await fixture(async root => {
    await makeRelease(root, '1.0.0');
    await makeRelease(root, '1.1.0');
    const catalog: PackageCatalog = new PackageCatalogAdapter(new ApplicationStorage(root));
    assert.equal((await catalog.getRelease('payment-service', '1.0.0'))?.version, '1.0.0');
    const releases = await catalog.listReleases('payment-service');
    assert.deepEqual(releases.map(item => item.version).sort(), ['1.0.0', '1.1.0']);
    assert.equal(await catalog.getRelease('payment-service', '9.0.0'), undefined);
    assert.equal((await catalog.getRelease('payment-service', '1.1.0'))?.directory,
      join(root, 'applications', 'payment-service', 'releases', '1.1.0'));
  });
});

test('R3 ReleaseSelectorAdapter preserves activation, audit and rollback policy', async () => {
  await fixture(async root => {
    await makeRelease(root, '1.0.0');
    await makeRelease(root, '1.1.0');
    let active: string | undefined;
    let running = false;
    const runtime: ReleaseRuntimePort = {
      lifecycle: { async listApplications() {
        return active ? [{ applicationId: 'payment-service', version: active }] : [];
      }},
      async activateRelease(_applicationId, version) {
        if (running) throw new Error('Stop application before changing its release');
        active = version;
      },
    };
    const catalog: PackageCatalog = new PackageCatalogAdapter(new ApplicationStorage(root));
    const releaseManager = new ApplicationReleaseManager(runtime, { storageRoot: root });
    const selector: ReleaseSelector = new ReleaseSelectorAdapter(releaseManager, runtime, catalog);

    assert.equal(await selector.activeRelease('payment-service'), undefined);
    await selector.activate('payment-service', '1.0.0');
    assert.equal((await selector.activeRelease('payment-service'))?.version, '1.0.0');
    await selector.activate('payment-service', '1.1.0');
    running = true;
    await assert.rejects(selector.activate('payment-service', '1.0.0'), /Stop application/);
    running = false;
    const back = await releaseManager.rollbackRelease('payment-service');
    assert.equal(back.toVersion, '1.0.0');
    assert.equal((await selector.activeRelease('payment-service'))?.version, '1.0.0');
    const audit = await releaseManager.listAudit('payment-service');
    assert.equal(audit[0].action, 'ROLLBACK');
    assert.ok(audit.some(entry => entry.outcome === 'FAILED'));
    assert.equal((await releaseManager.history.list('payment-service')).length, 3);
  });
});

test('R3 keeps persisted rollout/history/audit formats and locations unchanged', async () => {
  await fixture(async root => {
    const history = new ReleaseHistoryStore(root);
    const journal = new RolloutJournal(root);
    const audit = new DeploymentAuditLog(root);
    await history.record('payment-service', {
      action: 'ACTIVATE', toVersion: '1.0.0',
      changedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    await journal.write({
      schemaVersion: 1, operationId: 'r3-checkpoint',
      applicationId: 'payment-service', fromVersion: '1.0.0',
      toVersion: '1.1.0', previousDesired: 'RUNNING',
      allowProcessOnly: false, phase: 'PREPARED',
      createdAt: now, updatedAt: now,
    });
    await audit.append({
      action: 'ACTIVATE', outcome: 'SUCCEEDED',
      applicationId: 'payment-service', version: '1.0.0',
    });
    assert.equal((await journal.read('payment-service'))?.phase, 'PREPARED');
    assert.equal((await history.list('payment-service')).length, 1);
    assert.equal((await audit.list('payment-service')).length, 1);
    const raw = await readFile(join(root, 'applications', 'payment-service', 'rollout.json'), 'utf8');
    assert.equal(JSON.parse(raw).schemaVersion, 1);
  });
});

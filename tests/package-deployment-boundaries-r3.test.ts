import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('R3 package module owns ZIP and immutable release implementation', async () => {
  const manager = await readFile(resolve('packages/package-manager/src/deployment-manager.ts'), 'utf8');
  const storage = await readFile(resolve('packages/package-manager/src/application-storage.ts'), 'utf8');
  assert.match(manager, /class DeploymentManager/);
  assert.match(storage, /class ApplicationStorage/);
  assert.doesNotMatch(manager + storage,
    /(?:from|import) ['"][^'"]*(?:adapter-process|application-runtime-monitor|safe-rollout-manager|process-manager)[^'"]*['"]/);
});

test('R3 deployment module depends on runtime ports instead of concrete monitor', async () => {
  const release = await readFile(resolve('packages/deployment-manager/src/application-release-manager.ts'), 'utf8');
  const rollout = await readFile(resolve('packages/deployment-manager/src/safe-rollout-manager.ts'), 'utf8');
  assert.match(release, /ReleaseRuntimePort/);
  assert.match(rollout, /RolloutRuntimePort/);
  assert.match(rollout, /ReleaseOperationsPort/);
  assert.doesNotMatch(release + rollout, /from ['"][^'"]*application-runtime-monitor/);
});

test('R3 compatibility paths are re-exports without duplicate logic', async () => {
  const oldPackageNames = [
    'deployment-manager', 'application-storage', 'application-installer',
    'application-package-extractor', 'application-package-validator', 'deployment-types',
  ];
  for (const name of oldPackageNames) {
    const source = await readFile(resolve(`packages/adapter-process/src/deployment/${name}.ts`), 'utf8');
    assert.equal(source.trim(), `export * from '../../../package-manager/src/${name}.js';`);
  }
  const oldDeploymentNames = [
    'application-release-manager', 'release-history-store',
    'deployment-audit-log', 'rollout-journal', 'safe-rollout-manager',
  ];
  for (const name of oldDeploymentNames) {
    const source = await readFile(resolve(`packages/adapter-process/src/${name}.ts`), 'utf8');
    assert.equal(source.trim(), `export * from '../../deployment-manager/src/${name}.js';`);
  }
});

test('R3 public entrypoints expose intended contracts and implementations', async () => {
  const pkg = await readFile(resolve('packages/package-manager/src/index.ts'), 'utf8');
  const dep = await readFile(resolve('packages/deployment-manager/src/index.ts'), 'utf8');
  assert.ok(pkg.includes('PackageCatalogAdapter'));
  assert.ok(pkg.includes('DeploymentManager'));
  assert.ok(pkg.includes('ApplicationStorage'));
  assert.ok(dep.includes('ReleaseSelectorAdapter'));
  assert.ok(dep.includes('ApplicationReleaseManager'));
  assert.ok(dep.includes('SafeRolloutManager'));
  assert.ok(dep.includes('RolloutJournal'));
});

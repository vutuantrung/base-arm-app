import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSupervisorPaths } from '../packages/supervisor-host/src/index.js';
import { ArmRuntimeInjector } from '../packages/runtime-injection/src/index.js';

test('SEA paths do not depend on launch working directory', () => {
  const base = resolve('portable ARM');
  const paths = resolveSupervisorPaths({}, {
    packaged: true, executable: join(base, 'arm-supervisor.exe'),
    workingDirectory: resolve('elsewhere'),
  });
  assert.equal(paths.environmentFile, join(base, '.env'));
  assert.equal(paths.storageRoot, join(base, 'supervisor-data'));
  assert.equal(paths.nodeExecutable, join(base, 'runtime', 'node.exe'));
  assert.equal(paths.runtimeAssets, join(base, 'runtime-assets'));
});

test('source defaults and absolute overrides remain compatible', () => {
  const cwd = resolve('source');
  const data = resolve('custom-data');
  const context = { packaged: false, executable: process.execPath, workingDirectory: cwd };
  const defaults = resolveSupervisorPaths({}, context);
  assert.equal(defaults.storageRoot, join(cwd, 'supervisor-data'));
  assert.equal(defaults.runtimeAssets, undefined);
  assert.equal(defaults.nodeExecutable, undefined);
  const custom = resolveSupervisorPaths({
    ARM_DEPLOYMENT_ROOT: data, ARM_NODE_EXECUTABLE: 'runtime/node.exe',
    ARM_NPM_CLI: 'runtime/npm-cli.js', DOTENV_CONFIG_PATH: 'config/local.env',
    ARM_RUNTIME_ASSETS: 'assets',
  }, context);
  assert.equal(custom.storageRoot, data);
  assert.equal(custom.nodeExecutable, join(cwd, 'runtime/node.exe'));
  assert.equal(custom.npmCli, join(cwd, 'runtime/npm-cli.js'));
  assert.equal(custom.environmentFile, join(cwd, 'config/local.env'));
  assert.equal(custom.runtimeAssets, join(cwd, 'assets'));
});

test('explicit assets distinguish automatic and bridge preloads and prohibit fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm assets '));
  try {
    const preloads = join(root, 'preloads');
    await mkdir(preloads);
    const bootstrap = join(preloads, 'bootstrap.mjs');
    const bridge = join(preloads, 'bridge-bootstrap.mjs');
    await writeFile(bootstrap, '');
    await writeFile(bridge, '');
    const sdk = join(root, 'dist/packages/arm-client-sdk/src/arm-runtime.js');
    await mkdir(join(root, 'dist/packages/arm-client-sdk/src'), { recursive: true });
    await writeFile(sdk, '');
    const injector = new ArmRuntimeInjector({
      mode: 'bridge', telemetryRoot: join(root, 'telemetry'), runtimeAssets: root,
      bridgeApplicationId: 'aab', bridgeMetricsBasePort: 3500,
      bridgeRegistrationUrl: 'http://127.0.0.1:3200/',
      bridgeRegistrationToken: 'registration-secret-123',
      bridgeMetricsToken: 'metrics-secret-456',
    });
    const specifier = (file: string) => process.platform === 'win32' ? pathToFileURL(file).href : file;
    assert.deepEqual(injector.nodeArguments('entry.js', [], 'aab'), ['--import', specifier(bridge), 'entry.js']);
    assert.deepEqual(injector.nodeArguments('entry.js', [], 'other'), ['--import', specifier(bootstrap), 'entry.js']);
    assert.equal(injector.environment('aab', 'aab-managed').ARM_BRIDGE_MODULE_PATH, sdk);
    await rm(sdk);
    assert.throws(() => injector.environment('aab', 'aab-managed'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

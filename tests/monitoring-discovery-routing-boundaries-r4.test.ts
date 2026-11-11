import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const modules = {
  'runtime-monitor': ['application-runtime-monitor', 'runtime-state-store'],
  'service-discovery': [
    'application-endpoint-discovery', 'application-registry',
    'remote-arm-metrics-collector', 'application-registration-server',
    'application-registration-client',
  ],
  'traffic-router': ['blue-green-http-proxy'],
};

test('R4 legacy entrypoints are only compatibility re-exports', async () => {
  for (const [module, names] of Object.entries(modules)) {
    for (const name of names) {
      const old = await readFile(resolve(`packages/adapter-process/src/${name}.ts`), 'utf8');
      assert.equal(old.trim(), `export * from '../../${module}/src/${name}.js';`);
    }
  }
});

test('R4 monitoring and HTTP discovery do not depend on concrete orchestration managers', async () => {
  const monitor = await readFile(resolve('packages/runtime-monitor/src/application-runtime-monitor.ts'), 'utf8');
  const discovery = await readFile(resolve('packages/service-discovery/src/application-endpoint-discovery.ts'), 'utf8');
  assert.match(monitor, /RuntimeLifecyclePort/);
  assert.match(discovery, /EndpointRuntimeReader/);
  assert.doesNotMatch(monitor, /from ['"][^'"]*application-lifecycle-manager/);
  assert.doesNotMatch(discovery, /from ['"][^'"]*blue-green-deployment-manager/);
});

test('R4 routing owns only traffic forwarding, not release selection or PID state', async () => {
  const proxy = await readFile(resolve('packages/traffic-router/src/blue-green-http-proxy.ts'), 'utf8');
  assert.match(proxy, /class BlueGreenHttpProxy/);
  assert.doesNotMatch(proxy, /from ['"][^'"]*(?:process-manager|deployment-manager|application-runtime-monitor)/);
});

test('R4 public API exports intended contract adapters', async () => {
  const modulesToExports = {
    'runtime-monitor': ['ApplicationRuntimeMonitor', 'RuntimeStateStore'],
    'service-discovery': ['ApplicationEndpointDiscovery', 'EndpointDirectoryAdapter', 'ApplicationRegistry'],
    'traffic-router': ['BlueGreenHttpProxy', 'BlueGreenTrafficRouterAdapter'],
  };
  for (const [module, names] of Object.entries(modulesToExports)) {
    const code = await readFile(resolve(`packages/${module}/src/index.ts`), 'utf8');
    for (const name of names) assert.ok(code.includes(name), `Missing ${module}.${name}`);
  }
});

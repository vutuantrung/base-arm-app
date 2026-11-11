import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import type { EndpointDirectory, TrafficRouter } from '../packages/contracts/src/index.js';
import { ApplicationRuntimeMonitor, RuntimeStateStore } from '../packages/runtime-monitor/src/index.js';
import type { RuntimeLifecyclePort } from '../packages/runtime-monitor/src/index.js';
import { ApplicationEndpointDiscovery, EndpointDirectoryAdapter, ApplicationRegistry, RemoteArmMetricsCollector } from '../packages/service-discovery/src/index.js';
import { BlueGreenHttpProxy, BlueGreenTrafficRouterAdapter } from '../packages/traffic-router/src/index.js';
import { ApplicationRuntimeMonitor as LegacyMonitor } from '../packages/adapter-process/src/application-runtime-monitor.js';
import { RuntimeStateStore as LegacyStore } from '../packages/adapter-process/src/runtime-state-store.js';
import { ApplicationEndpointDiscovery as LegacyDiscovery } from '../packages/adapter-process/src/application-endpoint-discovery.js';
import { ApplicationRegistry as LegacyRegistry } from '../packages/adapter-process/src/application-registry.js';
import { RemoteArmMetricsCollector as LegacyCollector } from '../packages/adapter-process/src/remote-arm-metrics-collector.js';
import { BlueGreenHttpProxy as LegacyProxy } from '../packages/adapter-process/src/blue-green-http-proxy.js';

test('R4 compatibility shims preserve class identity', () => {
  assert.equal(LegacyMonitor, ApplicationRuntimeMonitor);
  assert.equal(LegacyStore, RuntimeStateStore);
  assert.equal(LegacyDiscovery, ApplicationEndpointDiscovery);
  assert.equal(LegacyRegistry, ApplicationRegistry);
  assert.equal(LegacyCollector, RemoteArmMetricsCollector);
  assert.equal(LegacyProxy, BlueGreenHttpProxy);
});

test('R4 monitor stores desired state through a lifecycle structural port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-r4-monitor-'));
  const events = new (await import('node:events')).EventEmitter();
  let running = false;
  const lifecycle: RuntimeLifecyclePort = {
    processes: events,
    storage: { readRelease: async () => undefined },
    listApplications: async () => [{
      applicationId: 'payment-service', version: '1.0.0',
      process: { id: 'payment-service', status: running ? 'RUNNING' : 'STOPPED', adopted: false },
      readiness: 'NOT_CONFIGURED' as const,
    }],
    inspectApplication: async () => ({
      applicationId: 'payment-service', version: '1.0.0',
      process: { id: 'payment-service', status: running ? 'RUNNING' as const : 'STOPPED' as const, adopted: false },
      readiness: 'NOT_CONFIGURED' as const,
    }),
    startApplication: async () => {
      running = true;
      return lifecycle.inspectApplication('payment-service');
    },
    stopApplication: async () => {
      running = false;
      return lifecycle.inspectApplication('payment-service');
    },
    restartApplication: async () => {
      running = true;
      return lifecycle.inspectApplication('payment-service');
    },
    activateRelease: async () => undefined,
    close: () => {},
  };
  const monitor = new ApplicationRuntimeMonitor(lifecycle, {}, new RuntimeStateStore(root));
  try {
    await monitor.restoreRunningApplications();
    assert.equal((await monitor.inspectApplication('payment-service')).recovery.desired, 'STOPPED');
    await monitor.startApplication('payment-service');
    assert.equal((await monitor.inspectApplication('payment-service')).application.process.status, 'RUNNING');
    assert.equal((await new RuntimeStateStore(root).read('payment-service'))?.desired, 'RUNNING');
    await monitor.stopApplication('payment-service');
    assert.equal((await new RuntimeStateStore(root).read('payment-service'))?.desired, 'STOPPED');
  } finally {
    monitor.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('R4 EndpointDirectoryAdapter filters stopped instances and publishes responding HTTP endpoints', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.end('healthy'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral port');
  const port = address.port;
  const monitor = {
    listApplications: async () => [
      { application: { applicationId: 'payment-service', process: { id: 'payment-service', status: 'RUNNING' as const, adopted: false, port } } },
      { application: { applicationId: 'user-service', process: { id: 'user-service', status: 'STOPPED' as const, adopted: false } } },
    ],
  };
  const directory: EndpointDirectory = new EndpointDirectoryAdapter(new ApplicationEndpointDiscovery(monitor));
  try {
    const payment = await directory.find('payment-service');
    assert.equal(payment?.port, port);
    assert.equal(payment?.mode, 'singleton');
    assert.equal(await directory.find('user-service'), undefined);
    assert.equal((await directory.list()).length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('R4 TrafficRouterAdapter routes and drains the previous Blue/Green slot', async () => {
  const backendBlue = createServer((_req, res) => res.end('blue'));
  const backendGreen = createServer((_req, res) => res.end('green'));
  for (const server of [backendBlue, backendGreen]) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  const portOf = (server: typeof backendBlue) => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing backend address');
    return address.port;
  };
  const reserved = createServer();
  await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const proxyPort = portOf(reserved);
  await new Promise<void>(resolve => reserved.close(() => resolve()));
  const proxy = new BlueGreenHttpProxy(proxyPort);
  const router: TrafficRouter = new BlueGreenTrafficRouterAdapter('payment-service', proxy);
  const target = (slot: 'blue' | 'green', port: number) => ({
    applicationId: 'payment-service', instanceId: 'payment-service-' + slot,
    url: `http://127.0.0.1:${port}`, host: '127.0.0.1',
    port, mode: 'blue-green' as const,
  });
  try {
    await proxy.listen();
    await router.activate('payment-service', target('blue', portOf(backendBlue)));
    assert.equal(await (await fetch(`http://127.0.0.1:${proxyPort}`)).text(), 'blue');
    await router.activate('payment-service', target('green', portOf(backendGreen)));
    assert.equal(await (await fetch(`http://127.0.0.1:${proxyPort}`)).text(), 'green');
    assert.equal((await router.current('payment-service'))?.port, portOf(backendGreen));
    assert.equal(await router.drain('payment-service', 500), true);
    await assert.rejects(router.activate('other-service', target('blue', portOf(backendBlue))), /Unknown/);
  } finally {
    await proxy.close();
    await Promise.all([backendBlue, backendGreen].map(server =>
      new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

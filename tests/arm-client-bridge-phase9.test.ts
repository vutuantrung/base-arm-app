import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { ArmRuntimeInjector } from '../packages/adapter-process/src/arm-runtime-injector.js';
import { ProcessManager } from '../packages/adapter-process/src/process-manager.js';
import { ApplicationRegistry } from '../packages/adapter-process/src/application-registry.js';
import { RemoteArmMetricsCollector } from '../packages/adapter-process/src/remote-arm-metrics-collector.js';
import { ApplicationRegistrationServer } from '../packages/adapter-process/src/application-registration-server.js';

const registrationToken = 'registration-test-secret-123';
const metricsToken = 'metrics-test-secret-12345';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('Phase 9 bridge configuration validates independent credentials and safe scope', () => {
  assert.throws(() => new ArmRuntimeInjector({
    mode: 'bridge', telemetryRoot: '/tmp/arm', bridgeApplicationId: 'payment-service',
    bridgeMetricsBasePort: 3500, bridgeRegistrationUrl: 'http://127.0.0.1:3200/',
    bridgeRegistrationToken: 'short', bridgeMetricsToken: metricsToken,
  }), /two distinct tokens/);

  const injector = new ArmRuntimeInjector({
    mode: 'bridge', telemetryRoot: '/tmp/arm', bridgeApplicationId: 'payment-service',
    bridgeMetricsBasePort: 3500, bridgeRegistrationUrl: 'http://127.0.0.1:3200/',
    bridgeRegistrationToken: registrationToken, bridgeMetricsToken: metricsToken,
  });
  assert.equal(injector.nodeArguments('/tmp/service.js', [], 'payment-service')[0], '--import');
  assert.match(injector.nodeArguments('/tmp/service.js', [], 'payment-service')[1], /bridge-bootstrap\.mjs$/);
  assert.match(injector.nodeArguments('/tmp/other.js', [], 'another-service')[1], /bootstrap\.mjs$/);
  if (existsSync(resolve('dist/packages/library/src/arm-runtime.js'))) {
    const blueEnv = injector.environment('payment-service', 'payment-service-blue');
    assert.equal(blueEnv.ARM_BRIDGE_METRICS_PORT, '3501');
    assert.equal(blueEnv.ARM_BRIDGE_MODULE_PATH, resolve('dist/packages/library/src/arm-runtime.js'));
  } else {
    assert.throws(
      () => injector.environment('payment-service', 'payment-service-blue'),
      /Run npm run build first/,
    );
  }
  assert.equal(injector.environment('payment-service', 'payment-service-green').ARM_BRIDGE_METRICS_PORT, '3502');
  assert.equal(injector.environment('another-service', 'other-managed').ARM_BRIDGE_ENABLED, undefined);
});

test('Phase 9 bridges a plain Node child into real ARM Client metrics and registration', async t => {
  const built = resolve('dist/packages/library/src/arm-runtime.js');
  if (!existsSync(built)) {
    t.skip('Run npm run build first; bridge imports the compiled ARM Client SDK');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'arm-bridge-test-'));
  const port = await freePort();
  const metricsPort = await freePort();
  const collector = new RemoteArmMetricsCollector([], 100, 3000);
  const registry = new ApplicationRegistry(collector, metricsToken);
  const registrationServer = new ApplicationRegistrationServer(registry, collector, {
    token: registrationToken, port,
  });
  const injector = new ArmRuntimeInjector({
    mode: 'bridge',
    telemetryRoot: join(root, 'telemetry'),
    bridgeApplicationId: 'payment-service',
    bridgeMetricsBasePort: metricsPort,
    bridgeRegistrationUrl: `http://127.0.0.1:${port}/`,
    bridgeRegistrationToken: registrationToken,
    bridgeMetricsToken: metricsToken,
  });
  const manager = new ProcessManager(join(root, 'processes.json'), injector);
  try {
    await registrationServer.start();
    collector.start();
    const entry = join(root, 'app.mjs');
    await writeFile(entry, `setInterval(() => {}, 1000).unref();
process.on('SIGTERM', () => process.exit(0));
`);
    await manager.initialize([{
      id: 'payment-service', entry,
      env: { ARM_APPLICATION_ID: 'payment-service', ARM_INSTANCE_ID: 'payment-service-managed' },
    }]);
    await manager.start('payment-service');

    const deadline = Date.now() + 8000;
    let registered = false;
    while (Date.now() < deadline) {
      const item = registry.get('payment-service/payment-service-managed');
      if (item && collector.isFresh(item.id)) {
        registered = true;
        break;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    assert.equal(registered, true, 'ARM SDK should register and publish metrics');
    const metricResponse = await fetch(`http://127.0.0.1:${metricsPort}/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    assert.equal(metricResponse.status, 200);
    const snapshot = await metricResponse.json() as { metrics: Array<{ name: string }> };
    assert.ok(snapshot.metrics.some(item => item.name === 'process.uptime_seconds'));
    assert.equal((await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).status, 401);
  } finally {
    try { await manager.stop('payment-service', 3000); } catch {}
    manager.close();
    await registrationServer.stop().catch(() => {});
    registry.close();
    collector.stop();
    await rm(root, { recursive: true, force: true });
  }
});

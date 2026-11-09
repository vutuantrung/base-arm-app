import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from '../packages/core/src/metrics.js';
import { MetricsServer } from '../packages/adapter-http/src/server.js';
import { RemoteArmMetricsCollector } from '../packages/adapter-process/src/remote-arm-metrics-collector.js';
import { ApplicationRegistry } from '../packages/adapter-process/src/application-registry.js';
import { ApplicationRegistrationServer } from '../packages/adapter-process/src/application-registration-server.js';
import { ApplicationRegistrationClient } from '../packages/adapter-process/src/application-registration-client.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, maxMs = 5000) {
  const untilAt = Date.now() + maxMs;
  while (!predicate()) {
    if (Date.now() >= untilAt) throw new Error('Wait timed out');
    await wait(25);
  }
}

test('external app self-registers, Supervisor dynamically subscribes to metrics', async () => {
  const metrics = new MetricsRegistry();
  metrics.gauge('app.example.value', 42);
  const armServer = new MetricsServer(metrics, { port: 0 });
  await armServer.start();
  const armAddr = armServer.http.address();
  if (!armAddr || typeof armAddr === 'string') throw Error('ARM server address invalid');

  const collector = new RemoteArmMetricsCollector([], 100, 3000);
  const registry = new ApplicationRegistry(collector, undefined, 3000);
  const server = new ApplicationRegistrationServer(registry, collector, {
    token: 'test-registration-token',
    port: 0,
  });
  collector.start();
  await server.start();
  const address = server.http.address();
  if (!address || typeof address === 'string') throw Error('Supervisor address invalid');

  const client = new ApplicationRegistrationClient({
    applicationId: 'orders',
    instanceId: 'instance-1',
    metricsUrl: `ws://127.0.0.1:${armAddr.port}/metrics/ws`,
    supervisorUrl: `http://127.0.0.1:${address.port}`,
    token: 'test-registration-token',
    intervalMs: 300,
  });

  try {
    await client.register();
    await until(() => collector.isFresh('orders/instance-1'));
    assert.equal(collector.get('orders/instance-1')?.metrics.find(
      m => m.name === 'app.example.value')?.value, 42);
    const results = await fetch(`http://127.0.0.1:${address.port}/applications`, {
      headers: { authorization: 'Bearer test-registration-token' },
    });
    assert.equal(results.status, 200);
    const body = await results.json() as { applications: Array<{ id: string; fresh: boolean }> };
    assert.equal(body.applications[0].id, 'orders/instance-1');
    assert.equal(body.applications[0].fresh, true);
    await client.unregister();
    assert.equal(registry.list().length, 0);
    assert.equal(collector.get('orders/instance-1'), undefined);
  } finally {
    client.stop();
    await server.stop();
    registry.close();
    collector.stop();
    await armServer.stop();
  }
});

test('registration authentication and endpoint validation', async () => {
  const collector = new RemoteArmMetricsCollector([]);
  const registry = new ApplicationRegistry(collector, undefined, 3000);
  const server = new ApplicationRegistrationServer(registry, collector, {
    token: 'secret',
    port: 0,
  });
  await server.start();
  const address = server.http.address();
  if (!address || typeof address === 'string') throw Error('No server address');
  const url = `http://127.0.0.1:${address.port}/applications/register`;
  const request = (token: string, metricsUrl: string) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ applicationId: 'orders', instanceId: 'one', metricsUrl }),
  });
  try {
    const malformed = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
      },
      body: JSON.stringify({ applicationId: 'orders', instanceId: 123 }),
    });
    assert.equal(malformed.status, 400, 'Malformed registration must not reach registry');

    const unregisterMalformed = await fetch(
      `http://127.0.0.1:${address.port}/applications/unregister`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret',
        },
        body: JSON.stringify({ applicationId: 'orders' }),
      },
    );
    assert.equal(unregisterMalformed.status, 400);
    assert.equal((await request('wrong', 'ws://127.0.0.1:3100/metrics/ws')).status, 401);
    assert.equal((await request('secret', 'ws://169.254.169.254:3100/metrics/ws')).status, 400);
    assert.equal((await request('secret', 'ws://127.0.0.1:3100/metrics/ws')).status, 200);
    assert.equal(registry.list()[0].management, 'monitor-only');
    registry.expire(Date.now() + 4000);
    assert.equal(registry.list().length, 0);
  } finally {
    await server.stop();
    registry.close();
    collector.stop();
  }
});

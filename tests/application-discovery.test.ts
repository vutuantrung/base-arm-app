import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from '../packages/core/src/metrics.js';
import { MetricsServer } from '../packages/adapter-http/src/server.js';
import { RemoteArmMetricsCollector } from '../packages/adapter-process/src/remote-arm-metrics-collector.js';
import {
  ApplicationRegistry,
  type ApplicationStateTransition,
} from '../packages/adapter-process/src/application-registry.js';
import { ApplicationRegistrationServer } from '../packages/adapter-process/src/application-registration-server.js';

async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition not reached');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('discovery separates monitoring state from process state', async () => {
  const registryMetrics = new MetricsRegistry();
  registryMetrics.gauge('app.requests', 13);
  const arm = new MetricsServer(registryMetrics, { port: 0, broadcastIntervalMs: 1000 });
  await arm.start();
  const endpoint = arm.http.address();
  assert.ok(endpoint && typeof endpoint !== 'string');

  // A short freshness deadline lets this test exercise STALE without waiting for
  // the next 1s metrics broadcast.
  const collector = new RemoteArmMetricsCollector([], 100, 150);
  const discovery = new ApplicationRegistry(collector, undefined, 3000, 20000);
  const transitions: ApplicationStateTransition[] = [];
  discovery.on('state_changed', event => transitions.push(event));
  collector.start();

  const app = {
    applicationId: 'payment',
    instanceId: 'instance-a',
    metricsUrl: `ws://127.0.0.1:${endpoint.port}/metrics/ws`,
  };
  const id = 'payment/instance-a';

  try {
    const registered = discovery.register(app);
    assert.equal(registered.management, 'monitor-only');
    assert.equal(registered.processStatus, 'UNKNOWN');
    assert.equal(registered.status, 'REGISTERED');

    await until(() => discovery.get(id)?.status === 'CONNECTED' &&
      collector.isFresh(id));
    assert.equal(discovery.get(id)?.processStatus, 'UNKNOWN');

    await until(() => discovery.get(id)?.status === 'STALE', 900);
    assert.equal(discovery.list({ status: 'STALE' }).length, 1);

    // Terminating the app's WS clients must not mark its OS process as stopped.
    for (const client of arm.ws.clients) client.terminate();
    await until(() => discovery.get(id)?.status === 'DISCONNECTED');
    assert.equal(discovery.get(id)?.processStatus, 'UNKNOWN');

    await until(() => discovery.get(id)?.status === 'CONNECTED', 3500);

    // Expire the lease deterministically (the app has not sent heartbeats).
    discovery.expire(Date.now() + 3500);
    assert.equal(discovery.list().length, 0);
    assert.equal(discovery.list({ includeExpired: true })[0]?.status, 'EXPIRED');
    assert.equal(collector.get(id), undefined);

    const restored = discovery.register(app);
    assert.equal(restored.status, 'REGISTERED');
    await until(() => discovery.get(id)?.status === 'CONNECTED');

    assert.ok(transitions.some(item => item.current === 'STALE'));
    assert.ok(transitions.some(item => item.current === 'DISCONNECTED'));
    assert.ok(transitions.some(item => item.current === 'EXPIRED'));
    assert.ok(transitions.some(item =>
      item.previous === 'EXPIRED' && item.current === 'REGISTERED'));
    assert.equal(discovery.get(id)?.processStatus, 'UNKNOWN');
  } finally {
    discovery.close();
    collector.stop();
    await arm.stop();
  }
});

test('discovery API supports status filtering and instance details', async () => {
  const collector = new RemoteArmMetricsCollector([], 100, 1000);
  const discovery = new ApplicationRegistry(collector, undefined, 3000);
  const api = new ApplicationRegistrationServer(discovery, collector, {
    token: 'discovery-test-token', port: 0,
  });
  await api.start();
  const address = api.http.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer discovery-test-token' };

  try {
    discovery.register({
      applicationId: 'payments',
      instanceId: 'one',
      metricsUrl: 'ws://127.0.0.1:65534/metrics/ws',
    });

    const response = await fetch(`${base}/applications?status=REGISTERED`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { applications: Array<{ id: string }> };
    assert.equal(body.applications.length, 1);
    assert.equal(body.applications[0].id, 'payments/one');

    const detail = await fetch(`${base}/applications/payments/instances/one`, { headers });
    assert.equal(detail.status, 200);
    const data = await detail.json() as { application: { processStatus: string } };
    assert.equal(data.application.processStatus, 'UNKNOWN');

    const invalid = await fetch(`${base}/applications?status=RUNNING`, { headers });
    assert.equal(invalid.status, 400);

    discovery.expire(Date.now() + 4000);
    const expired = await fetch(`${base}/applications?status=EXPIRED`, { headers });
    const expiredData = await expired.json() as { applications: Array<{ status: string }> };
    assert.equal(expiredData.applications[0]?.status, 'EXPIRED');

    const history = await fetch(`${base}/applications/transitions`, { headers });
    const historyBody = await history.json() as { transitions: ApplicationStateTransition[] };
    assert.ok(historyBody.transitions.some(item => item.current === 'EXPIRED'));
  } finally {
    await api.stop();
    discovery.close();
    collector.stop();
  }
});

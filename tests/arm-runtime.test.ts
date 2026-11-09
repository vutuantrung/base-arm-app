import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createArmRuntime,
  type ManagedComponent,
  type RecoveryPolicy,
} from '../packages/library/src/index.js';

const recovery: RecoveryPolicy = {
  enabled: true,
  maxAttempts: 2,
  baseDelayMs: 10,
  maxDelayMs: 20,
  timeoutMs: 500,
};

async function createRegistrationStub() {
  const requests: Array<{ url: string; auth: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        auth: req.headers.authorization ?? '',
        body,
      });
      res.writeHead(200).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid address');
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function eventually(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition not reached');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('config-driven runtime starts components and registers only after metrics server', async () => {
  const stub = await createRegistrationStub();
  const calls: string[] = [];
  const component: ManagedComponent = {
    id: 'worker',
    async start() { calls.push('start'); },
    async stop() { calls.push('stop'); },
    async recover() {},
    async checkHealth() {
      return { status: 'HEALTHY', checkedAt: new Date().toISOString() };
    },
  };

  const runtime = createArmRuntime({
    components: [{ component, critical: true, recovery }],
    metrics: { collectionIntervalMs: 1000, server: { port: 0 } },
    supervisor: {
      applicationId: 'orders',
      instanceId: 'instance-one',
      supervisorUrl: stub.baseUrl,
      token: 'test-secret',
      metricsUrl: 'ws://127.0.0.1:3101/metrics/ws',
      intervalMs: 1000,
    },
  });

  try {
    await Promise.all([runtime.start(), runtime.start()]);
    assert.equal(runtime.status, 'RUNNING');
    assert.deepEqual(calls, ['start']);
    assert.equal(runtime.readiness().ready, true);
    assert.ok(runtime.metrics.get('process.memory.rss_bytes'));

    await eventually(() => stub.requests.length === 1);
    const registration = stub.requests[0];
    assert.equal(registration.auth, 'Bearer test-secret');
    assert.equal(registration.url, '/applications/register');
    assert.deepEqual(JSON.parse(registration.body), {
      applicationId: 'orders',
      instanceId: 'instance-one',
      metricsUrl: 'ws://127.0.0.1:3101/metrics/ws',
    });

    const result = await runtime.stop();
    assert.equal(result.clean, true);
    assert.equal(runtime.status, 'STOPPED');
    assert.deepEqual(calls, ['start', 'stop']);
    assert.deepEqual(await runtime.stop(), result);
    await assert.rejects(runtime.start(), /cannot be restarted/);
  } finally {
    await runtime.stop();
    await stub.close();
  }
});

test('runtime operates normally without a Supervisor', async () => {
  const runtime = createArmRuntime({
    metrics: { server: { port: 0 } },
  });
  try {
    await runtime.start();
    assert.equal(runtime.status, 'RUNNING');
    assert.equal(runtime.readiness().ready, true);
    assert.ok(runtime.metrics.get('process.uptime_seconds'));
  } finally {
    await runtime.stop();
  }
});

test('Supervisor registration failure does not block runtime startup', async () => {
  const registrationErrors: unknown[] = [];
  const runtime = createArmRuntime({
    metrics: { server: { port: 0 } },
    supervisor: {
      applicationId: 'orders',
      instanceId: 'instance-one',
      supervisorUrl: 'http://127.0.0.1:65533',
      token: 'secret',
      metricsUrl: 'ws://127.0.0.1:3101/metrics/ws',
      requestTimeoutMs: 1000,
      onError: error => registrationErrors.push(error),
    },
  });
  try {
    await runtime.start();
    assert.equal(runtime.status, 'RUNNING');
    await eventually(() => registrationErrors.length > 0);
    assert.equal(runtime.status, 'RUNNING');
  } finally {
    await runtime.stop();
  }
});

test('invalid registration configuration fails fast at construction', () => {
  assert.throws(() => createArmRuntime({
    metrics: { server: { port: 0 } },
    supervisor: {
      applicationId: 'orders',
      instanceId: 'one',
      supervisorUrl: 'http://127.0.0.1:3200',
      token: 'secret',
    },
  }), /metricsUrl is required/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { ApplicationRegistrationClient } from '../packages/library/src/index.js';

async function startStubServer(
  handler: (method: string, pathname: string, payload: Record<string, string>, auth: string) => number,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const payload = JSON.parse(raw) as Record<string, string>;
      const code = handler(
        req.method ?? '',
        new URL(req.url ?? '/', 'http://localhost').pathname,
        payload,
        req.headers.authorization ?? '',
      );
      res.writeHead(code).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for registration');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('client registers and unregisters with Supervisor protocol', async () => {
  const calls: string[] = [];
  const { server, baseUrl } = await startStubServer((method, path, payload, auth) => {
    assert.equal(method, 'POST');
    assert.equal(auth, 'Bearer test-token');
    assert.equal(payload.applicationId, 'orders');
    assert.equal(payload.instanceId, 'one');
    calls.push(path);
    if (path.endsWith('/register')) {
      assert.equal(payload.metricsUrl, 'ws://127.0.0.1:3101/metrics/ws');
    }
    return 200;
  });
  const client = new ApplicationRegistrationClient({
    applicationId: 'orders',
    instanceId: 'one',
    metricsUrl: 'ws://127.0.0.1:3101/metrics/ws',
    supervisorUrl: baseUrl,
    token: 'test-token',
    intervalMs: 1000,
  });
  try {
    await client.register();
    await client.unregister();
    assert.deepEqual(calls, [
      '/applications/register',
      '/applications/unregister',
    ]);
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('start is idempotent and retries after Supervisor HTTP failures', async () => {
  let attempts = 0;
  let failures = 0;
  const { server, baseUrl } = await startStubServer(() => {
    attempts++;
    return attempts === 1 ? 503 : 200;
  });
  const client = new ApplicationRegistrationClient({
    applicationId: 'payments',
    instanceId: 'one',
    metricsUrl: 'ws://127.0.0.1:3102/metrics/ws',
    supervisorUrl: baseUrl,
    token: 'test-token',
    intervalMs: 1000,
  });
  try {
    client.start(() => { failures++; });
    client.start(() => { failures++; });
    await waitFor(() => failures === 1);
    await waitFor(() => attempts === 2, 3000);
    client.stop();
    const count = attempts;
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(attempts, count, 'stop must stop heartbeat timer');
    assert.equal(failures, 1);
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('client rejects invalid identifiers, metrics endpoint and insecure Supervisor', () => {
  const base = {
    applicationId: 'orders',
    instanceId: 'one',
    metricsUrl: 'ws://127.0.0.1:3101/metrics/ws',
    supervisorUrl: 'http://127.0.0.1:3200',
    token: 'test-token',
  };
  assert.throws(() => new ApplicationRegistrationClient({
    ...base, applicationId: 'bad/id',
  }), /Invalid applicationId/);
  assert.throws(() => new ApplicationRegistrationClient({
    ...base, supervisorUrl: 'http://example.org:3200',
  }), /requires HTTPS/);
  assert.throws(() => new ApplicationRegistrationClient({
    ...base, metricsUrl: 'http://127.0.0.1:3101/metrics',
  }), /WebSocket endpoint/);
});

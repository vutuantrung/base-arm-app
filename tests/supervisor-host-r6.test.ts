import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SupervisorHost } from '../packages/supervisor-host/src/index.js';

const exec = promisify(execFile);
const silent = { log() {}, error() {} };

test('R6 host starts control plane, responds to management API and stops idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-r6-host-'));
  const host = new SupervisorHost({
    environment: {
      ARM_MANAGEMENT_TOKEN: 'r6-test-management-secret',
      ARM_DEPLOYMENT_ROOT: root,
      ARM_MANAGEMENT_PORT: '0',
      ARM_MONITOR_INTERVAL_MS: '60000',
    },
    logger: silent,
  });
  try {
    assert.equal(host.state, 'CREATED');
    await host.start();
    assert.equal(host.state, 'RUNNING');
    const address = host.api.http.address();
    if (!address || typeof address === 'string') throw new Error('Missing API listener');
    const base = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(base + '/applications');
    assert.equal(unauthorized.status, 401);
    await unauthorized.body?.cancel();
    const authorized = await fetch(base + '/applications', {
      headers: { authorization: 'Bearer r6-test-management-secret' },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), []);
    await host.stop();
    assert.equal(host.state, 'STOPPED');
    await host.stop();
    await assert.rejects(host.start(), /start only once/);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('R6 invalid configuration fails before opening management listener', () => {
  assert.throws(() => new SupervisorHost({ environment: { ARM_MANAGEMENT_TOKEN: 'short' }, logger: silent }),
    /ARM_MANAGEMENT_TOKEN/);
  assert.throws(() => new SupervisorHost({
    environment: { ARM_MANAGEMENT_TOKEN: 'r6-test-management-secret', ARM_MANAGEMENT_PORT: 'invalid' },
    logger: silent,
  }), /Invalid Supervisor port/);
});

test('R6 host cleans up when API listener startup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-r6-failure-'));
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Cannot reserve test port');
  const host = new SupervisorHost({
    environment: {
      ARM_MANAGEMENT_TOKEN: 'r6-test-management-secret',
      ARM_MANAGEMENT_PORT: String(address.port),
      ARM_DEPLOYMENT_ROOT: root,
    },
    logger: silent,
  });
  try {
    await assert.rejects(host.start(), /EADDRINUSE|startup failed/);
    assert.equal(host.state, 'FAILED');
    await host.stop();
    assert.equal(host.state, 'FAILED'); // failure remains visible after cleanup
  } finally {
    await host.stop();
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('R6 dependency checker succeeds on current modular monolith', async () => {
  const result = await exec(process.execPath, ['scripts/check-architecture.mjs']);
  assert.match(result.stdout, /dependency rules passed/);
});

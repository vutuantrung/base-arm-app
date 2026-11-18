import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessLogs, ProcessManager } from '../packages/process-manager/src/index.js';
import { SupervisorHost } from '../packages/supervisor-host/src/index.js';

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Log condition timed out');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

test('child logs capture stdout, stderr, and exit in distinct launch directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-child-logs-'));
  const logs = new ChildProcessLogs(join(root, 'logs'));
  const entry = join(root, 'child.cjs');
  await writeFile(entry, "console.log('hello'); console.error('failure'); setTimeout(() => process.exit(1), 250);");
  const manager = new ProcessManager(join(root, 'state.json'), undefined, undefined, logs);
  try {
    await manager.initialize([{ id: 'worker', entry, releaseVersion: '1.0.0' }]);
    await manager.start('worker');
    await waitFor(async () => !!(await logs.readTail('worker', 'diagnostics'))?.text.includes('"event":"exit"'));
    assert.match((await logs.readTail('worker', 'stdout'))?.text ?? '', /hello/);
    assert.match((await logs.readTail('worker', 'stderr'))?.text ?? '', /failure/);
    assert.match((await logs.readTail('worker', 'diagnostics'))?.text ?? '', /"code":1/);
    assert.match((await logs.readTail('worker', 'diagnostics'))?.text ?? '', /"releaseVersion":"1.0.0"/);
    const first = (await logs.listRuns('worker'))[0];
    await manager.start('worker');
    await waitFor(async () => !!(await logs.readTail('worker', 'diagnostics'))?.text.includes('"event":"exit"'));
    assert.equal((await logs.listRuns('worker')).length, 2);
    assert.equal((await logs.readTail('worker', 'stderr', 3, first))?.truncated, true);
    assert.equal(await logs.readTail('missing', 'stdout'), undefined);
    await assert.rejects(logs.readTail('../escape', 'stderr'), /Invalid/);
    await assert.rejects(logs.readTail('worker', 'stderr', 65537), /Invalid/);
  } finally {
    await manager.stop('worker').catch(() => {});
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('direct descriptors preserve output after manager close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-detached-logs-'));
  const entry = join(root, 'child.cjs');
  await writeFile(entry, "setInterval(() => console.log('tick'), 50); setTimeout(() => process.exit(0), 1200);");
  const logs = new ChildProcessLogs(join(root, 'logs'));
  const manager = new ProcessManager(join(root, 'state.json'), undefined, undefined, logs);
  let pid: number | undefined;
  try {
    await manager.initialize([{ id: 'worker', entry }]);
    pid = (await manager.start('worker')).pid;
    await waitFor(async () => !!(await logs.readTail('worker', 'stdout'))?.sizeBytes);
    const before = (await logs.readTail('worker', 'stdout'))!.sizeBytes;
    manager.close();
    await waitFor(async () => ((await logs.readTail('worker', 'stdout'))?.sizeBytes ?? 0) > before);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('management log reads are authenticated and bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-log-api-'));
  const token = 'test-management-token-123';
  const discoveryToken = 'test-discovery-token-123';
  const host = new SupervisorHost({
    environment: {
      ARM_DEPLOYMENT_ROOT: root, ARM_MANAGEMENT_PORT: '0',
      ARM_MANAGEMENT_TOKEN: token, ARM_DISCOVERY_TOKEN: discoveryToken,
      ARM_CHILD_LOGGING: '1', ARM_MONITOR_INTERVAL_MS: '60000',
    },
    logger: { log() {}, error() {} },
  });
  try {
    const logs = new ChildProcessLogs(join(root, 'logs'));
    const session = logs.openLaunch('worker', 'worker', 'worker-managed', '1.0.0');
    session.closeParentDescriptors();
    await host.start();
    const address = host.api.http.address();
    if (!address || typeof address === 'string') throw new Error('Missing API listener');
    const base = `http://127.0.0.1:${address.port}/runtime/processes/worker/logs`;
    const request = async (suffix: string, bearer?: string) => {
      const response = await fetch(base + suffix, {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      });
      return { status: response.status, body: await response.json() as unknown };
    };
    assert.equal((await request('')).status, 401);
    assert.equal((await request('', discoveryToken)).status, 401);
    assert.equal((await request('', token)).status, 200);
    const result = await request('/diagnostics?bytes=65536', token);
    assert.equal(result.status, 200);
    assert.match(JSON.stringify(result.body), /launch/);
    assert.equal((await request('/stderr?bytes=65537', token)).status, 400);
    assert.equal((await request('/stderr?run=..%2Fescape', token)).status, 400);
    assert.equal((await request('/stderr?run=1234567890123-abcdef', token)).status, 404);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

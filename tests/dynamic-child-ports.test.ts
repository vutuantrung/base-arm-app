import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ProcessManager } from '../packages/adapter-process/src/process-manager.js';
import { ApplicationConfigurationStore } from '../packages/adapter-process/src/application-configuration-store.js';
import { ApplicationEndpointDiscovery } from '../packages/adapter-process/src/application-endpoint-discovery.js';
import type { ApplicationRuntimeMonitor } from '../packages/adapter-process/src/application-runtime-monitor.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const a = s.address();
  if (!a || typeof a === 'string') throw new Error('No port');
  await new Promise<void>(resolve => s.close(() => resolve()));
  return a.port;
}

async function waitForHttp(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`,
        { signal: AbortSignal.timeout(300) });
      if (response.status === 200) return;
    } catch {}
    await pause(75);
  }
  throw new Error('HTTP process did not bind its assigned port: ' + port);
}

test('ApplicationConfigurationStore reads an optional application-specific PORT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-application-config-'));
  try {
    const store = new ApplicationConfigurationStore(root);
    assert.deepEqual(await store.read('payment-service'),
      { schemaVersion: 1, environment: {} });
    const directory = join(root, 'applications', 'payment-service');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'application-config.json'),
      JSON.stringify({ schemaVersion: 1, environment: { PORT: '3201', LOG_LEVEL: 'info' } }));
    const config = await store.read('payment-service');
    assert.equal(config.environment.PORT, '3201');
    assert.equal(config.environment.LOG_LEVEL, 'info');
    await assert.rejects(store.read('../other'), /Invalid application ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Supervisor assigns distinct dynamic ports and persists discovered endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-dynamic-ports-'));
  const entry = join(root, 'service.mjs');
  const statePath = join(root, 'processes.json');
  const manager = new ProcessManager(statePath);
  let pids: number[] = [];
  try {
    await writeFile(entry, `import http from 'node:http';
const server = http.createServer((_req, res) => {
  res.writeHead(200); res.end(process.env.ARM_INSTANCE_ID ?? 'ok');
});
server.listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
    await manager.initialize([
      { id: 'payment-service', entry,
        env: { ARM_INSTANCE_ID: 'payment-service-managed' } },
      { id: 'user-service', entry,
        env: { ARM_INSTANCE_ID: 'user-service-managed' } },
    ]);
    const payment = await manager.start('payment-service');
    const user = await manager.start('user-service');
    pids = [payment.pid, user.pid];
    assert.ok(payment.port && user.port);
    assert.notEqual(payment.port, user.port);
    await Promise.all([waitForHttp(payment.port!), waitForHttp(user.port!)]);
    const records = JSON.parse(await readFile(statePath, 'utf8')) as Array<{ id: string; port: number }>;
    assert.equal(records.find(x => x.id === 'payment-service')?.port, payment.port);
    assert.equal((await manager.inspect('payment-service')).port, payment.port);

    const fakeMonitor = {
      listApplications: async () => ['payment-service', 'user-service'].map(id => ({
        application: { applicationId: id, process: manager.list().find(x => x.id === id)! },
      })),
    } as unknown as ApplicationRuntimeMonitor;
    const discovery = new ApplicationEndpointDiscovery(fakeMonitor);
    const discovered = await discovery.list();
    assert.equal(discovered.length, 2);
    assert.equal((await discovery.find('payment-service'))?.url,
      `http://127.0.0.1:${payment.port}`);

    await manager.stop('payment-service');
    assert.equal(await discovery.find('payment-service'), undefined);
    await manager.stop('user-service');
    pids = [];
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Explicit application PORT wins over dynamic allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-configured-port-'));
  const port = await freePort();
  const manager = new ProcessManager(join(root, 'state.json'));
  let pid: number | undefined;
  try {
    const entry = join(root, 'listen.mjs');
    await writeFile(entry, `import http from 'node:http';
const s=http.createServer((_req,res)=>res.end('ok'));
s.listen(Number(process.env.PORT),'127.0.0.1');
process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
`);
    await manager.initialize([{
      id: 'payment-service', entry,
      applicationEnv: { PORT: String(port) },
    }]);
    const started = await manager.start('payment-service');
    pid = started.pid;
    assert.equal(started.port, port);
    await waitForHttp(port);
    await manager.stop('payment-service');
    pid = undefined;
  } finally {
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

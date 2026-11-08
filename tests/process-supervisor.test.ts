import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

import { ProcessManager } from '../packages/adapter-process/src/process-manager.js';
import { RemoteArmMetricsCollector } from '../packages/adapter-process/src/remote-arm-metrics-collector.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await wait(40);
  }
}

test('detached child survives supervisor close, is adopted without duplicate spawn', async t => {
  if (process.platform !== 'linux') {
    t.skip('Safe PID adoption requires Linux /proc process identity');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'arm-process-test-'));
  const workerFile = join(dir, 'worker.mjs');
  const stateFile = join(dir, 'state.json');
  await writeFile(workerFile, 'setInterval(() => {}, 1000);');
  const spec = { id: 'worker', entry: workerFile, metricsUrl: 'ws://127.0.0.1:65535/metrics/ws' };
  const first = new ProcessManager(stateFile);
  let second: ProcessManager | undefined;
  let pid = 0;

  try {
    await first.initialize([spec]);
    const launched = await first.start('worker');
    pid = launched.pid;
    assert.equal(first.list()[0].status, 'RUNNING');
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(saved[0].pid, pid);
    first.close();

    second = new ProcessManager(stateFile);
    await second.initialize([spec]);
    assert.equal(second.list()[0].adopted, true);
    const existing = await second.start('worker');
    assert.equal(existing.pid, pid, 'reconnect must not spawn a duplicate');
    await second.stop('worker');
    assert.equal(second.list()[0].status, 'STOPPED');
    pid = 0;
  } finally {
    second?.close();
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
});

test('remote collector subscribes to existing ARM WS protocol and reconnects', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No WS address');
  const actions: string[] = [];
  server.on('connection', ws => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString()) as {action: string};
      actions.push(message.action);
      if (message.action === 'subscribe') {
        ws.send(JSON.stringify({
          type: 'snapshot',
          data: {
            timestamp: new Date().toISOString(),
            metrics: [{name:'process.memory.rss_bytes',type:'gauge',value:123,unit:'bytes',timestamp:new Date().toISOString()}]
          },
        }));
      }
    });
  });

  const collector = new RemoteArmMetricsCollector([
    {id:'worker',entry:'unused',metricsUrl:`ws://127.0.0.1:${addr.port}/metrics/ws`},
  ], 100, 5000);
  try {
    collector.start();
    await until(() => collector.isFresh('worker'));
    assert.ok(actions.includes('subscribe'));
    assert.ok(actions.includes('subscribe_events'));
    assert.equal(collector.get('worker')?.metrics[0].value, 123);

    for (const client of server.clients) client.terminate();
    await until(() => !collector.get('worker')?.connected);
    await until(() => collector.isFresh('worker'));
    assert.ok(actions.filter(action => action === 'subscribe').length >= 2);
  } finally {
    collector.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

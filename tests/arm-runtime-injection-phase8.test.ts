import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ArmRuntimeInjector } from '../packages/adapter-process/src/arm-runtime-injector.js';
import { ArmTelemetryReader } from '../packages/adapter-process/src/arm-telemetry-reader.js';
import { ProcessManager } from '../packages/adapter-process/src/process-manager.js';

test('Phase 8 injection mode controls Node preloading without changing app source', () => {
  const disabled = new ArmRuntimeInjector({ mode: 'disabled' });
  assert.deepEqual(disabled.nodeArguments('/app/main.js', ['arg']), ['/app/main.js', 'arg']);
  assert.deepEqual(disabled.environment('payment-service', 'payment-service-blue'), {});
});

test('Phase 8 automatic injector validates config and uses Supervisor-owned bootstrap', () => {
  assert.throws(() => new ArmRuntimeInjector({ mode: 'automatic' }), /telemetryRoot/);
  const injector = new ArmRuntimeInjector({
    mode: 'automatic', telemetryRoot: '/tmp/arm-telemetry', sampleIntervalMs: 500,
  });
  const args = injector.nodeArguments('/app/main.js');
  assert.equal(args[0], '--import');
  assert.ok(args[1].endsWith('bootstrap.mjs'));
  assert.equal(args[2], '/app/main.js');
  assert.equal(injector.environment('payment-service', 'payment-service-green').ARM_INSTANCE_ID,
    'payment-service-green');
});

test('Phase 8 loads telemetry snapshots with strict instance IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-telemetry-test-'));
  try {
    const reader = new ArmTelemetryReader(root);
    assert.equal(await reader.read('payment-service-blue'), undefined);
    await assert.rejects(reader.read('../bad'), /Invalid ARM instance ID/);
    const snapshot = {
      schemaVersion: 1, applicationId: 'payment-service', instanceId: 'payment-service-blue',
      pid: 100, timestamp: new Date().toISOString(), uptimeSec: 1,
      rssBytes: 1000, heapUsedBytes: 200, eventLoopUtilization: 0.1,
      eventLoopDelayMeanMs: 1, eventLoopDelayMaxMs: 2, requestsStarted: 4,
      responsesFinished: 4, responses5xx: 0, uncaughtExceptions: 0,
    };
    await writeFile(join(root, 'payment-service-blue.json'), JSON.stringify(snapshot));
    assert.equal((await reader.read('payment-service-blue'))?.requestsStarted, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Phase 8 preloaded plain Node process emits telemetry without SDK dependency', async t => {
  const root = await mkdtemp(join(tmpdir(), 'arm-injection-test-'));
  const manager = new ProcessManager(join(root, 'processes.json'),
    new ArmRuntimeInjector({ mode: 'automatic', telemetryRoot: join(root, 'telemetry'),
      sampleIntervalMs: 250 }));
  try {
    const entry = join(root, 'app.mjs');
    await writeFile(entry, `import http from 'node:http';
const server=http.createServer((req,res)=>{res.writeHead(200);res.end('ok');});
server.listen(0,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
    await manager.initialize([{
      id: 'example', entry,
      env: { ARM_APPLICATION_ID: 'example', ARM_INSTANCE_ID: 'example-blue' },
    }]);
    await manager.start('example');
    const file = join(root, 'telemetry', 'example-blue.json');
    const deadline = Date.now() + 5000;
    let content: string | undefined;
    while (Date.now() < deadline) {
      try { content = await readFile(file, 'utf8'); break; }
      catch { await new Promise<void>(resolve => setTimeout(resolve, 75)); }
    }
    assert.ok(content, 'expected an ARM telemetry snapshot');
    const snapshot = JSON.parse(content!);
    assert.equal(snapshot.applicationId, 'example');
    assert.equal(snapshot.instanceId, 'example-blue');
    assert.equal(snapshot.schemaVersion, 1);
  } finally {
    try { await manager.stop('example', 3000); } catch {}
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

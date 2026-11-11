import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessLaunchRequest, ProcessController } from '../packages/contracts/src/index.js';
import { ProcessManager as LegacyManager } from '../packages/adapter-process/src/process-manager.js';
import { ProcessManager, ProcessControllerAdapter, ChildEnvironmentBuilder, DynamicPortAllocator } from '../packages/process-manager/src/index.js';
import { ChildEnvironmentBuilder as LegacyEnvironmentBuilder } from '../packages/adapter-process/src/child-environment-builder.js';
import { DynamicPortAllocator as LegacyPortAllocator } from '../packages/adapter-process/src/dynamic-port-allocator.js';
import type { ProcessLaunchInstrumentation } from '../packages/process-manager/src/index.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitForFile(path: string): Promise<Record<string, string | undefined>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, string | undefined>; }
    catch { await pause(50); }
  }
  throw new Error('Child did not produce a startup snapshot');
}

function newRequest(entry: string, output: string, port?: string): ProcessLaunchRequest {
  return {
    applicationId: 'payment-service',
    instanceId: 'payment-service-managed',
    entry,
    arguments: [output],
    applicationEnvironment: { PAYMENT_PROVIDER: 'mock', ...(port ? { PORT: port } : {}) },
    runtimeEnvironment: { NODE_ENV: 'production' },
  };
}

test('R2 compatibility imports reference the exact same implementation classes', () => {
  assert.equal(LegacyManager, ProcessManager);
  assert.equal(LegacyEnvironmentBuilder, ChildEnvironmentBuilder);
  assert.equal(LegacyPortAllocator, DynamicPortAllocator);
});

test('R2 ProcessController starts, observes assigned endpoint, restarts, and stops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-r2-controller-'));
  const stateFile = join(root, 'processes.json');
  const entry = join(root, 'worker.mjs');
  const output = join(root, 'startup.json');
  const manager = new ProcessManager(stateFile);
  const controller: ProcessController = new ProcessControllerAdapter(manager);
  let activePid: number | undefined;
  try {
    await writeFile(entry, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({
  port: process.env.PORT,
  host: process.env.HOST,
  appId: process.env.ARM_APPLICATION_ID,
  instanceId: process.env.ARM_INSTANCE_ID,
  paymentProvider: process.env.PAYMENT_PROVIDER,
  leakedManagementToken: process.env.ARM_MANAGEMENT_TOKEN,
}));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`);
    await manager.initialize([]);
    const started = await controller.start(newRequest(entry, output));
    activePid = started.pid;
    assert.equal(started.status, 'RUNNING');
    assert.equal(started.adopted, false);
    assert.ok(started.pid && started.pid > 0);
    assert.ok(started.startedAt);
    assert.equal(started.endpoint?.state, 'ASSIGNED');
    assert.ok(started.endpoint?.port && started.endpoint.port > 0);
    const saved = await waitForFile(output);
    assert.equal(saved.port, String(started.endpoint!.port));
    assert.equal(saved.host, '127.0.0.1');
    assert.equal(saved.appId, 'payment-service');
    assert.equal(saved.instanceId, 'payment-service-managed');
    assert.equal(saved.paymentProvider, 'mock');
    assert.equal(saved.leakedManagementToken, undefined);
    const inspected = await controller.inspect('payment-service-managed');
    assert.equal(inspected.pid, started.pid);
    assert.equal(inspected.endpoint?.port, started.endpoint?.port);
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as Array<{ pid: number; port: number }>;
    assert.equal(state[0].pid, started.pid);
    assert.equal(state[0].port, started.endpoint?.port);

    const restarted = await controller.restart('payment-service-managed');
    activePid = restarted.pid;
    assert.equal(restarted.status, 'RUNNING');
    assert.equal(restarted.endpoint?.state, 'ASSIGNED');
    assert.ok(restarted.endpoint?.port && restarted.endpoint.port > 0);
    await controller.stop('payment-service-managed');
    activePid = undefined;
    assert.equal((await controller.inspect('payment-service-managed')).status, 'STOPPED');
  } finally {
    if (activePid) try { process.kill(activePid, 'SIGKILL'); } catch {}
    manager.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('R2 ProcessController preserves explicitly configured HTTP port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-r2-fixed-'));
  const manager = new ProcessManager(join(root, 'state.json'));
  const controller: ProcessController = new ProcessControllerAdapter(manager);
  let pid: number | undefined;
  try {
    const entry = join(root, 'worker.mjs');
    const output = join(root, 'snapshot.json');
    await writeFile(entry, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ port: process.env.PORT }));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`);
    // Port allocated by the test OS probe, not the Supervisor dynamic allocator.
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw Error('No port');
    const port = addr.port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await manager.initialize([]);
    const launched = await controller.start(newRequest(entry, output, String(port)));
    pid = launched.pid;
    assert.equal(launched.endpoint?.port, port);
    assert.equal((await waitForFile(output)).port, String(port));
    await controller.stop('payment-service-managed');
    pid = undefined;
  } finally {
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('R2 ProcessController adopts the existing verified Linux PID and port', async t => {
  if (process.platform !== 'linux') {
    t.skip('Durable PID start-time verification requires Linux');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'arm-r2-adoption-'));
  const stateFile = join(root, 'process.json');
  const entry = join(root, 'worker.mjs');
  const output = join(root, 'snapshot.json');
  const first = new ProcessManager(stateFile);
  let second: ProcessManager | undefined;
  let activePid: number | undefined;
  try {
    await writeFile(entry, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ port: process.env.PORT }));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`);
    await first.initialize([]);
    const controller = new ProcessControllerAdapter(first);
    const request = newRequest(entry, output);
    const started = await controller.start(request);
    activePid = started.pid;
    await waitForFile(output);
    first.close();

    // Supervisor restarted. In production specs are recovered from active releases.
    second = new ProcessManager(stateFile);
    await second.initialize([{
      id: request.instanceId, entry: request.entry, args: [output],
      applicationEnv: { PAYMENT_PROVIDER: 'mock' },
      env: { NODE_ENV: 'production', ARM_APPLICATION_ID: request.applicationId,
        ARM_INSTANCE_ID: request.instanceId },
    }]);
    const recovered = await new ProcessControllerAdapter(second).inspect(request.instanceId);
    assert.equal(recovered.status, 'RUNNING');
    assert.equal(recovered.adopted, true);
    assert.equal(recovered.pid, started.pid);
    assert.equal(recovered.endpoint?.port, started.endpoint?.port);
    const existing = await second.start(request.instanceId);
    assert.equal(existing.pid, started.pid, 'PID adoption must not double-spawn');
    await second.stop(request.instanceId);
    activePid = undefined;
  } finally {
    if (activePid) try { process.kill(activePid, 'SIGKILL'); } catch {}
    second?.close();
    first.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('R2 launch instrumentation is structural and independent of ARM SDK concrete class', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-r2-instrumentation-'));
  const output = join(root, 'snapshot.json');
  const entry = join(root, 'worker.mjs');
  const instrumentation: ProcessLaunchInstrumentation = {
    nodeArguments: (file, args = []) => [file, ...args],
    environment: () => ({ ARM_INJECTION_ENABLED: '1' }),
  };
  const manager = new ProcessManager(join(root, 'state.json'), instrumentation);
  let pid: number | undefined;
  try {
    await writeFile(entry, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ injected: process.env.ARM_INJECTION_ENABLED }));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`);
    await manager.initialize([]);
    const started = await new ProcessControllerAdapter(manager).start(newRequest(entry, output));
    pid = started.pid;
    assert.equal((await waitForFile(output)).injected, '1');
    await manager.stop('payment-service-managed');
    pid = undefined;
  } finally {
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

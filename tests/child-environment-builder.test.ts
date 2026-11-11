import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildEnvironmentBuilder } from '../packages/adapter-process/src/child-environment-builder.js';
import { ProcessManager } from '../packages/adapter-process/src/process-manager.js';

test('ChildEnvironmentBuilder inherits only explicitly allowed OS keys', () => {
  const builder = new ChildEnvironmentBuilder({
    PATH: '/usr/bin', HOME: '/home/test', LANG: 'en_US.UTF-8',
    PORT: '3100', ARM_MANAGEMENT_TOKEN: 'secret-from-supervisor',
    ARM_BRIDGE_REGISTRATION_TOKEN: 'registration-secret',
    DATABASE_URL: 'postgres://supervisor-database',
    NODE_OPTIONS: '--import /unsafe/preload.js',
  });
  const env = builder.build({
    applicationEnv: { DATABASE_URL: 'postgres://app-db', LOG_LEVEL: 'info' },
    runtimeEnv: { NODE_ENV: 'production', PORT: '3201' },
    injectionEnv: { ARM_APPLICATION_ID: 'payment-service', ARM_INSTANCE_ID: 'payment-service-managed' },
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.DATABASE_URL, 'postgres://app-db');
  assert.equal(env.LOG_LEVEL, 'info');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.PORT, '3201');
  assert.equal(env.ARM_APPLICATION_ID, 'payment-service');
  assert.equal(env.ARM_INSTANCE_ID, 'payment-service-managed');
  assert.equal(env.ARM_MANAGEMENT_TOKEN, undefined);
  assert.equal(env.ARM_BRIDGE_REGISTRATION_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('ChildEnvironmentBuilder does not inherit Supervisor PORT for a singleton process', () => {
  const env = new ChildEnvironmentBuilder({ PORT: '3100', PATH: '/usr/bin' }).build({
    runtimeEnv: { ARM_APPLICATION_ID: 'payment-service', NODE_ENV: 'production' },
  });
  assert.equal(env.PORT, undefined);
});

test('ChildEnvironmentBuilder rejects reserved application names regardless of case', () => {
  const builder = new ChildEnvironmentBuilder({});
  for (const key of [
    'PORT', 'HOST', 'NODE_ENV', 'NODE_OPTIONS', 'node_path',
    'ARM_BRIDGE_MODULE_PATH', 'arm_management_token',
    'SUPERVISOR_REGISTRATION_TOKEN',
  ]) {
    assert.throws(() => builder.build({ applicationEnv: { [key]: 'malicious' } }),
      /Reserved application environment variable/);
  }
  assert.throws(() => builder.build({
    applicationEnv: { 'BAD-NAME': 'x' },
  }), /Invalid application environment entry/);
  assert.throws(() => builder.build({
    applicationEnv: { DATABASE_URL: 'value\0other' },
  }), /Invalid application environment entry/);
});

test('ChildEnvironmentBuilder refuses Node preload options in process specs', () => {
  assert.throws(() => new ChildEnvironmentBuilder({}).build({
    runtimeEnv: { NODE_OPTIONS: '--require /tmp/unsafe.js' },
  }), /Forbidden runtime environment variable/);
});

test('ProcessManager spawn isolates child from Supervisor tokens and ports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-child-env-'));
  const output = join(root, 'child-env.json');
  const script = join(root, 'child.mjs');
  const manager = new ProcessManager(join(root, 'processes.json'));
  const oldToken = process.env.ARM_MANAGEMENT_TOKEN;
  const oldPort = process.env.PORT;
  process.env.ARM_MANAGEMENT_TOKEN = 'supervisor-management-only';
  process.env.PORT = '3100';
  try {
    await writeFile(script, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({
  inheritedToken: process.env.ARM_MANAGEMENT_TOKEN,
  port: process.env.PORT,
  applicationId: process.env.ARM_APPLICATION_ID,
  businessValue: process.env.PAYMENT_MODE,
}));
`);
    await manager.initialize([{
      id: 'payment-service',
      entry: script,
      args: [output],
      applicationEnv: { PAYMENT_MODE: 'sandbox' },
      env: { ARM_APPLICATION_ID: 'payment-service', PORT: '3201' },
    }]);
    await manager.start('payment-service');
    let result: { inheritedToken?: string; port?: string; applicationId?: string; businessValue?: string } | undefined;
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      try { result = JSON.parse(await readFile(output, 'utf8')); break; }
      catch { await new Promise<void>(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(result, 'child should produce environment snapshot');
    assert.equal(result.inheritedToken, undefined);
    assert.equal(result.port, '3201');
    assert.equal(result.applicationId, 'payment-service');
    assert.equal(result.businessValue, 'sandbox');
  } finally {
    if (oldToken === undefined) delete process.env.ARM_MANAGEMENT_TOKEN;
    else process.env.ARM_MANAGEMENT_TOKEN = oldToken;
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
    try { await manager.stop('payment-service'); } catch {}
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

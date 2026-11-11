import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function source(path: string): Promise<string> {
  return readFile(resolve(path), 'utf8');
}

test('R5 ARM SDK implementation owns runtime and registration logic, not legacy library', async () => {
  assert.match(await source('packages/arm-client-sdk/src/arm-runtime.ts'), /class ArmRuntime/);
  assert.match(await source('packages/arm-client-sdk/src/application-registration-client.ts'),
    /class ApplicationRegistrationClient/);
  assert.equal((await source('packages/library/src/arm-runtime.ts')).trim(),
    "export * from '../../arm-client-sdk/src/arm-runtime.js';");
  assert.equal((await source('packages/library/src/application-registration-client.ts')).trim(),
    "export * from '../../arm-client-sdk/src/application-registration-client.js';");
});

test('R5 injection module owns preload config and telemetry reader, not legacy adapter-process', async () => {
  assert.match(await source('packages/runtime-injection/src/arm-runtime-injector.ts'),
    /class ArmRuntimeInjector/);
  assert.match(await source('packages/runtime-injection/src/arm-telemetry-reader.ts'),
    /class ArmTelemetryReader/);
  for (const file of ['arm-runtime-injector', 'arm-telemetry-reader']) {
    assert.equal((await source(`packages/adapter-process/src/${file}.ts`)).trim(),
      `export * from '../../runtime-injection/src/${file}.js';`);
  }
});

test('R5 SDK does not import concrete supervisor or process management code', async () => {
  for (const file of ['arm-runtime', 'application-registration-client']) {
    const code = await source(`packages/arm-client-sdk/src/${file}.ts`);
    assert.doesNotMatch(code, /from ['"][^'"]*(?:adapter-process|process-manager|deployment-manager|runtime-monitor)['"]/);
  }
});

test('R5 build copies both new and legacy Node --import entrypoints', async () => {
  const copy = await source('scripts/copy-runtime.mjs');
  assert.match(copy, /adapter-process/);
  assert.match(copy, /runtime-injection/);
  const injection = await source('packages/runtime-injection/runtime/bridge-bootstrap.mjs');
  assert.match(injection, /ARM_BRIDGE_MODULE_PATH/);
  assert.match(injection, /createArmRuntime/);
});

test('R5 public SDK and instrumentation entrypoints expose explicit supported surface', async () => {
  const sdk = await source('packages/arm-client-sdk/src/index.ts');
  const injector = await source('packages/runtime-injection/src/index.ts');
  for (const key of ['createArmRuntime','ArmRuntime','MetricsServer','ApplicationRegistrationClient']) {
    assert.ok(sdk.includes(key));
  }
  for (const key of ['ArmRuntimeInjector','ArmTelemetryReader','ArmTelemetryReaderAdapter']) {
    assert.ok(injector.includes(key));
  }
});

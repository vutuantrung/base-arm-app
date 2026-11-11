import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TelemetryReader } from '../packages/contracts/src/index.js';
import {
  ArmRuntime, createArmRuntime, ApplicationRegistrationClient,
} from '../packages/arm-client-sdk/src/index.js';
import { ArmRuntime as LegacyRuntime, createArmRuntime as legacyCreate } from '../packages/library/src/arm-runtime.js';
import { ApplicationRegistrationClient as LegacyRegistration } from '../packages/library/src/application-registration-client.js';
import {
  ArmRuntimeInjector, ArmTelemetryReader, ArmTelemetryReaderAdapter,
} from '../packages/runtime-injection/src/index.js';
import { ArmRuntimeInjector as LegacyInjector } from '../packages/adapter-process/src/arm-runtime-injector.js';
import { ArmTelemetryReader as LegacyTelemetryReader } from '../packages/adapter-process/src/arm-telemetry-reader.js';

test('R5 SDK and injection compatibility exports preserve class identity', () => {
  assert.equal(ArmRuntime, LegacyRuntime);
  assert.equal(createArmRuntime, legacyCreate);
  assert.equal(ApplicationRegistrationClient, LegacyRegistration);
  assert.equal(ArmRuntimeInjector, LegacyInjector);
  assert.equal(ArmTelemetryReader, LegacyTelemetryReader);
});

test('R5 ArmRuntime starts and stops without registering business components', async () => {
  const runtime = createArmRuntime({ metrics: { server: { host: '127.0.0.1', port: 0 } } });
  try {
    await runtime.start();
    assert.equal(runtime.status, 'RUNNING');
    assert.equal(runtime.readiness().ready, true);
  } finally {
    await runtime.stop();
  }
  assert.equal(runtime.status, 'STOPPED');
});

test('R5 TelemetryReader maps Phase 8 snapshot to R1 metric DTO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-r5-telemetry-'));
  const now = new Date().toISOString();
  try {
    const reader: TelemetryReader = new ArmTelemetryReaderAdapter(new ArmTelemetryReader(root));
    assert.equal(await reader.read('payment-service-blue'), undefined);
    await writeFile(join(root, 'payment-service-blue.json'), JSON.stringify({
      schemaVersion: 1, applicationId: 'payment-service', instanceId: 'payment-service-blue',
      pid: 100, timestamp: now, uptimeSec: 1,
      rssBytes: 4096, heapUsedBytes: 1024, eventLoopUtilization: 0.25,
      eventLoopDelayMeanMs: 2, eventLoopDelayMaxMs: 8,
      requestsStarted: 12, responsesFinished: 11, responses5xx: 1, uncaughtExceptions: 0,
    }));
    const sample = await reader.read('payment-service-blue');
    assert.equal(sample?.applicationId, 'payment-service');
    assert.equal(sample?.observedAt, now);
    assert.equal(sample?.metrics.find(x => x.name === 'process.memory.rss_bytes')?.value, 4096);
    assert.equal(sample?.metrics.find(x => x.name === 'http.server.responses_5xx')?.value, 1);
    await assert.rejects(reader.read('../escape'), /Invalid ARM instance ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R5 preload paths target Supervisor-owned runtime-injection package', () => {
  const injector = new ArmRuntimeInjector({
    mode: 'automatic', telemetryRoot: '/tmp/arm-r5', sampleIntervalMs: 500,
  });
  const nodeArgs = injector.nodeArguments('/app/main.js', ['--test']);
  assert.equal(nodeArgs[0], '--import');
  assert.match(nodeArgs[1], /runtime-injection[/\\]runtime[/\\]bootstrap\.mjs$/);
  assert.ok(existsSync(nodeArgs[1]));
  assert.deepEqual(nodeArgs.slice(2), ['/app/main.js', '--test']);
});

test('R5 bridge resolves canonical compiled SDK first and retains legacy fallback', () => {
  const injector = new ArmRuntimeInjector({
    mode: 'bridge', telemetryRoot: '/tmp/arm-r5',
    bridgeApplicationId: 'payment-service',
    bridgeMetricsBasePort: 3500,
    bridgeRegistrationUrl: 'http://127.0.0.1:3200/',
    bridgeRegistrationToken: 'registration-secret-for-tests',
    bridgeMetricsToken: 'metrics-secret-for-tests',
  });
  const paths = [
    resolve('dist/packages/arm-client-sdk/src/arm-runtime.js'),
    resolve('dist/packages/library/src/arm-runtime.js'),
  ];
  assert.match(
    injector.nodeArguments('/app/main.js', [], 'payment-service')[1],
    /runtime-injection[/\\]runtime[/\\]bridge-bootstrap\.mjs$/,
  );
  if (paths.some(existsSync)) {
    assert.equal(injector.environment('payment-service', 'payment-service-blue').ARM_BRIDGE_MODULE_PATH,
      paths.find(existsSync));
  } else {
    assert.throws(() => injector.environment('payment-service', 'payment-service-blue'),
      /Run npm run build first/);
  }
  assert.equal(injector.environment('other-service', 'other-managed').ARM_BRIDGE_ENABLED, undefined);
});

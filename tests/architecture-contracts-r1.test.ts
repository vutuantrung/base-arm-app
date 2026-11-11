import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ApplicationConfigurationReader,
  DomainEventMap,
  EndpointDirectory,
  PackageCatalog,
  ProcessController,
  ProcessInstance,
  ReleaseSelector,
  RuntimeStatusReader,
  TrafficRouter,
} from '../packages/contracts/src/index.js';

/**
 * R1 is contract-only: tests defend the boundary without changing any
 * production runtime or pretending existing classes implement new ports.
 */
test('R1 contracts do not depend on concrete implementation source', async () => {
  const source = await readFile(resolve('packages/contracts/src/index.ts'), 'utf8');
  assert.doesNotMatch(source, /^\s*(?:import|export)\s+.*?from\s+['"][^'"]+(?:adapter-process|adapter-http|library|core)[^'"]+['"]/gm);
  assert.doesNotMatch(source, /\b(?:ChildProcess|ServerResponse|IncomingMessage|ApplicationLifecycleManager|ProcessManager)\b/);
});

test('R1 contract DTOs can be consumed without importing implementation classes', () => {
  const instance: ProcessInstance = {
    instanceId: 'payment-service-managed',
    applicationId: 'payment-service',
    status: 'RUNNING',
    adopted: false,
    endpoint: { host: '127.0.0.1', port: 41234, state: 'ASSIGNED' },
  };
  const event: DomainEventMap['process.started'] = {
    applicationId: instance.applicationId,
    instanceId: instance.instanceId,
    pid: 123,
  };
  assert.equal(instance.endpoint?.state, 'ASSIGNED');
  assert.equal(event.pid, 123);
});

test('R1 ports are interface-only and do not claim concrete runtime conformance', () => {
  // Compile-only structural references: R2 must provide real adapters,
  // contract tests and runtime validation instead of unsafe casts.
  type RequiredPorts =
    ProcessController | PackageCatalog | ReleaseSelector |
    RuntimeStatusReader | EndpointDirectory | TrafficRouter |
    ApplicationConfigurationReader;
  const reference: RequiredPorts | undefined = undefined;
  assert.equal(reference, undefined);
});

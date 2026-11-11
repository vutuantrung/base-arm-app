import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('R2 process module does not depend on concrete ARM injector or deployment managers', async () => {
  const source = await readFile(resolve('packages/process-manager/src/process-manager.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"][^'"]*(?:arm-runtime-injector|application-lifecycle-manager|safe-rollout-manager|blue-green-deployment-manager)['"]/);
  assert.match(source, /ProcessLaunchInstrumentation/);
});

test('R2 legacy process entrypoints delegate instead of duplicating implementations', async () => {
  const pairs = [
    ['process-manager', 'process-manager'],
    ['child-environment-builder', 'child-environment-builder'],
    ['dynamic-port-allocator', 'dynamic-port-allocator'],
  ];
  for (const [name, target] of pairs) {
    const contents = (await readFile(resolve('packages/adapter-process/src/' + name + '.ts'), 'utf8')).trim();
    assert.equal(contents, `export * from '../../process-manager/src/${target}.js';`);
  }
});

test('R2 package public entrypoint exposes only supported capability surface', async () => {
  const index = await readFile(resolve('packages/process-manager/src/index.ts'), 'utf8');
  for (const symbol of [
    'ProcessManager', 'ProcessControllerAdapter', 'ChildEnvironmentBuilder',
    'DynamicPortAllocator', 'ProcessLaunchInstrumentation',
  ]) {
    assert.ok(index.includes(symbol), `Missing ${symbol} from public entrypoint`);
  }
});

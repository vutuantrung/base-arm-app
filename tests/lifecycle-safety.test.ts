import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MetricsRegistry } from '../packages/core/src/metrics.js';
import {
  OperationManager,
  OperationAbortedError,
  OperationTimeoutError,
  type OperationContext,
} from '../packages/core/src/operations.js';
import {
  ReliabilityManager,
  type ManagedComponent,
  type RecoveryPolicy,
} from '../packages/core/src/reliability.js';

const policy: RecoveryPolicy = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
  timeoutMs: 30,
  circuitFailureThreshold: 10,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function healthy() {
  return { status: 'HEALTHY' as const, checkedAt: new Date().toISOString() };
}

test('timeout invalidates operation context but tracks uncooperative work', async () => {
  const operations = new OperationManager();
  const blocked = deferred<void>();
  let context!: OperationContext;

  await assert.rejects(
    operations.execute('worker', 'recover', 15, async current => {
      context = current;
      await blocked.promise;
    }),
    OperationTimeoutError,
  );

  assert.equal(context.isCurrent(), false);
  assert.equal(operations.hasActive('worker'), true);

  await assert.rejects(
    operations.execute('worker', 'recover', 15, async () => {}),
    /already has a pending operation/,
  );

  blocked.resolve();
  assert.equal(await operations.waitForIdle(200), true);
  assert.equal(operations.hasActive('worker'), false);
  assert.throws(() => context.assertCurrent(), OperationAbortedError);
});

test('shutdown aborts cooperative recovery and stops each component once', async () => {
  const arm = new ReliabilityManager(new MetricsRegistry(), {
    checkIntervalMs: 10_000,
    shutdownGraceMs: 200,
  });

  let stopCount = 0;
  let recoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { recoveryStarted = resolve; });

  const component: ManagedComponent = {
    id: 'cooperative',
    async start() {},
    async stop() { stopCount++; },
    async checkHealth() { return healthy(); },
    async recover(context) {
      recoveryStarted();
      await new Promise<void>((_, reject) => {
        context!.signal.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        );
      });
    },
  };

  arm.register({ component, critical: true, recovery: { ...policy, timeoutMs: 1000 } });
  await arm.start();

  const pending = arm.recover('cooperative');
  await started;
  const firstStop = arm.stop();
  const secondStop = arm.stop();
  assert.equal(firstStop, secondStop);

  const result = await firstStop;
  await pending;

  assert.deepEqual(result, { clean: true, blockedComponents: [] });
  assert.equal(stopCount, 1);
  assert.equal(arm.readiness().ready, false);
  assert.equal(arm.statuses()[0].lifecycle, 'STOPPED');
});

test('timed-out recovery is quarantined; no overlapping recovery or stop', async () => {
  const arm = new ReliabilityManager(new MetricsRegistry(), {
    checkIntervalMs: 10_000,
    shutdownGraceMs: 20,
  });

  let attempts = 0;
  let stops = 0;
  let context!: OperationContext;
  const blocked = deferred<void>();

  arm.register({
    component: {
      id: 'stuck_worker',
      async start() {},
      async stop() { stops++; },
      async checkHealth() { return healthy(); },
      async recover(current) {
        attempts++;
        context = current!;
        await blocked.promise;
        current!.assertCurrent();
      },
    },
    critical: true,
    recovery: { ...policy, timeoutMs: 15 },
  });

  await arm.start();
  await arm.recover('stuck_worker');

  assert.equal(attempts, 1);
  assert.equal(arm.statuses()[0].lifecycle, 'FAILED');
  assert.equal(arm.statuses()[0].operationPending, true);
  assert.ok(arm.recentEvents().some(event => event.type === 'operation.timeout'));

  await arm.recover('stuck_worker');
  assert.equal(attempts, 1);

  const result = await arm.stop();
  assert.deepEqual(result, { clean: false, blockedComponents: ['stuck_worker'] });
  assert.equal(stops, 0);
  assert.equal(arm.readiness().ready, false);

  blocked.resolve();
  assert.equal(context.isCurrent(), false);
});

test('health checks cannot restore readiness after shutdown', async () => {
  const arm = new ReliabilityManager(new MetricsRegistry(), {
    checkIntervalMs: 10_000,
  });
  const health = deferred<ReturnType<typeof healthy>>();
  let checks = 0;

  arm.register({
    component: {
      id: 'slow_health',
      async start() {},
      async stop() {},
      async checkHealth() {
        checks++;
        return checks === 1 ? healthy() : health.promise;
      },
    },
    critical: true,
    recovery: policy,
  });
  await arm.start();
  const checking = arm.checkAll();
  await new Promise(resolve => setTimeout(resolve, 5));
  const stopped = await arm.stop();
  health.resolve(healthy());
  await checking;

  assert.equal(stopped.clean, true);
  assert.equal(arm.readiness().ready, false);
});

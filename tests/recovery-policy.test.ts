import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryGuard, PermanentRecoveryError } from '../packages/core/src/recovery-policy.js';
import { MetricsRegistry } from '../packages/core/src/metrics.js';
import { ReliabilityManager, type ManagedComponent } from '../packages/core/src/reliability.js';

test('rolling retry budget persists across recovery cycles', () => {
  let now = 0;
  const guard = new RecoveryGuard(
    { budgetMaxAttempts: 2, budgetWindowMs: 100, circuitFailureThreshold: 10 },
    () => now,
  );

  assert.equal(guard.acquire().allowed, true);
  guard.failed();
  now += 1;
  assert.equal(guard.acquire().allowed, true);
  guard.failed();
  assert.deepEqual(guard.acquire().reason, 'budget_exhausted');
  now = 101;
  assert.equal(guard.acquire().allowed, true);
});

test('circuit opens and permits one half-open probe after cooldown', () => {
  let now = 0;
  const guard = new RecoveryGuard(
    { circuitFailureThreshold: 2, circuitCooldownMs: 50 },
    () => now,
  );

  assert.equal(guard.acquire().allowed, true);
  guard.failed();
  assert.equal(guard.acquire().allowed, true);
  guard.failed();
  assert.equal(guard.snapshot().circuit, 'OPEN');
  assert.equal(guard.acquire().reason, 'circuit_open');

  now = 50;
  assert.equal(guard.acquire().allowed, true);
  assert.equal(guard.snapshot().circuit, 'HALF_OPEN');
  assert.equal(guard.acquire().reason, 'probe_in_progress');
  guard.succeeded();
  assert.equal(guard.snapshot().circuit, 'CLOSED');
});

test('failed half-open probe reopens circuit for another cooldown', () => {
  let now = 0;
  const guard = new RecoveryGuard(
    { circuitFailureThreshold: 1, circuitCooldownMs: 25 },
    () => now,
  );
  guard.acquire();
  guard.failed();
  now = 25;
  assert.equal(guard.acquire().allowed, true);
  guard.failed();
  assert.equal(guard.acquire().reason, 'circuit_open');
});

test('manager limits automatic recovery across monitoring cycles', async () => {
  const metrics = new MetricsRegistry();
  const manager = new ReliabilityManager(metrics, { checkIntervalMs: 10_000 });
  let attempts = 0;

  const component: ManagedComponent = {
    id: 'failing_worker',
    async start() {},
    async stop() {},
    async checkHealth() {
      return { status: 'UNHEALTHY', checkedAt: new Date().toISOString() };
    },
    async recover() { attempts++; throw new Error('Dependency offline'); },
  };

  manager.register({
    component,
    critical: true,
    recovery: {
      enabled: true, maxAttempts: 5, baseDelayMs: 0,
      maxDelayMs: 0, timeoutMs: 100,
      budgetMaxAttempts: 2, budgetWindowMs: 60_000,
      circuitFailureThreshold: 10,
    },
  });

  await manager.start();
  try {
    await manager.recover('failing_worker');
    await manager.recover('failing_worker');
    assert.equal(attempts, 2);
    assert.equal(manager.readiness().ready, false);
    assert.equal(manager.statuses()[0].recoveryGuard?.attemptsInWindow, 2);
    assert.ok(manager.recentEvents().some(e => e.type === 'recovery.denied'));
  } finally {
    await manager.stop();
  }
});

test('permanent recovery errors stop retries', async () => {
  const metrics = new MetricsRegistry();
  const manager = new ReliabilityManager(metrics, { checkIntervalMs: 10_000 });
  let attempts = 0;

  manager.register({
    component: {
      id: 'configuration',
      async start() {},
      async stop() {},
      async checkHealth() {
        return { status: 'UNHEALTHY', checkedAt: new Date().toISOString() };
      },
      async recover() {
        attempts++;
        throw new PermanentRecoveryError('Invalid credentials');
      },
    },
    critical: true,
    recovery: {
      enabled: true, maxAttempts: 5, baseDelayMs: 0,
      maxDelayMs: 0, timeoutMs: 100,
    },
  });

  await manager.start();
  try {
    await manager.recover('configuration');
    assert.equal(attempts, 1);
    assert.equal(manager.statuses()[0].lifecycle, 'FAILED');
  } finally {
    await manager.stop();
  }
});

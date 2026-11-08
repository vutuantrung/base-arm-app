import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MetricsRegistry } from '../packages/core/src/metrics.js';
import { ReliabilityManager, type RecoveryPolicy } from '../packages/core/src/reliability.js';
import {
  ReconnectableResource,
  type ResourceSession,
} from '../packages/adapters/src/reconnectable-resource.js';

const policy: RecoveryPolicy = {
  enabled: true,
  maxAttempts: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  timeoutMs: 100,
  circuitFailureThreshold: 10,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

interface TestSession extends ResourceSession {
  readonly id: number;
  readonly subscriptions: ReadonlySet<string>;
}

test('database outage -> recovery -> restored readiness and recovery metric', async () => {
  const metrics = new MetricsRegistry();
  const arm = new ReliabilityManager(metrics, { checkIntervalMs: 10_000 });
  const sessions: Array<{ id: number; closed: boolean }> = [];
  let available = true;

  const database = new ReconnectableResource({
    id: 'database',
  }, {
    async create() {
      const record = { id: sessions.length + 1, closed: false };
      sessions.push(record);
      return {
        id: record.id,
        async checkHealth() { return available && !record.closed; },
        async close() { record.closed = true; },
      };
    },
  });

  arm.register({ component: database, critical: true, recovery: policy });
  await arm.start();

  try {
    assert.equal(arm.readiness().ready, true);
    assert.equal(database.session?.id, 1);

    available = false;
    // HealthMonitor schedules the first recovery in the background.
    // Block connection creation while the dependency is unavailable.
    await arm.checkAll();
    await arm.recover('database');
    assert.equal(arm.readiness().ready, false);

    available = true;
    await arm.recover('database');

    assert.equal(arm.readiness().ready, true);
    assert.ok((metrics.get('arm.recovery.success_total')?.value ?? 0) >= 1);
    assert.ok(sessions.some(session => session.closed));
    assert.ok(arm.recentEvents().some(event => event.type === 'recovery.succeeded'));
  } finally {
    await arm.stop();
  }
});

test('WebSocket reconnect restores subscriptions exactly once', async () => {
  const arm = new ReliabilityManager(new MetricsRegistry(), {
    checkIntervalMs: 10_000,
  });
  const desiredSubscriptions = new Set(['metrics', 'reliability']);
  const sessions: Array<{ id: number; closed: boolean; subscriptions: Set<string> }> = [];

  const websocket = new ReconnectableResource<TestSession>({
    id: 'websocket',
  }, {
    async create(signal) {
      const id = sessions.length + 1;
      const record = { id, closed: false, subscriptions: new Set<string>() };
      sessions.push(record);

      for (const channel of desiredSubscriptions) {
        if (signal.aborted) throw new Error('Connection cancelled');
        record.subscriptions.add(channel);
      }

      return {
        id,
        subscriptions: record.subscriptions,
        async checkHealth() { return !record.closed; },
        async close() { record.closed = true; },
      };
    },
  });

  arm.register({ component: websocket, critical: true, recovery: policy });
  await arm.start();

  try {
    assert.equal(websocket.session?.id, 1);

    // Force a reconnect: a new session must not inherit duplicate listeners.
    await arm.recover('websocket');
    assert.equal(websocket.session?.id, 2);
    assert.equal(sessions[0].closed, true);
    assert.deepEqual(
      [...websocket.session!.subscriptions].sort(),
      ['metrics', 'reliability'],
    );
    assert.equal(websocket.session!.subscriptions.size, 2);
    assert.equal(arm.readiness().ready, true);
  } finally {
    await arm.stop();
  }
});

test('timeout leaves uncooperative connection quarantined, and late session is disposed', async () => {
  const arm = new ReliabilityManager(new MetricsRegistry(), {
    checkIntervalMs: 10_000,
    shutdownGraceMs: 20,
  });
  const gate = deferred<void>();
  let closedCandidates = 0;
  let created = 0;

  const resource = new ReconnectableResource({
    id: 'slow_resource',
  }, {
    async create() {
      created++;
      if (created > 1) await gate.promise;
      return {
        async checkHealth() { return true; },
        async close() { closedCandidates++; },
      };
    },
  });

  arm.register({
    component: resource,
    critical: true,
    recovery: { ...policy, timeoutMs: 15 },
  });

  await arm.start();
  const original = resource.session;
  assert.ok(original);

  await arm.recover('slow_resource');
  assert.equal(arm.statuses()[0].operationPending, true);
  assert.equal(arm.statuses()[0].lifecycle, 'FAILED');

  await arm.recover('slow_resource');
  assert.equal(created, 2, 'must not start another overlapping recovery');

  const shutdown = await arm.stop();
  assert.equal(shutdown.clean, false);
  assert.deepEqual(shutdown.blockedComponents, ['slow_resource']);

  gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(resource.session, original, 'stale recovery must never commit');
  assert.equal(closedCandidates, 1, 'late candidate must be disposed');
});

test('worker recovery respects a simulated checkpoint without replaying completed jobs', async () => {
  // In production this store must be transactional and durable.
  const checkpoint = new Set<string>();
  const jobs = ['task-1', 'task-2', 'task-3'];
  const handled = new Map<string, number>();
  let online = true;

  async function processOutstandingJobs() {
    for (const id of jobs) {
      if (checkpoint.has(id)) continue;
      handled.set(id, (handled.get(id) ?? 0) + 1);
      checkpoint.add(id);
    }
  }

  const arm = new ReliabilityManager(new MetricsRegistry(), {
    checkIntervalMs: 10_000,
  });

  arm.register({
    component: {
      id: 'worker',
      async start() { await processOutstandingJobs(); },
      async stop() {},
      async checkHealth() {
        return {
          status: online ? 'HEALTHY' : 'UNHEALTHY',
          checkedAt: new Date().toISOString(),
        };
      },
      async recover() {
        online = true;
        await processOutstandingJobs();
      },
    },
    critical: true,
    recovery: policy,
  });

  await arm.start();
  try {
    assert.equal(checkpoint.size, 3);
    online = false;
    await arm.recover('worker');

    for (const id of jobs) {
      assert.equal(handled.get(id), 1);
    }
    assert.equal(arm.readiness().ready, true);
  } finally {
    await arm.stop();
  }
});

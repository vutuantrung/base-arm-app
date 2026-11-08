# Phase 5 — Integration and Reliability Testing

This phase exercises ARM at component boundaries instead of only unit-testing
the policy classes. It does not require a real database or message broker.

## Added adapter

`packages/adapters/src/reconnectable-resource.ts` provides
`ReconnectableResource<T>`, reusable with database connection pools,
WebSocket sessions and other connection-oriented dependencies.

Its factory is responsible for creating a **fully initialized** session.
For WebSocket, that means attaching message listeners and restoring
subscriptions before the factory returns.

On start/recover, ARM:

1. Creates a replacement session with an AbortSignal.
2. Verifies replacement session health.
3. Checks the operation generation before swapping the active session.
4. Swaps the active reference atomically inside the process.
5. Closes the previous session after a successful swap.
6. Disposes failed or stale candidate sessions.

A failure to close an old session is reported through `onCleanupError`;
it does not undo the already-successful swap.

```ts
import { ReconnectableResource } from
  '../../packages/adapters/src/reconnectable-resource.js';

const database = new ReconnectableResource(
  { id: 'database', onCleanupError: console.error },
  {
    async create(signal) {
      // createPool is an application-provided function.
      const pool = await createPool({ signal });

      return {
        checkHealth: async checkSignal => pool.ping(checkSignal),
        close: async () => pool.close(),
      };
    },
  },
);
```

The example above is illustrative: `createPool` is **not** supplied by ARM.

## Integration scenarios

File: `tests/integration-reliability.test.ts`

| Scenario | Expected behavior |
| --- | --- |
| Database becomes unavailable | ARM reports unready; recovery succeeds after dependency returns |
| WebSocket reconnect | New session restores subscriptions; previous session closes |
| Recovery operation hangs | Timeout quarantines the component; repeated recovery cannot overlap |
| Shutdown during hung recovery | Incomplete shutdown is reported; stale session is disposed after it resolves |
| Worker resumes jobs | Simulated checkpoint prevents replay within the test |

The worker test uses an **in-memory Set** to simulate a checkpoint. It does NOT
prove durability across process crashes. For production use transactions,
durable job state, idempotency keys or a broker with explicit acknowledgements.

## Commands

```bash
npm install
npm run build
npm test
npm run dev
```

Run only the integration test:

```bash
node --import tsx --test tests/integration-reliability.test.ts
```

## Acceptance criteria

- All existing unit tests remain passing.
- An unhealthy critical dependency forces readiness to false.
- A successful recovery is visible through metrics and events.
- Connection replacements do not leave the previous active connection open.
- A timed-out uncooperative recovery cannot overwrite the active resource.
- A shutdown that cannot safely close a component reports `clean: false`.
- No UI is introduced. Existing HTTP and WebSocket reporting remains unchanged.

## Limitations and future production tests

- Factory code must clean up any resource created **before it throws**.
- AbortSignal is cooperative; a factory can ignore it and run indefinitely.
- Process-local generations do not fence database writes across replicas.
- Connect, subscribe and resource-close behavior depend on specific drivers.
- Fault-injection tests still need real PostgreSQL/Redis/WebSocket servers.
- Load, soak, Kubernetes termination, and multi-instance tests are not included.
- No claim of exactly-once processing is made.

Production validation should include container restarts, network partitions,
driver-specific connection leak checks and durable checkpoint recovery.

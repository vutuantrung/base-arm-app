# Phase 4 — Recovery Safety and Lifecycle Hardening

This phase adds cooperative cancellation, per-component operation isolation,
generation-based fencing, and a bounded graceful shutdown to ARM.

## Why the change matters

`Promise.race([recover(), timeout])` only stops **waiting**. The original
`recover()` may still run. Starting another recovery in that situation can
corrupt state or create duplicate connections.

ARM now keeps timed-out operations registered until they really settle.

## Module responsibilities

- `packages/core/src/operations.ts` — cancellation, operation context,
  generation tokens, timeout tracking and idle waits.
- `packages/core/src/reliability.ts` — lifecycle, health, recovery and shutdown
  orchestration.
- `packages/core/src/recovery-policy.ts` — retry budget and circuit breaker.
- `packages/adapter-http/src/server.ts` — read-only HTTP/WS reporting.

## ManagedComponent contract

Existing adapters without arguments remain source-compatible. New adapters
should accept `OperationContext` and cooperate with cancellation.

```ts
import type {
  ManagedComponent,
} from '../packages/core/src/reliability.js';

const worker: ManagedComponent = {
  id: 'worker',

  async start(context) {
    context?.assertCurrent();
    // Initialize resources; attach context.signal to cancellable operations.
  },

  async recover(context) {
    if (!context) throw new Error('OperationContext required');

    const connection = await connect({ signal: context.signal });

    // Check before installing the new connection into shared state.
    context.assertCurrent();
    await commitConnection(connection, context.generation);
  },

  async stop(context) {
    context?.assertCurrent();
    // Close resources and reject new work.
  },

  async checkHealth(signal) {
    // Observe only; avoid side effects.
    return { status: 'HEALTHY', checkedAt: new Date().toISOString() };
  },
};
```

`connect()` and `commitConnection()` are placeholders to illustrate the
adapter contract, not functions exported from ARM.

`context.generation` is **process-local**. For external resources, the storage
system must validate a fencing token atomically (e.g. a monotonically
increasing lease epoch). Checking `assertCurrent()` in JavaScript cannot
guarantee safety across multiple processes.

## Operation timeout behavior

1. A new start/recover/stop operation receives an AbortSignal and generation.
2. When the deadline expires, ARM aborts the signal and invalidates the context.
3. An uncooperative underlying Promise stays registered as pending.
4. Another start/recover/stop for the same component is refused while pending.
5. A timed-out recovery marks the component FAILED and requires explicit
   intervention; it does not immediately retry.
6. A late completion cannot update ARM lifecycle/health/recovery status, and
   adapters must check their context before committing external effects.

Cancellation is cooperative: ARM cannot forcibly kill arbitrary asynchronous
JavaScript or undo external side effects.

## Graceful shutdown

`stop()` is reentrant and returns:

```json
{"clean": true, "blockedComponents": []}
```

- Readiness becomes false as soon as shutdown starts.
- The periodic health monitor stops.
- All tracked operations receive abort signals.
- ARM waits up to `shutdownGraceMs` (default 3000 ms) for those operations.
- Components are stopped in reverse registration order.
- If a component still has an outstanding operation, ARM skips its stop()
  to avoid overlapping lifecycle actions, marks it FAILED, and reports it as
  blocked instead of claiming a clean shutdown.

For a process manager such as Kubernetes, set the termination grace period
longer than ARM's shutdown grace plus the maximum component stop timeout.
An uncooperative operation may still hold external resources after ARM stops.

## New reporting fields and events

`GET /reliability/components` adds `operationPending` per component.

`GET /reliability/events` and `WS /metrics/ws` can report:
- `operation.timeout`
- `shutdown.incomplete`

Metrics include:
- `arm.component.<id>.operation_pending`

Note: the in-memory metric is updated at lifecycle transitions; the component
status API is authoritative for the instantaneous pending flag.

## Testing

```bash
npm install
npm run build
npm test
```

Phase 4 tests cover stale generation invalidation, no overlapping recoveries,
cooperative shutdown and reporting incomplete shutdown for stuck operations.

## Not yet guaranteed

- No forced cancellation of uncooperative application code.
- No distributed fencing/leases across nodes or Pods.
- No automatic retry for FAILED components.
- No process-level isolation of CPU-bound tasks.
- No durable recovery history or persisted metrics.

Use workers, separate processes, or external orchestration for stronger
isolation and hard termination.

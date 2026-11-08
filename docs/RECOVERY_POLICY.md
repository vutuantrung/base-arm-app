# Recovery Policy and Fault Tolerance (v3)

This package builds on ARM v2. Health, metrics, REST and WebSocket interfaces remain available.

## Separation of responsibilities

- `recovery-policy.ts`: pure, process-local decisions about retries (budget + circuit).
- `reliability.ts`: component lifecycle, recovery execution and event reporting.
- `metrics.ts`: bounded in-memory metrics registry.
- `adapter-http/src/server.ts`: read-only API and WebSocket transport.

**A health check observes; it never performs recovery itself.** The coordinator applies policy before an attempt, then verifies that a recovered component is HEALTHY.

## Recovery policy configuration

```ts
arm.register({
  component: worker,
  critical: true,
  recovery: {
    enabled: true,
    maxAttempts: 3,                  // per invocation
    baseDelayMs: 500,                // exponential delay between attempts
    maxDelayMs: 5000,
    timeoutMs: 2000,                 // per recover() call
    budgetMaxAttempts: 10,          // shared across monitoring cycles
    budgetWindowMs: 60_000,         // rolling 60-second window
    circuitFailureThreshold: 3,     // consecutive failed attempts
    circuitCooldownMs: 30_000,      // open -> half-open delay
  },
});
```

Recovery guard defaults when omitted: 10 attempts / 60 seconds, threshold 3, cooldown 30 seconds.

### Circuit states

- `CLOSED`: attempts allowed while budget remains.
- `OPEN`: attempts blocked until cooldown ends.
- `HALF_OPEN`: one probe attempt permitted. Success closes circuit; failure reopens it.

A successful recovery resets consecutive failures, but **does not refund retry budget**.
Attempts remain counted until they age out of the rolling window.

### Failure classification

Throw `PermanentRecoveryError` from an adapter for a known non-retryable error
(e.g. invalid configuration). The coordinator stops retrying and marks the
component FAILED. Other thrown errors are retryable only while budget and
circuit policy permit them.

### Reporting

Existing endpoints:

- `GET /metrics`
- `GET /reliability/components`
- `GET /reliability/ready`
- `GET /reliability/events`
- `WS /metrics/ws`, command `{"action":"subscribe_events"}`

Additional component status field: `recoveryGuard`
(`circuit`, `failures`, `attemptsInWindow`, `retryAfterMs`).

Additional event: `recovery.denied` with
`budget_exhausted`, `circuit_open` or `probe_in_progress`.

New metrics:

- `arm.component.<id>.recovery_budget_used`
- `arm.component.<id>.circuit_open`
- `arm.component.<id>.recovery_retry_after_ms`

Metrics only update on lifecycle/health/recovery changes; query component
status for an up-to-date guard snapshot.

## Run

```bash
npm install
npm run build
npm test
npm run dev
```

## Known limitations before Production

1. The timeout helper cannot forcibly cancel an uncooperative asynchronous
   operation. A timed-out recover() can still complete later. Adapters should
   implement cancellation/fencing and make recovery idempotent.
2. Budget and circuit states are in-memory and per process. Restart resets them.
3. No global distributed circuit breaker or cross-pod retry coordination.
4. Retry/backoff has no jitter yet; add jitter for large fleet deployments.
5. Lifecycle FAILED requires explicit intervention or a separate recovery
   strategy; the monitor checks RUNNING components.
6. Repeated denied recovery attempts can generate frequent events;
   a future step should coalesce duplicate denials.
7. Readiness is false if any critical component is not RUNNING and HEALTHY.
8. Recovery and health checks require careful coordination with shutdown,
   especially when an adapter's promise never settles.

## Further improvements

AbortSignal-based cancellation, recovery fencing tokens, reset/reconfigure API
with authentication and audit logging, jitter, and event deduplication.

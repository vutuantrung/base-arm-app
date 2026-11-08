# base-arm-app — Application Reliability Manager (Phase 4)

Reusable process-local Application Reliability Manager components implemented in TypeScript. Includes HTTP JSON and WebSocket reporting; no user interface.

## Quick start

```bash
npm install
npm run dev
npm test
npm run build
```

The server binds to `127.0.0.1:3100` by default. Configure `ARM_METRICS_TOKEN` to require `Authorization: Bearer <token>` for HTTP and WebSocket upgrade requests. Do not expose endpoints without TLS, authentication and network controls.

## HTTP endpoints

- `GET /metrics`: current metrics snapshot.
- `GET /metrics/:name`: individual metric.
- `GET /reliability/components`: component states.
- `GET /reliability/ready`: readiness (200 when ready, 503 otherwise).
- `GET /reliability/events?since=0`: bounded recent recovery and lifecycle history.

## WebSocket

Connect to `ws://127.0.0.1:3100/metrics/ws`. Commands:

```json
{"action":"snapshot","names":["process.uptime_seconds"]}
{"action":"subscribe","names":["process.memory.rss_bytes"]}
{"action":"unsubscribe"}
{"action":"subscribe_events"}
{"action":"unsubscribe_events"}
```

Snapshots arrive immediately on subscription, followed by periodic metrics updates. Recovery events are streamed as `reliability_event` messages.

## Modules

- `packages/core/src/metrics.ts`: bounded metric registry and Node process collector.
- `packages/core/src/reliability.ts`: component registration, lifecycle, health monitoring, recovery coordination, readiness and event history.
- `packages/adapter-http/src/server.ts`: HTTP REST + WebSocket transport.
- `examples/nodejs-api/src/index.ts`: demonstration application.
- `tests/`: registry, HTTP/WS and reliability tests.

## Limitations

This is a starter implementation and must be hardened before production use.

- Metrics, events and recovery counters are process-local and reset on restart.
- Timeout rejects a Promise but does not cancel an underlying component operation.
- Recovery has per-operation timeout, single-flight and bounded attempts per invocation, but no cross-cycle retry budget, cooldown or fencing.
- Event history is in-memory and bounded, not durable.
- No multi-instance aggregation, persisted time series, or UI.
- `process.cpu.percent_of_one_core` may exceed 100% for multi-core workloads.
- `host.*` metrics reflect OS-visible resources, not necessarily container limits.

Run `npm test` and `npm run build` after installing dependencies; these checks were not verified during initial generation because package installation timed out.

## Phase 4 — Recovery Safety

ARM now includes cooperative `AbortSignal` cancellation, generation-based
operation fencing, prevention of overlapping lifecycle operations, and bounded
graceful shutdown with explicit reporting of blocked components. See
[Phase 4 documentation](docs/PHASE_4_RECOVERY_SAFETY.md).

Adapters that perform external side effects should use `context.assertCurrent()`
before committing state. ARM cannot forcibly cancel uncooperative promises.

## Phase 5 — Integration & Reliability Testing

A generic connection adapter is available at
`packages/adapters/src/reconnectable-resource.ts` for swapping healthy
Database or WebSocket sessions while honoring ARM operation fencing.

Integration scenarios: `tests/integration-reliability.test.ts`.
See [Phase 5 instructions](docs/PHASE_5_INTEGRATION_TESTING.md).

To run: `npm install && npm run build && npm test`.

## External Node.js Process Supervisor

The optional `adapter-process` module launches detached Node.js apps, persists PID records, adopts verified Linux processes after Supervisor restart, and connects to each application's existing ARM `/metrics/ws` endpoint.

See [Process Supervisor documentation](docs/PROCESS_SUPERVISOR.md) and `examples/supervisor/src/index.ts`.

```bash
npm install
npm run build
node dist/examples/supervisor/src/index.js
```

Ctrl+C stops the Supervisor and WebSocket collectors, **not the detached app**. Process restart is explicit; WebSocket disconnection alone does not restart an app.

## Dynamic self-registration of external apps

An independently started ARM-enabled Node.js application can register itself with the Supervisor registration API, after which the Supervisor connects to its ARM `/metrics/ws` endpoint. This provides **monitor-only** visibility and does not authorize process stop/restart.

See [Dynamic Registration](docs/DYNAMIC_REGISTRATION.md).

```bash
# Terminal 1
SUPERVISOR_REGISTRATION_TOKEN=development-secret npm run dev:registration
# Terminal 2
SUPERVISOR_REGISTRATION_TOKEN=development-secret PORT=3101 npm run dev
```

# base-arm-app — Metrics Reporting and Reliability v2

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

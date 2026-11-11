# Phase 9 — ARM Client Runtime Bridge

**Branches reviewed:** `arm-supervisor` at Phase 8 and `arm-client` at `0f3fc0bb`.

## Phase Overview

**Why:** Phase 8 injects lightweight process/HTTP telemetry, but has a separate snapshot format and does not expose the full `ArmRuntime` metrics, WebSocket events, registration or component lifecycle implementation.

**Core problem:** A Node application uploaded as ZIP must be monitored by the **real ARM Client SDK** without declaring a dependency on it.

**Root causes:** The SDK was previously available only via manual application integration; an injected process must have a Supervisor-owned copy of the SDK, instance-scoped metrics endpoints and credentials.

**Solution:** Phase 9 adds a **bridge mode** to `ArmRuntimeInjector` that preloads `bridge-bootstrap.mjs` and dynamically loads the *compiled* `ArmRuntime` from the Supervisor installation. Existing `MetricsServer`, `ApplicationRegistrationClient`, `ApplicationRegistrationServer`, `ApplicationRegistry` and `RemoteArmMetricsCollector` are reused, not rewritten.

This is an opt-in, **one-application-per-Supervisor bridge** baseline, not a generalized multi-tenant isolation mechanism.

## Architecture

```mermaid
flowchart TB
  API["Supervisor Management API :3300"] --> M["ProcessManager"]
  M -->|"node --import bridge-bootstrap.mjs entry.js"| CHILD["Node child process"]
  CHILD --> BASE["Phase 8 baseline telemetry"]
  CHILD --> SDK["ARM Client ArmRuntime"]
  SDK --> REST["MetricsServer :3500/3501/3502"]
  SDK --> REGCLIENT["Registration heartbeat"]
  REGCLIENT --> REG["Supervisor RegistrationServer :3200"]
  REG --> COLLECTOR["RemoteArmMetricsCollector"]
  COLLECTOR --> API
```

`arm-client` source modules are installed **in the Supervisor repository**, not inside application releases. Build compiles them to `dist/packages/library/src`, and the bridge preload imports the built module through an absolute, Supervisor-defined path.

## Build and launch

```bash
git switch arm-supervisor
git pull origin arm-supervisor
npm install
npm run build
npm test

export ARM_MANAGEMENT_TOKEN='replace-with-a-long-random-secret'
export ARM_CLIENT_BRIDGE_APP_ID='payment-service'
export ARM_BRIDGE_REGISTRATION_TOKEN='distinct-registration-secret-123'
export ARM_BRIDGE_METRICS_TOKEN='distinct-metrics-secret-456'
export ARM_BRIDGE_REGISTRATION_PORT=3200
export ARM_BRIDGE_METRICS_BASE_PORT=3500
npm run dev:management
```

Setting `ARM_CLIENT_BRIDGE_APP_ID` enables bridge mode, which implicitly enables Phase 8 baseline telemetry. Without it, existing `ARM_AUTO_INJECT=1` continues to select Phase 8 only.

**Important:** `npm run build` is mandatory before first bridge launch and after changing the ARM Client implementation. A missing compiled SDK module stops the child preload; it is not silently replaced by a fake implementation.

Do not simultaneously launch `npm run dev:registration` on the same port: the management daemon now hosts its own registration server in bridge mode.

### Compatibility guard

The bridge is intended for ZIPs with `arm.enabled=false` (such as the uninstrumented payment-service fixture). If the stored manifest has `arm.enabled=true`, the Supervisor refuses to build the bridged process specification for that release. An application already running its own MetricsServer must not be injected with a competing one.

**Only newly spawned processes are bridged.** An already-running, adopted process has not acquired the preload simply because Supervisor was restarted. Roll out or restart that process intentionally.

## Singleton example

Start or restart the installed `payment-service` through Phase 3 API. A bridged singleton uses ARM metrics port **3500** and sends registration heartbeats to **3200**.

```bash
TOKEN='replace-with-a-long-random-secret'
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3300/applications/payment-service/start

curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3300/runtime/bridge/applications

curl -H "Authorization: Bearer distinct-metrics-secret-456" \
  http://127.0.0.1:3500/metrics

curl -H "Authorization: Bearer distinct-metrics-secret-456" \
  http://127.0.0.1:3500/reliability/ready
```

The registration data contains `applicationId`, `instanceId`, `metricsUrl`, connection state, metrics snapshots and their freshness. This is **monitor-only** registration and does not grant arbitrary OS process control.

## Blue/Green example

Add Phase 7 configuration:

```bash
export ARM_BLUE_GREEN_APP_ID='payment-service'
export ARM_PROXY_PORT=3400
export ARM_BLUE_PORT=3401
export ARM_GREEN_PORT=3402
```

A Blue child uses metrics port **3501**, and a Green child uses **3502**. Both are independent `ArmRuntime` instances, sharing only the Supervisor-installed SDK files.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.0.0"}' \
  http://127.0.0.1:3300/blue-green/deploy

curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.1.0"}' \
  http://127.0.0.1:3300/blue-green/deploy
```

Check `GET /runtime/bridge/applications` to see both instance registrations.

## Technical contract

- Node child entrypoint is executed after `--import bridge-bootstrap.mjs`.
- The preload imports Phase 8 telemetry bootstrap and creates a real `ArmRuntime`.
- `ArmRuntime.start()` starts the existing `ReliabilityManager`, `NodeMetricsCollector`, `MetricsServer`, and registration heartbeat.
- The Supervisor RegistrationServer validates a bearer token and only permits loopback metrics WebSocket endpoints.
- MetricsServer separately authenticates HTTP and WebSocket metric retrieval using a **different** bearer token.
- The collector connects to the registered endpoint using that metrics token.
- SDK startup errors are **fatal to the process preload**, preventing an uninstrumented child from continuing silently in bridge mode.

### Endpoint summary

| Endpoint | Port | Auth |
|---|---|---|
| `GET /runtime/bridge/applications` | Management 3300 | Management bearer |
| `POST /applications/register` | Registration 3200 | Registration bearer |
| `GET /applications` | Registration 3200 | Registration bearer |
| `GET /metrics` | Instance 3500/3501/3502 | Metrics bearer |
| `GET /reliability/ready` | Instance 3500/3501/3502 | Metrics bearer |
| `WS /metrics/ws` | Instance 3500/3501/3502 | Metrics bearer |

Ports are defaults; the registration and base metrics ports are configurable. The bridge uses offsets +0 for singleton, +1 for Blue, +2 for Green. Each configuration is scoped to a single `ARM_CLIENT_BRIDGE_APP_ID`. Never run singleton and Blue/Green for the same application concurrently without explicit process ownership planning.

## Critical boundaries

1. **ARM SDK readiness is not business readiness.** With no app-defined registered critical components, `ReliabilityManager` cannot prove that DB connections, queues or payment transactions work. The SDK `/reliability/ready` endpoint must not be promoted to the Phase 6 health gate without a separate application health contract.
2. The bridge cannot magically register dependencies, business-specific health checks, or recover business components that it has never been told about. Doing so still requires application cooperation or separately designed adapters.
3. Automatic injection can coexist with the Phase 7 **business HTTP `/health`** gate; do not substitute SDK readiness for that check.
4. The injected bridge is attached to the main Node process. Child workers/forks/cluster and non-Node runtimes require separate design and compatibility testing.
5. Credentials are passed as child environment variables, so applications can access them. The bridge does not create a security boundary against malicious uploaded ZIPs.
6. Runtime telemetry and registration are currently loopback-only, but the process still needs permission to listen on the selected metrics port.
7. Supervisor-owned SDK files are shared on disk, not in process memory. Updating them does not alter an already-running instance; launch/restart a new process to use the new SDK.
8. Avoid selecting ARM-enabled manifests in bridge mode: they may create duplicate MetricsServer instances.
9. Child startup fails if preloading, SDK import or MetricsServer bind fails. This is deliberate fail-closed behavior.
10. This phase reuses the client-side library entry implementation and current Supervisor-side core modules. Before production, reconcile core code differences, pin a package/release version of the SDK and run compatibility regression tests.

## Files

- `packages/library/src/arm-runtime.ts` — real ARM Client SDK runtime, reused from arm-client.
- `packages/library/src/application-registration-client.ts` — real SDK registration heartbeat, reused from arm-client.
- `packages/adapter-process/runtime/bridge-bootstrap.mjs` — Supervisor-owned SDK preload.
- `packages/adapter-process/src/arm-runtime-injector.ts` — opt-in bridge config, startup args, runtime module path, per-slot metrics ports.
- `examples/supervisor/src/management-api.ts` — integrated RegistrationServer, Registry and collector.
- `packages/adapter-process/src/application-management-api.ts` — bridge instance discovery endpoint.
- `tests/arm-client-bridge-phase9.test.ts` — configuration and real-child integration tests.

## Verification

```bash
npm run build
npm test
```

The integration test waits for registration + collector freshness and verifies the *real* ARM metrics server endpoint and bearer requirement. The test skips its compiled-runtime case if `dist/packages/library/src/arm-runtime.js` does not exist; run `npm run build` first to execute that test.

**Open work:** persistent per-instance credentials, multi-application port leasing, process identity reconciliation for registration, business readiness adapters, package-version compatibility matrix and a unified process-owner state machine.

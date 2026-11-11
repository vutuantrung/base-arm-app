# ARM Supervisor — Environment Configuration

## Start

```bash
cp .env.example .env
# Edit .env; set ARM_MANAGEMENT_TOKEN to a random secret of at least 16 characters.
npm install
npm run build
npm run dev:management
```

Each of the six `examples/` executable entrypoints imports `dotenv/config`
before running. The loader reads `.env` from the working directory, normally
the repository root. If started elsewhere, set `DOTENV_CONFIG_PATH` to the file's
absolute path in the launching environment. Existing OS/container environment
variables take precedence over the file.

The root `.env` is gitignored. Only `.env.example`, which contains no secrets,
is committed. Do not commit real credentials.

## Configuration catalog

| Purpose | Environment variables | Default |
|---|---|---|
| Management API | `ARM_MANAGEMENT_TOKEN`, `ARM_MANAGEMENT_PORT`, `ARM_DEPLOYMENT_ROOT` | Required token, 3300, ./supervisor-data |
| Monitoring | `ARM_MONITOR_INTERVAL_MS`, `ARM_STABLE_RESET_MS` | 1000, 60000 ms |
| Safe rollout | `ARM_ROLLOUT_STABILITY_MS` | 1500 ms |
| Blue/Green | `ARM_BLUE_GREEN_APP_ID`, `ARM_PROXY_PORT`, `ARM_BLUE_PORT`, `ARM_GREEN_PORT` | Disabled, 3400, dynamic Blue/Green ports unless explicitly set |
| Runtime injection | `ARM_AUTO_INJECT`, `ARM_TELEMETRY_INTERVAL_MS` | 0 (off), 1000 ms |
| Client SDK bridge | `ARM_CLIENT_BRIDGE_APP_ID`, `ARM_BRIDGE_REGISTRATION_PORT`, `ARM_BRIDGE_METRICS_BASE_PORT`, `ARM_BRIDGE_REGISTRATION_TOKEN`, `ARM_BRIDGE_METRICS_TOKEN` | Disabled, 3200, 3500, two required distinct secrets |
| Embedded SDK metrics | `ARM_METRICS_TOKEN` | Optional |
| Standalone registration demo | `SUPERVISOR_REGISTRATION_TOKEN`, `SUPERVISOR_PORT` | Required token for demo, 3200 |
| Standalone Node example | `PORT`, `APPLICATION_ID`, `INSTANCE_ID`, `SUPERVISOR_URL` | 3100, example-app, example-app-local, http://127.0.0.1:3200 |

Port 3200 cannot be simultaneously occupied by both `npm run dev:registration`
and the integrated Phase 9 registration server.

### Phase 9 setup

Set the following in your **local** `.env`:

```dotenv
ARM_MANAGEMENT_TOKEN=replace-with-a-long-random-management-secret
ARM_CLIENT_BRIDGE_APP_ID=payment-service
ARM_BRIDGE_REGISTRATION_TOKEN=use-a-different-long-registration-secret
ARM_BRIDGE_METRICS_TOKEN=use-a-third-long-metrics-secret
ARM_BRIDGE_REGISTRATION_PORT=3200
ARM_BRIDGE_METRICS_BASE_PORT=3500
```

For Phase 7 add `ARM_BLUE_GREEN_APP_ID=payment-service` and configure its
ports. Application ZIPs and their manifests do not need a `.env`.

## Internally generated process variables

`ARM_APPLICATION_ID`, `ARM_INSTANCE_ID`, `ARM_INJECTION_ENABLED`,
`ARM_TELEMETRY_ROOT`, `ARM_SAMPLE_INTERVAL_MS`, `ARM_BRIDGE_ENABLED`,
`ARM_BRIDGE_METRICS_PORT`, `ARM_BRIDGE_MODULE_PATH`,
`ARM_BRIDGE_REGISTRATION_URL`, `NODE_ENV` and `HOST`
are injected by the Supervisor or process specification. **Do not** put
them in the root `.env`.

Note: the current ProcessManager inherits all of Supervisor's environment into
child processes. This means child code can potentially read management secrets.
Moving secrets into `.env` does not solve this isolation issue. Production
hardening should introduce an allowlisted child environment and per-instance
credentials.

Changing `.env` requires restarting the Supervisor to change daemon settings;
already-running child applications retain their original environment. Use a
controlled restart/rollout to update injection-related settings for those apps.

## Dynamic child HTTP ports and peer discovery

The Supervisor now assigns an ephemeral HTTP port whenever a child application's
`application-config.json` does not specify `environment.PORT`. The root
Supervisor `.env` `PORT` is **not** inherited by managed child processes.

Create the optional operator-owned file (outside the immutable release ZIP):

```text
supervisor-data/applications/payment-service/application-config.json
```

```json
{
  "schemaVersion": 1,
  "environment": {
    "LOG_LEVEL": "info"
  }
}
```

If you need to pin the singleton app to a port, add `"PORT": "3201"`.
For Blue/Green, do not set application `PORT`; two slots must bind separate
endpoints. The optional Supervisor `ARM_BLUE_PORT` and `ARM_GREEN_PORT` may
still pin slot ports for compatibility, but should normally be left blank.

A newly spawned child receives `PORT`, `HOST=127.0.0.1`,
`ARM_DISCOVERY_URL` and `ARM_DISCOVERY_TOKEN` (the latter two only if the
root Supervisor has `ARM_DISCOVERY_TOKEN` configured). A child can discover
another managed HTTP app:

```js
const response = await fetch(
  process.env.ARM_DISCOVERY_URL + '/runtime/endpoints/user-service',
  { headers: { authorization: `Bearer ${process.env.ARM_DISCOVERY_TOKEN}` } },
);
if (!response.ok) throw new Error('Peer not available');
const { url } = await response.json();
const peer = await fetch(url + '/health');
```

The discovery endpoint is loopback-only and only lists managed processes with
verified RUNNING state and a responding local HTTP endpoint.
An HTTP response (even 404) proves connectivity, **not business readiness**.
For a Blue/Green app the published service URL points at the stable proxy,
not the active child slot. Use `GET /runtime/endpoints` to list all candidates.
The restricted discovery bearer token cannot access other Management API
routes; do not distribute the management token to children.

**Limitations:** Child apps must honor `process.env.PORT` and `HOST`; an
application that hardcodes a port cannot be controlled by allocation alone.
The ephemeral-port probe closes before the child binds, so another process can
take that port (TOCTOU race). Production hardening needs socket handoff or
bind/retry confirmation. This discovery implementation covers only HTTP apps
on the same network namespace and is not a Kubernetes service registry.
Existing running children preserve old port/environment settings until a
controlled restart. Configuration changes are loaded when Supervisor builds
new process specifications (usually after Supervisor restart or release
activation), then applied when the child starts again.

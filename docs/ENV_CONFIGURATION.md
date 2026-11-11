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
| Blue/Green | `ARM_BLUE_GREEN_APP_ID`, `ARM_PROXY_PORT`, `ARM_BLUE_PORT`, `ARM_GREEN_PORT` | Disabled, 3400, 3401, 3402 |
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

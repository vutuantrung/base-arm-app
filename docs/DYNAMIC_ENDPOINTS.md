# Dynamic Child HTTP Endpoints and Service Discovery

## Why

ARM Supervisor must support many Node.js applications without assigning a
fixed HTTP port to every release. The previous implementation allowed the
Supervisor root `.env` to leak a demo `PORT` into child apps and Phase 7
Blue/Green required two fixed slot ports.

The new contract is **if an app has no `environment.PORT`, Supervisor
allocates a dynamic port before spawn**. Each child receives the resolved
`PORT` and `HOST=127.0.0.1`. The assigned port is saved in its durable
process registry alongside the PID and the PID start-time identity.

## Application-owned configuration

Optional operator-managed file, outside immutable release ZIP:

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

Missing file and missing `PORT` both cause dynamic allocation.

For a singleton application that requires a specific port:

```json
{
  "schemaVersion": 1,
  "environment": {
    "PORT": "3201",
    "LOG_LEVEL": "info"
  }
}
```

Only port 1–65535 is accepted. The root Supervisor `.env` `PORT` does not
count as an app-defined port. The `ChildEnvironmentBuilder` rejects
`ARM_*`, `SUPERVISOR_*`, `NODE_OPTIONS`, `NODE_ENV`, `HOST` from
application config but permits a validated `PORT`.

For Blue/Green, *do not* configure an application `PORT`, because both slots
must bind different endpoints. Leaving Supervisor `ARM_BLUE_PORT` and
`ARM_GREEN_PORT` empty uses dynamic ports. Configuring either option
explicitly pins that slot for backwards compatibility.

## Service discovery for child-to-child HTTP calls

Set a dedicated restricted token in the Supervisor root `.env`:

```dotenv
ARM_DISCOVERY_TOKEN=replace-with-a-strong-discovery-secret
```

The Supervisor injects the following values into managed children:

- `PORT` — dynamic or explicitly configured HTTP port
- `HOST` — `127.0.0.1`
- `ARM_DISCOVERY_URL` — `http://127.0.0.1:3300` by default
- `ARM_DISCOVERY_TOKEN` — restricted bearer token (not management bearer)

A child application can resolve a peer:

```js
async function resolvePeer(applicationId) {
  const response = await fetch(
    `${process.env.ARM_DISCOVERY_URL}/runtime/endpoints/${applicationId}`,
    {
      headers: {
        authorization: `Bearer ${process.env.ARM_DISCOVERY_TOKEN}`,
      },
    },
  );
  if (!response.ok) throw new Error(`Peer unavailable: ${applicationId}`);
  return (await response.json()).url;
}

const userServiceUrl = await resolvePeer('user-service');
const response = await fetch(`${userServiceUrl}/users`);
```

The discovery response is **not a stable routing alias** for singleton
applications: their direct URL can change after restart. A caller must
refresh it after connection failures. The Phase 7 Blue/Green application's
published URL is its stable proxy URL instead of the child slot port.

### Read-only endpoints

| Endpoint | Token | Response |
|---|---|---|
| `GET /runtime/endpoints` | Discovery or management | Reachable managed HTTP services |
| `GET /runtime/endpoints/:id` | Discovery or management | Specific reachable HTTP service, otherwise 404 |
| Other management routes | Management token only | Unchanged |

Example response:

```json
{
  "applicationId": "payment-service",
  "instanceId": "payment-service-managed",
  "url": "http://127.0.0.1:41783",
  "host": "127.0.0.1",
  "port": 41783,
  "mode": "singleton",
  "reachable": true
}
```

Discovery returns endpoints only if the process is PID-verified RUNNING and
an HTTP request to the endpoint returns a valid HTTP response within 400 ms.
A `404` on `/health` still confirms the HTTP port is reachable; it does **not**
confirm business readiness.

The discovery token is shared between children and must be treated as a
restricted internal secret. It cannot call deployment, process control or
release management API endpoints. Do not pass `ARM_MANAGEMENT_TOKEN` to apps.

## Restart and recovery

- The assigned `port` is persisted in `state/processes.json` or
  `state/blue-green-processes.json`.
- An adopted living process keeps its original port. Supervisor does not
  reassign the port on restart.
- When a process really exits, its next spawn can receive a new dynamic port.
  Other applications should re-query discovery after failures.
- For legacy Phase 7 running slots whose registry lacked `port`, the
  Supervisor restores it from the Blue/Green journal after PID verification.
- Updates to `application-config.json` are read when process specs are
  assembled at Supervisor startup or release activation. Restart Supervisor
  to reload configuration before restarting the child.

## Limitations / hardening

1. **The application must honor `process.env.PORT`.** A Node.js HTTP server
   that hardcodes a port is not made dynamic just by setting environment values.
2. The current allocator asks the OS for an ephemeral available port, then
   closes the probe socket before child spawn. Another process might take it
   before the child binds (**TOCTOU race**). This is a practical baseline,
   not a guarantee of atomic port assignment. Future work should implement
   socket handoff or dynamic bind with readiness/IPC feedback.
3. An HTTP response confirms connectivity, not the identity of the service
   behind an unexpectedly reused port. Application-level readiness and
   authenticated service identity remain future work.
4. Discovery URLs use loopback and work only for children sharing the same
   network namespace as the Supervisor. They are not accessible from remote
   containers, Kubernetes pods or other hosts.
5. A child can read its own discovery token. For hostile multi-tenant apps,
   use separate security identities and a dedicated sidecar/gateway instead.
6. `PORT` is the business HTTP port; ARM MetricsServer still uses the separate
   metrics port policy from Phase 9.
7. This is an HTTP discovery API, not DNS, service mesh, WS routing or L7
   load balancing. Clients must handle timeouts, failures and reconnects.

## Tests

```bash
npm run build
npm test
```

Added integration coverage for explicit/dynamic ports, distinct processes,
persisted process-port identity, HTTP discovery filtering and token scoping,
and Blue/Green dynamic port recovery.

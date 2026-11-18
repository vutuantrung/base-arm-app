# Child Process Logging & Diagnostics — Increment 1

## Enable

Set `ARM_CHILD_LOGGING=1` in the root .env, then `npm run build` and restart the management daemon. Restart a managed app via its authenticated POST /applications/:id/restart endpoint. Existing/adopted processes keep their original output descriptors; enabling this feature does not redirect them until their next launch. Disabled by default for backward compatibility and storage safety.

## Ownership

ProcessManager remains the only process owner. ChildProcessLogs owns log file allocation and bounded reads. SupervisorHost supplies a shared store to singleton and Blue/Green managers. The Management API exposes read-only authenticated endpoints. No SDK, injection, manifest or process registry migration is required. Logs use ProcessSpec.id (e.g. aab or payment-service-blue), not the ARM telemetry instance ID.

## Storage and usage

Each launch creates logs/<processId>/<runId> underneath ARM_DEPLOYMENT_ROOT:
- stdout.log and stderr.log are direct child file descriptors, not Supervisor pipes.
- diagnostics.log contains JSON lines for launch, spawned, observed exit and launch_failed, with process/application/instance IDs, release version when available, PID and exit code/signal when observed. No environment or full command-line dump. Diagnostic journal is best effort; after the Supervisor exits it cannot observe the child's exit.
- Run IDs are timestamp-prefixed unique directory names; newest first. Recovery attempts retain their own logs.

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/runtime/processes/aab/logs"
curl -H "Authorization: Bearer $TOKEN" "$BASE/runtime/processes/aab/logs/stderr?bytes=16384"
curl -H "Authorization: Bearer $TOKEN" "$BASE/runtime/processes/aab/logs/diagnostics"
tail -f supervisor-data/logs/aab/<runId>/stderr.log
```

GET /runtime/processes/:id/logs lists runs. GET /runtime/processes/:id/logs/:stream accepts stdout, stderr or diagnostics, optional run=<runId> and bytes=1..65536 (default 16384). Returns a JSON tail, byte size, truncation flag and run identity. Unknown run/file: 404. Invalid query: 400. Only management bearer authentication is accepted, not discovery token. Byte tails may split UTF-8 or a line. This is not a streaming endpoint.

## Operational limitations

No automatic rotation, retention, quota or WebSocket streaming in this increment. Use an operator-owned storage root with disk monitoring/quota and restricted access. Remove only completed/verified stopped run directories; never delete or rename active log files expecting new descriptors to follow. Logs may contain secrets printed by application code; do not expose or share them indiscriminately. File permissions are restricted on POSIX; Windows relies on its ACLs. Path input is validated; the storage root and its directories must be trusted, not writable by untrusted applications. ARM does not sandbox child code. Output is preserved across supervisor restart via OS descriptors, while exit diagnostics are limited to the observing Supervisor. A log allocation failure fails the launch explicitly. Disk-full writes are handled by the child/OS, not intercepted. Automatic rotation and retention need a design compatible with detached process ownership.

## Verification

Run npm run build, npm run check:architecture, node --import tsx --test tests/child-process-logs.test.ts, then npm test. Existing Blue/Green baseline issues are outside this increment.

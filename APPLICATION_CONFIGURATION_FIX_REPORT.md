# ARM Application Configuration Fix Report

## Confirmed root cause

`ApplicationConfigurationStore.read()` resolved the file beneath the effective `ApplicationStorage.root` at `applications/<applicationId>/application-config.json`, and `ApplicationLifecycleManager.createProcessSpec()` copied its environment into `ProcessSpec.applicationEnv`. However, the spec was only created at release activation and supervisor initialization. `ProcessManager` retained that snapshot and used it for later starts, restarts, and runtime recovery. A configuration file created or edited after either snapshot was taken therefore never reached the spawned child. This explains why EServer 2 could keep its stale/default port (3002) instead of the configured 3012; the code path is application agnostic and also affected AAB.

An isolated lifecycle reproduction created a release, initialized the supervisor, and activated it before creating `application-config.json`. The actual spawned Node child returned its `PORT` and a custom setting over HTTP. Updating the file before restart and again before recovery produced the new values and configured ports in the actual child each time.

## Implementation

- Manual start refreshes the spec from current config while the process is stopped. If the app is already running, start remains idempotent and does not change its environment.
- Manual restart reads and validates current config first, stops the child under the existing lifecycle operation lock and ProcessManager ownership, registers the refreshed spec, then starts the new child. PID verification and stop safeguards remain in ProcessManager.
- Runtime automatic recovery calls the same lifecycle start path, so it uses current config. Supervisor startup loads current config for initial specs; any subsequent recovery start refreshes again.
- Configuration diagnostics include resolved path, found/missing state, environment variable names, and resolved child HTTP port. Values are never logged.
- Optional missing-file behavior remains an empty environment. JSON/schema/entry validation and reserved-key rejection remain in place.

## Verification

- Actual child integration: config created after activation, changed before restart, changed before recovery; `PORT` and custom `CUSTOM_SETTING` verified through the child's HTTP response.
- Missing config remains optional; invalid JSON is rejected; reserved application environment keys remain rejected.
- Existing actual-child port test verified two applications receive distinct ports.
- `npm run build`: passed.
- `npm run check:architecture`: passed.
- `npm run verify`: build and architecture checks passed; test suite ran 108 tests with 104 passing. Two existing unrelated failures remain: `blue-green-phase7.test.ts` reads `arm.enabled` from undefined test metadata, and `dynamic-registration.test.ts` supplies an interval below the existing 1000 ms minimum (its test file also remains pending). The requested configuration integration test passed. No changes were made to address those unrelated failures.

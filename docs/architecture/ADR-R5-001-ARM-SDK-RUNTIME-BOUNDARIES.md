# ADR-R5-001 — Canonical SDK and Supervisor Injection Packages

**Status:** Accepted for R5 source extraction; build/test verification pending.

## Context

Embedded ARM runtime lived in `packages/library`; Phase 8/9 preloads and
injector lived in `adapter-process`. The Phase 9 bridge points at an absolute
compiled SDK path. Reorganizing without legacy runtime artifacts would break
new process starts and could disrupt running processes adopted by Supervisor.

## Decision

- `@arm/client-sdk` owns the SDK implementation and registration client.
- `@arm/runtime-injection` owns preload asset files, launch injection policy
  and Phase 8 snapshot reader with an R1 `TelemetryReader` adapter.
- Keep `packages/core` and `packages/adapter-http` as SDK internals.
- Keep `packages/library/src`, `adapter-process/src` compatibility
  re-exports and both compiled preload asset directories.
- Prefer canonical compiled `arm-client-sdk` artifact, falling back to the
  legacy `library` artifact for compatibility.
- Preserve the `arm.metrics.v1` wire protocol and Phase 8 snapshot schema.

## Consequences

No business application code rewrites and no new network services.
Adopted child processes retain their existing preload paths.
This is a private workspace version, not an externally published npm SDK.
The SDK's internal metrics/reliability modules are still separate packages.
Build/test execution and deployment verification remain required.

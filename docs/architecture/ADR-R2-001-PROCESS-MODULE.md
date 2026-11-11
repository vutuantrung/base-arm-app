# ADR-R2-001 — Move ProcessManager Behind a Public Module Entry Point

**Status:** Accepted for R2 source extraction.  
**Date:** 2026-11-11

**Context:** In Phase R1, the process manager was embedded in `adapter-process`
and imported the concrete `ArmRuntimeInjector`, causing OS process execution
to depend on a specific ARM SDK implementation.

**Decision:** Move `ProcessManager`, `DynamicPortAllocator` and
`ChildEnvironmentBuilder` to `packages/process-manager`; introduce
`ProcessLaunchInstrumentation` as a type-only inbound port; implement the
R1 `ProcessController` interface using an explicit adapter. Keep the old
source paths as re-exports while consumers migrate incrementally.

**Consequences:** No runtime network boundary or persistence migration.
`ProcessControllerAdapter` cannot assert HTTP readiness based solely
on spawn and reports an `ASSIGNED` port. The adapter is opt-in, and the
old management API continues using legacy ProcessManager signatures.

**Follow-up:** Verify build and integration tests locally; add explicit
child bind acknowledgment and startup logs in future phases.

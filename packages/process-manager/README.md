# @arm/process-manager

Phase R2 extracted the ARM Supervisor's durable OS process lifecycle into
an independently named npm-workspace package.

## Public entrypoint

Import from `src/index.ts` (NodeNext source import path: `./index.js`):

- `ProcessManager` — existing durable singleton and Blue/Green process owner.
- `ProcessControllerAdapter` — R1 `ProcessController` port adapter.
- `ChildEnvironmentBuilder` — allowlisted child environment creation.
- `DynamicPortAllocator` — available-port selection and process-local claims.
- `ProcessLaunchInstrumentation` — optional preload/environment integration port.

This module must not import concrete deployment, monitoring, or ARM SDK
implementation classes. The optional `ArmRuntimeInjector` is supplied by
the host at construction time through `ProcessLaunchInstrumentation`.

Legacy paths under `packages/adapter-process/src` are compatibility
re-exports and are not alternative copies of the process implementation.

See [Phase R2](../../docs/PHASE_R2_PROCESS_MANAGEMENT_EXTRACTION.md).

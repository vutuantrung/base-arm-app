# ARM Module Contracts — Phase R1

`src/index.ts` is the initial public *type-only* contract catalog for the
future modular monolith. These types are intentionally independent of
`adapter-process`, `adapter-http` and ARM Client implementations.

**Not yet active:** The current Supervisor does not provide concrete
implementations of `ProcessController`, `PackageCatalog`, `ReleaseSelector`,
`EndpointDirectory`, `TrafficRouter`, etc. The R2–R5 migration will
supply explicit adapters and conformance tests.

Do not import private files from another domain module here. Do not
add runtime dependencies or OS process/HTTP server objects to public
contract data transfer objects.

Architecture and ownership: [Phase R1](../../../docs/PHASE_R1_MODULE_BOUNDARIES_AND_CONTRACTS.md).

## Phase R3 update

`PackageCatalog` is now implemented by `PackageCatalogAdapter` in
`packages/package-manager`. `ReleaseSelector` is implemented by
`ReleaseSelectorAdapter` in `packages/deployment-manager`.
These are explicit opt-in adapters; existing application lifecycle callers
have not all migrated to contracts yet.

## Phase R4 update

`EndpointDirectory` is now implemented by `EndpointDirectoryAdapter` in
`@arm/service-discovery`; `TrafficRouter` by
`BlueGreenTrafficRouterAdapter` in `@arm/traffic-router`. These adapters
are opt-in and the legacy Blue/Green orchestration is not rewired yet.

## Phase R5 update

The `TelemetryReader` port now has `ArmTelemetryReaderAdapter` in
`@arm/runtime-injection`. This is a read-only projection of Phase 8
snapshot data and does not infer process liveness or application readiness.

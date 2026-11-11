# ADR-R4-001 — Separate Recovery, Discovery and HTTP Forwarding

**Status:** Accepted as a source extraction; test execution pending.

The Supervisor is a modular monolith, not a fleet of independent
microservices. Runtime recovery policy and durable desired state belong to
`@arm/runtime-monitor`; registration leases and reachable endpoint lookup
belong to `@arm/service-discovery`; HTTP proxy route/switch/drain belong
to `@arm/traffic-router`.

These packages use small structural ports, not imports of concrete
`ApplicationLifecycleManager` or `BlueGreenDeploymentManager` classes.

`BlueGreenDeploymentManager` remains a coordinator outside traffic-router.
All previous source paths remain re-export shims, state schemas and HTTP
APIs remain unchanged. Migration into the application composition root is R6.

The `EndpointDirectoryAdapter` and `BlueGreenTrafficRouterAdapter`
implement the R1 interfaces without claiming readiness based solely on
spawn or a responding HTTP service.

Verification requires build/test execution before production acceptance.

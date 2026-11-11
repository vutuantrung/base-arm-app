# ADR-R6-001 — Supervisor Composition Root and Dependency Gate

**Status:** Accepted for source refactor; runtime verification pending.
**Date:** 2026-11-11

## Decision

Extract the Supervisor Management daemon's object graph and resource
ownership into `@arm/supervisor-host`. Its `SupervisorHost` explicitly
assembles process lifecycle, release/rollout, monitoring, registration, discovery
and Blue/Green coordination, then controls their startup/shutdown order.

The CLI becomes a thin entrypoint for env, logging and process signals.
No global process signal handling is placed inside the reusable host class.

Introduce `scripts/check-architecture.mjs` to prohibit forbidden cross-package
imports and cycles among extracted modules, and run it in CI with build/tests.

## Rationale

A single composition root makes startup and cleanup testable and removes
implicit dependency ownership from a 7k-line-ish setup script (previously
~7 KB). A dependency gate keeps R1–R5 boundaries from regressing.

## Compatibility and open decisions

Keep the same REST routes, state files, recovery strategy, metrics/registration
protocol and detached-child policy. The legacy deployment coordinators
continue to own process/release orchestration until separately migrated.

This phase does **not** provide a global single-writer operation coordinator
across monitor auto-recovery and deployment/BlueGreen workflows. Implement
one only after designing lock scope and crash recovery semantics.

CI uses `npm install` until a lockfile is committed. Full test execution is
required before production acceptance.

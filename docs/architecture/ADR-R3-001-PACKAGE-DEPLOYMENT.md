# ADR-R3-001 — Separate Immutable Packages from Release Orchestration

**Status:** Accepted (source structure; runtime verification pending)  
**Date:** 2026-11-11

## Decision

Extract two npm workspaces: `@arm/package-manager` owns ZIP extraction,
validation and immutable installed releases; `@arm/deployment-manager`
owns release activation history, audit and safe rollout orchestration.
All existing source import paths stay as re-export shims during migration.

`ApplicationReleaseManager` and `SafeRolloutManager` accept structural
runtime ports instead of importing the concrete `ApplicationRuntimeMonitor`.

Provide R1 adapters `PackageCatalogAdapter` and `ReleaseSelectorAdapter`.
No change to existing HTTP API, persisted JSON schemas, ZIP manifest contract
or process lifecycle behavior.

## Consequences

- Direct implementation cycles are reduced, but `ApplicationLifecycleManager`
  remains a mixed release/process orchestration class for later refactor.
- This is a modular-monolith boundary, not a new process/service.
- Existing API callers continue to use runtime manager constructors.
- Safe rollout remains a journaled compensating saga, not an atomic database
  transaction.
- Build/tests must be executed before accepting this phase for production.

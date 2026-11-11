## Phase R6 — Composition Root and Enforcement

- [Phase R6 — Composition Root and Dependency Enforcement](../PHASE_R6_COMPOSITION_ROOT_AND_ENFORCEMENT.md)
- [ADR-R6-001 — Composition Root and Dependency Gate](./ADR-R6-001-COMPOSITION-ROOT.md)

## Phase R5 — ARM SDK and Runtime Injection

- [Phase R5 — ARM Runtime & SDK Consolidation](../PHASE_R5_ARM_RUNTIME_SDK_CONSOLIDATION.md)
- [ADR-R5-001 — SDK / Runtime Injection Boundaries](./ADR-R5-001-ARM-SDK-RUNTIME-BOUNDARIES.md)

## Phase R4 — Monitoring, Discovery & Routing

- [Phase R4 — Module Extraction](../PHASE_R4_MONITORING_DISCOVERY_ROUTING_EXTRACTION.md)
- [ADR-R4-001 — Module Ownership](./ADR-R4-001-MONITORING-DISCOVERY-ROUTING.md)

## Phase R3 — Package & Deployment Extraction

- [Phase R3 — Package & Deployment Extraction](../PHASE_R3_PACKAGE_AND_DEPLOYMENT_EXTRACTION.md)
- [ADR-R3-001 — Package/Deployment Ownership](./ADR-R3-001-PACKAGE-DEPLOYMENT.md)

## Phase R2 — Process Module Extraction

- [Phase R2 Process Management Extraction](../PHASE_R2_PROCESS_MANAGEMENT_EXTRACTION.md)
- [ADR-R2-001 Process Module](./ADR-R2-001-PROCESS-MODULE.md)

## Refactoring architecture baseline

- [Phase R1 — Module Boundaries & Contracts](../PHASE_R1_MODULE_BOUNDARIES_AND_CONTRACTS.md)
- [ARM Supervisor Architecture & Lifecycle Checkpoint](../ARM_SUPERVISOR_ARCHITECTURE_CHECKPOINT.md)
- [Coding Standards](../CODING_STANDARDS.md)

# ARM Architecture Diagrams

Các sơ đồ Mermaid thể hiện cấu trúc và luồng hoạt động của Application Reliability Manager.

- [01 — System Architecture](01-system-architecture.md)
- [02 — Recovery Sequence](02-recovery-sequence.md)
- [03 — Component Relationships](03-relationships.md)

Sơ đồ biểu diễn **vai trò logic** và luồng tích hợp, không mặc định mô tả các service hoặc import trực tiếp. Health Monitoring, Lifecycle và Recovery Coordination hiện là trách nhiệm nằm chủ yếu trong `ReliabilityManager`.

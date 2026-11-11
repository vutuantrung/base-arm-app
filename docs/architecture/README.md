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

# ARM — System Architecture

Sơ đồ biểu diễn các nhóm thành phần, adapter, ARM core và luồng metrics/reporting.

```mermaid
flowchart TB
  subgraph Application["Application Components"]
    API["HTTP API"]
    WS["WebSocket Client"]
    DB["Database"]
    WK["Background Worker"]
  end
  subgraph Adapters["Component Adapters"]
    RR["ReconnectableResource"]
    MC["ManagedComponent contract"]
  end
  subgraph ARM["ARM Core"]
    RM["ReliabilityManager"]
    REG["Component Registry"]
    HM["Health Monitoring"]
    LM["Lifecycle Management"]
    RC["Recovery Coordination"]
    RP["RecoveryGuard"]
    OM["OperationManager"]
    RM --> REG
    RM --> HM
    RM --> LM
    RM --> RC
    RC --> RP
    RC --> OM
    LM --> OM
  end
  subgraph Reporting["Metrics and Reporting"]
    MR["MetricsRegistry"]
    EV["Reliability Events"]
    MS["MetricsServer (HTTP / WS)"]
    MR --> MS
    EV --> MS
  end
  subgraph Consumers["External Consumers"]
    REST["REST Client"]
    WSC["WebSocket Subscriber"]
  end
  DB --> RR
  WS --> RR
  RR --> MC
  API --> MC
  WK --> MC
  MC --> REG
  HM --> MR
  RC --> MR
  RM --> EV
  MS --> REST
  MS --> WSC
```

## Source mapping

| Thành phần | Source |
|---|---|
| Reliability Manager, Registry, Health, Lifecycle, Recovery | `packages/core/src/reliability.ts` |
| RecoveryGuard | `packages/core/src/recovery-policy.ts` |
| OperationManager | `packages/core/src/operations.ts` |
| MetricsRegistry | `packages/core/src/metrics.ts` |
| ReconnectableResource | `packages/adapters/src/reconnectable-resource.ts` |
| MetricsServer | `packages/adapter-http/src/server.ts` |

**Lưu ý:** Mũi tên là quan hệ kiến trúc/tích hợp, không phải quan hệ import. Application Components là ví dụ, không nhất thiết có implementation production sẵn trong repo.

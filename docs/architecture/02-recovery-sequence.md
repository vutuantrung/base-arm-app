# ARM — Health Detection and Recovery Sequence

```mermaid
sequenceDiagram
  autonumber
  participant H as Health Monitoring
  participant R as ReliabilityManager
  participant P as RecoveryGuard
  participant O as OperationManager
  participant C as ManagedComponent
  participant M as MetricsRegistry
  participant W as MetricsServer / WS
  H->>C: checkHealth(signal)
  C-->>H: UNHEALTHY
  H->>R: Report status
  R->>M: Update health metrics
  R->>P: acquire()
  alt Recovery allowed
    P-->>R: allowed
    R->>O: execute(recover, timeout)
    O->>C: recover(OperationContext)
    alt Success
      C-->>O: completed
      O-->>R: success
      R->>C: checkHealth(signal)
      C-->>R: HEALTHY
      R->>P: succeeded()
      R->>M: Update metrics
      R-->>W: recovery.succeeded event
    else Failure or timeout
      O-->>R: Error / Timeout
      R->>P: failed()
      R->>M: Update failure metrics
      R-->>W: recovery.failed event
      Note over O,C: Timeout aborts signal; work may remain pending
    end
  else Recovery denied
    P-->>R: circuit open / budget exhausted
    R-->>W: recovery.denied event
  end
```

## Nguyên tắc

1. Health Check chỉ quan sát, không tự phục hồi.
2. RecoveryGuard quyết định quyền thử lại trước mỗi attempt.
3. OperationManager cấp AbortSignal, timeout và generation.
4. ARM chỉ ghi nhận success khi health verification trả về HEALTHY.
5. Metrics và events phản ánh trạng thái nhưng không trực tiếp điều khiển recovery.
6. Timeout không cưỡng chế dừng các Promise không hợp tác; adapter cần áp dụng cancellation/fencing.

Sequence là các bước logic, không ngụ ý tất cả participant là các service độc lập.

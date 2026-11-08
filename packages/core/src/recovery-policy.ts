/**
 * Recovery decisions are kept separate from business code and the coordinator.
 * State is process-local and uses a monotonic clock for intervals.
 */
export interface RecoveryLimits {
  /** Maximum attempts allowed in one rolling time window. */
  budgetMaxAttempts?: number;
  budgetWindowMs?: number;
  /** Pause automatic recovery after repeated failures. */
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type RecoveryDenial = 'budget_exhausted' | 'circuit_open' | 'probe_in_progress';

export interface RecoveryDecision {
  allowed: boolean;
  reason?: RecoveryDenial;
  retryAfterMs?: number;
}

export interface RecoveryGuardSnapshot {
  circuit: CircuitState;
  failures: number;
  attemptsInWindow: number;
  retryAfterMs: number;
}

export class PermanentRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentRecoveryError';
  }
}

const defaultLimits: Required<RecoveryLimits> = {
  budgetMaxAttempts: 10,
  budgetWindowMs: 60_000,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
};

export class RecoveryGuard {
  private readonly limits: Required<RecoveryLimits>;
  private attempts: number[] = [];
  private failures = 0;
  private openUntil = 0;
  private circuit: CircuitState = 'CLOSED';
  private probeInProgress = false;

  constructor(
    limits: RecoveryLimits = {},
    private readonly now: () => number = () => performance.now(),
  ) {
    this.limits = { ...defaultLimits, ...limits };

    const { budgetMaxAttempts, budgetWindowMs, circuitFailureThreshold, circuitCooldownMs } =
      this.limits;

    if (
      !Number.isInteger(budgetMaxAttempts) || budgetMaxAttempts < 1 ||
      !Number.isFinite(budgetWindowMs) || budgetWindowMs < 1 ||
      !Number.isInteger(circuitFailureThreshold) || circuitFailureThreshold < 1 ||
      !Number.isFinite(circuitCooldownMs) || circuitCooldownMs < 1
    ) {
      throw new Error('Invalid recovery limits');
    }
  }

  private prune(now: number): void {
    this.attempts = this.attempts.filter(at => now - at < this.limits.budgetWindowMs);
  }

  /**
   * Reserve a recovery attempt. Even unsuccessful recovery calls consume budget.
   * Half-open permits exactly one probe.
   */
  acquire(): RecoveryDecision {
    const now = this.now();
    this.prune(now);

    if (this.circuit === 'OPEN') {
      if (now < this.openUntil) {
        return {
          allowed: false,
          reason: 'circuit_open',
          retryAfterMs: this.openUntil - now,
        };
      }
      this.circuit = 'HALF_OPEN';
    }

    if (this.probeInProgress) {
      return { allowed: false, reason: 'probe_in_progress' };
    }

    if (this.attempts.length >= this.limits.budgetMaxAttempts) {
      const oldest = this.attempts[0];
      return {
        allowed: false,
        reason: 'budget_exhausted',
        retryAfterMs: Math.max(0, this.limits.budgetWindowMs - (now - oldest)),
      };
    }

    this.attempts.push(now);

    if (this.circuit === 'HALF_OPEN') {
      this.probeInProgress = true;
    }

    return { allowed: true };
  }

  succeeded(): void {
    this.failures = 0;
    this.circuit = 'CLOSED';
    this.openUntil = 0;
    this.probeInProgress = false;
    // Do not clear budget: success does not refund resource expenditure.
  }

  failed(): void {
    this.failures++;
    this.probeInProgress = false;

    if (
      this.circuit === 'HALF_OPEN' ||
      this.failures >= this.limits.circuitFailureThreshold
    ) {
      this.circuit = 'OPEN';
      this.openUntil = this.now() + this.limits.circuitCooldownMs;
    }
  }

  snapshot(): RecoveryGuardSnapshot {
    const now = this.now();
    this.prune(now);

    return {
      circuit: this.circuit === 'OPEN' && now >= this.openUntil
        ? 'HALF_OPEN'
        : this.circuit,
      failures: this.failures,
      attemptsInWindow: this.attempts.length,
      retryAfterMs: this.circuit === 'OPEN'
        ? Math.max(0, this.openUntil - now)
        : 0,
    };
  }
}

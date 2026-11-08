import { EventEmitter } from 'node:events';
import type { MetricsRegistry } from './metrics.js';
import {
  RecoveryGuard,
  PermanentRecoveryError,
  type RecoveryLimits,
  type RecoveryGuardSnapshot,
} from './recovery-policy.js';
import {
  OperationManager,
  OperationAbortedError,
  OperationTimeoutError,
  type OperationContext,
} from './operations.js';
import { VALID_ID_PATTERN } from '../../shared/constants.js';
import { describe, delay } from '../../shared/helpers.js';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
export type LifecycleStatus =
  | 'CREATED' | 'STARTING' | 'RUNNING' | 'RECOVERING'
  | 'STOPPING' | 'STOPPED' | 'FAILED';

export interface HealthResult {
  status: HealthStatus;
  reason?: string;
  checkedAt: string;
}

/** Existing adapters without context parameters continue to work. */
export interface ManagedComponent {
  id: string;
  start(context?: OperationContext): Promise<void>;
  stop(context?: OperationContext): Promise<void>;
  checkHealth(signal?: AbortSignal): Promise<HealthResult>;
  recover?(context?: OperationContext): Promise<void>;
}

export interface RecoveryPolicy extends RecoveryLimits {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export interface ComponentRegistration {
  component: ManagedComponent;
  critical: boolean;
  recovery: RecoveryPolicy;
}

export interface ComponentStatus {
  id: string;
  critical: boolean;
  lifecycle: LifecycleStatus;
  health: HealthResult;
  recoveryAttempts: number;
  lastRecoveryAt?: string;
  recoveryGuard?: RecoveryGuardSnapshot;
  operationPending: boolean;
}

export type ReliabilityEventType =
  | 'lifecycle' | 'health'
  | 'recovery.started' | 'recovery.succeeded' | 'recovery.failed'
  | 'recovery.denied' | 'operation.timeout' | 'shutdown.incomplete';

export interface ReliabilityEvent {
  sequence: number;
  timestamp: string;
  componentId: string;
  type: ReliabilityEventType;
  detail?: string;
}

export interface ReliabilityOptions {
  checkIntervalMs?: number;
  healthTimeoutMs?: number;
  eventHistoryLimit?: number;
  shutdownGraceMs?: number;
}

export interface ShutdownResult {
  clean: boolean;
  blockedComponents: string[];
}

const healthValues: Record<HealthStatus, number> = {
  UNKNOWN: -1,
  UNHEALTHY: 0,
  DEGRADED: 1,
  HEALTHY: 2,
};

/**
 * Coordinates process-local lifecycle, health monitoring and recovery.
 * External side effects must honor OperationContext for fencing to be effective.
 */
export class ReliabilityManager extends EventEmitter {
  private readonly registrations = new Map<string, ComponentRegistration>();
  private readonly states = new Map<string, ComponentStatus>();
  private readonly guards = new Map<string, RecoveryGuard>();
  private readonly operations = new OperationManager();
  private readonly recovering = new Map<string, Promise<void>>();
  private readonly checking = new Set<string>();
  private readonly events: ReliabilityEvent[] = [];

  private sequence = 0;
  private monitor?: NodeJS.Timeout;
  private active = false;
  private stopping = false;
  private shutdownTask?: Promise<ShutdownResult>;

  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly options: ReliabilityOptions = {},
  ) {
    super();

    if ((options.checkIntervalMs ?? 5000) < 100) {
      throw new Error('checkIntervalMs must be >= 100');
    }
    if ((options.healthTimeoutMs ?? 2000) < 1) {
      throw new Error('healthTimeoutMs must be positive');
    }
    if ((options.eventHistoryLimit ?? 200) < 1) {
      throw new Error('eventHistoryLimit must be positive');
    }
    if ((options.shutdownGraceMs ?? 3000) < 1) {
      throw new Error('shutdownGraceMs must be positive');
    }
  }

  /**
   * Register a new component with its recovery policy.
   * Must be called before the manager is started.
   * @param registration The component registration containing its recovery policy.
   */
  register(registration: ComponentRegistration): void {
    if (this.active || this.stopping) {
      throw new Error('Cannot register after start');
    }

    const { component, recovery } = registration;
    if (!VALID_ID_PATTERN.test(component.id) || this.registrations.has(component.id)) {
      throw new Error('Invalid or duplicate component id');
    }

    if (
      !Number.isInteger(recovery.maxAttempts)
      || recovery.maxAttempts < 0
      || ![recovery.baseDelayMs, recovery.maxDelayMs, recovery.timeoutMs].every(Number.isFinite)
      || recovery.baseDelayMs < 0
      || recovery.maxDelayMs < recovery.baseDelayMs
      || recovery.timeoutMs < 1
    ) {
      throw new Error('Invalid recovery policy');
    }

    this.guards.set(component.id, new RecoveryGuard(recovery));
    this.registrations.set(component.id, registration);
    this.states.set(component.id, {
      id: component.id,
      critical: registration.critical,
      lifecycle: 'CREATED',
      health: { status: 'UNKNOWN', checkedAt: new Date().toISOString() },
      recoveryAttempts: 0,
      operationPending: false,
    });
    this.publishMetrics(component.id);
  }

  /**
   * Record an event related to a component's reliability.
   * @param id The component ID.
   * @param type The type of reliability event.
   * @param detail Optional detail about the event.
   */
  private event(id: string, type: ReliabilityEventType, detail?: string): void {
    const item: ReliabilityEvent = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      componentId: id,
      type,
      ...(detail ? { detail } : {}),
    };

    this.events.push(item);
    if (this.events.length > (this.options.eventHistoryLimit ?? 200)) {
      this.events.shift();
    }
    this.emit('event', item);
  }

  /**
   * Publish the current metrics for a component.
   * @param id The component ID.
   */
  private publishMetrics(id: string): void {
    const state = this.states.get(id)!;
    const guard = this.guards.get(id)?.snapshot();

    this.metrics.gauge(`arm.component.${id}.health`, healthValues[state.health.status], 'state');
    this.metrics.gauge(`arm.component.${id}.running`, state.lifecycle === 'RUNNING' ? 1 : 0, 'boolean');
    this.metrics.gauge(`arm.component.${id}.recovery_attempts`, state.recoveryAttempts, 'count');
    this.metrics.gauge(`arm.component.${id}.operation_pending`, this.operations.hasActive(id) ? 1 : 0, 'boolean');

    if (guard) {
      this.metrics.gauge(`arm.component.${id}.recovery_budget_used`, guard.attemptsInWindow, 'count');
      this.metrics.gauge(`arm.component.${id}.circuit_open`, guard.circuit === 'CLOSED' ? 0 : 1, 'boolean');
      this.metrics.gauge(`arm.component.${id}.recovery_retry_after_ms`, guard.retryAfterMs, 'milliseconds');
    }

    const states = [...this.states.values()];
    this.metrics.gauge('arm.components.total', states.length, 'count');
    this.metrics.gauge('arm.components.healthy', states.filter(s => s.health.status === 'HEALTHY').length, 'count');
    this.metrics.gauge('arm.components.unhealthy', states.filter(s => s.health.status === 'UNHEALTHY').length, 'count');
  }

  /**
   * Update the lifecycle status of a component.
   * @param id The component ID.
   * @param value The new lifecycle status.
   */
  private lifecycle(id: string, value: LifecycleStatus): void {
    this.states.get(id)!.lifecycle = value;
    this.publishMetrics(id);
    this.event(id, 'lifecycle', value);
  }

  /**
   * Update the health status of a component.
   * @param id The component ID.
   * @param result The new health result.
   */
  private updateHealth(id: string, result: HealthResult): void {
    const state = this.states.get(id)!;
    const previous = state.health.status;
    state.health = { ...result };
    this.publishMetrics(id);

    if (previous !== result.status) {
      this.event(id, 'health', `${previous} -> ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
    }
  }

  /**
   * Perform a health check for a component.
   * @param id The component ID.
   * @returns The result of the health check.
   */
  private async healthCheck(id: string): Promise<HealthResult> {
    const component = this.registrations.get(id)!.component;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.healthTimeoutMs ?? 2000);

    let result: HealthResult;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new OperationTimeoutError('health')), { once: true });
      });
      result = await Promise.race([component.checkHealth(controller.signal), timeoutPromise]);
      if (!(result.status in healthValues)) {
        throw new Error('Invalid health result');
      }
      result = {
        ...result,
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      result = {
        status: 'UNHEALTHY',
        reason: describe(error),
        checkedAt: new Date().toISOString()
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }

    if (!this.stopping) this.updateHealth(id, result);
    return result;
  }

  /**
   * Check the health of a single component and trigger recovery if necessary.
   * @param id The component ID.
   */
  private async checkOne(id: string): Promise<void> {
    if (this.stopping || this.checking.has(id) || this.recovering.has(id)) return;
    if (this.states.get(id)?.lifecycle !== 'RUNNING') return;

    this.checking.add(id);
    try {
      const health = await this.healthCheck(id);
      if (!this.stopping && health.status === 'UNHEALTHY') {
        void this.recover(id).catch(error => this.event(id, 'recovery.failed', describe(error)));
      }
    } finally {
      this.checking.delete(id);
    }
  }

  /**
   * Check the health of all registered components.
   */
  async checkAll(): Promise<void> {
    await Promise.all([...this.registrations.keys()].map(id => this.checkOne(id)));
  }

  /**
   * Start the manager and all registered components.
   */
  async start(): Promise<void> {
    if (this.active || this.stopping) {
      throw new Error('Manager already started or stopping');
    }
    this.active = true;

    for (const [id, registration] of this.registrations) {
      if (this.stopping) break;
      this.lifecycle(id, 'STARTING');

      try {
        await this.operations.execute(
          id, 'start', registration.recovery.timeoutMs,
          context => registration.component.start(context),
        );
        if (this.stopping) break;
        this.lifecycle(id, 'RUNNING');
        await this.healthCheck(id);
      } catch (error) {
        if (error instanceof OperationTimeoutError) {
          this.event(id, 'operation.timeout', 'start');
        }
        if (this.stopping) break;
        this.updateHealth(id, {
          status: 'UNHEALTHY',
          reason: describe(error),
          checkedAt: new Date().toISOString(),
        });
        this.lifecycle(id, 'FAILED');
      }
    }

    if (this.stopping) return;
    this.monitor = setInterval(() => {
      void this.checkAll().catch(error => this.event('arm', 'health', describe(error)));
    }, this.options.checkIntervalMs ?? 5000);
    this.monitor.unref();
  }

  /**
   * Attempt to recover a component.
   * @param id The component ID.
   * @returns A promise that resolves when recovery is complete.
   */
  recover(id: string): Promise<void> {
    const existing = this.recovering.get(id);
    if (existing) return existing;

    const registration = this.registrations.get(id);
    if (!registration) return Promise.reject(new Error('Unknown component'));

    const { component, recovery } = registration;
    const lifecycle = this.states.get(id)!.lifecycle;

    if (
      !this.active || this.stopping || !recovery.enabled || !component.recover ||
      !['RUNNING', 'FAILED'].includes(lifecycle)
    ) {
      return Promise.resolve();
    }

    if (this.operations.hasActive(id)) {
      this.event(id, 'recovery.denied', 'operation_pending');
      return Promise.resolve();
    }

    const task = this.runRecovery(id, component, recovery)
      .finally(() => this.recovering.delete(id));

    this.recovering.set(id, task);
    return task;
  }

  /**
   * Execute the recovery process for a component according to its policy.
   * @param id The component ID.
   * @param component The managed component.
   * @param policy The recovery policy.
   * @returns A promise that resolves when recovery is complete.
   */
  private async runRecovery(
    id: string,
    component: ManagedComponent,
    policy: RecoveryPolicy,
  ): Promise<void> {
    const guard = this.guards.get(id)!;
    const previousLifecycle = this.states.get(id)!.lifecycle;
    let mustQuarantine = false;

    for (let attempt = 1; attempt <= policy.maxAttempts && !this.stopping; attempt++) {
      if (attempt > 1) {
        const backoff = policy.baseDelayMs * 2 ** Math.min(attempt - 2, 20);
        await delay(Math.min(policy.maxDelayMs, backoff));
      }
      if (this.stopping) break;

      const decision = guard.acquire();
      if (!decision.allowed) {
        this.event(id, 'recovery.denied', decision.reason);
        break;
      }

      this.lifecycle(id, 'RECOVERING');
      const state = this.states.get(id)!;
      state.recoveryAttempts++;
      state.lastRecoveryAt = new Date().toISOString();
      this.publishMetrics(id);
      this.event(id, 'recovery.started', `attempt ${attempt}`);

      const startedAt = performance.now();

      try {
        await this.operations.execute(
          id, 'recover', policy.timeoutMs,
          context => component.recover!(context),
        );
        if (this.stopping) return;

        const result = await this.healthCheck(id);
        if (result.status !== 'HEALTHY') {
          throw new Error(`Recovery verification: ${result.status}`);
        }

        guard.succeeded();
        this.metrics.gauge(
          `arm.component.${id}.last_recovery_duration_ms`,
          performance.now() - startedAt, 'milliseconds',
        );
        this.metrics.increment('arm.recovery.success_total');
        this.event(id, 'recovery.succeeded', `attempt ${attempt}`);
        this.lifecycle(id, 'RUNNING');
        return;
      } catch (error) {
        if (this.stopping || error instanceof OperationAbortedError) return;

        guard.failed();
        this.metrics.increment('arm.recovery.failure_total');
        this.event(id, 'recovery.failed', describe(error));

        if (error instanceof OperationTimeoutError) {
          this.event(id, 'operation.timeout', 'recover');
          mustQuarantine = true;
          break;
        }

        if (error instanceof PermanentRecoveryError) {
          mustQuarantine = true;
          break;
        }

        if (this.operations.hasActive(id)) {
          mustQuarantine = true;
          break;
        }
      }
    }

    if (!this.stopping) {
      this.lifecycle(
        id,
        mustQuarantine || previousLifecycle === 'FAILED' ? 'FAILED' : 'RUNNING',
      );
    }
  }

  /**
   * Get the current status of all components.
   * @returns An array of component statuses.
   */
  statuses(): ComponentStatus[] {
    return [...this.states.values()].map(state => ({
      ...state,
      health: { ...state.health },
      recoveryGuard: this.guards.get(state.id)?.snapshot(),
      operationPending: this.operations.hasActive(state.id),
    }));
  }

  /**
   * Get recent events since a given sequence number.
   * @param since The sequence number to start from.
   * @returns An array of recent events.
   */
  recentEvents(since = 0): ReliabilityEvent[] {
    return this.events.filter(event => event.sequence > since).map(event => ({ ...event }));
  }

  /**
   * Get the readiness status of the system.
   * @returns An object indicating overall readiness and the status of critical components.
   */
  readiness(): { ready: boolean; components: Array<{ id: string; lifecycle: LifecycleStatus; health: HealthStatus }> } {
    const critical = this.statuses().filter(state => state.critical);
    return {
      ready: this.active && !this.stopping && critical.every(
        state => state.lifecycle === 'RUNNING' && state.health.status === 'HEALTHY' && !state.operationPending,
      ),
      components: critical.map(state => ({
        id: state.id, lifecycle: state.lifecycle, health: state.health.status,
      })),
    };
  }

  /**
   * Reentrant calls share the same shutdown promise.
   * @returns A promise that resolves with the shutdown result.
   */
  stop(): Promise<ShutdownResult> {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    this.shutdownTask = this.shutdown();
    return this.shutdownTask;
  }

  /**
   * Perform the shutdown sequence for all components.
   * @returns A promise that resolves with the shutdown result.
   */
  private async shutdown(): Promise<ShutdownResult> {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    this.operations.abortAll();

    const graceMs = this.options.shutdownGraceMs ?? 3000;
    await this.operations.waitForIdle(graceMs);
    const blockedComponents: string[] = [];

    for (const [id, registration] of [...this.registrations].reverse()) {
      if (this.operations.hasActive(id)) {
        // Never overlap stop() with a lingering recovery operation.
        blockedComponents.push(id);
        this.lifecycle(id, 'FAILED');
        this.event(id, 'shutdown.incomplete', 'Uncooperative operation remains active');
        continue;
      }

      this.lifecycle(id, 'STOPPING');
      try {
        await this.operations.execute(
          id, 'stop', registration.recovery.timeoutMs,
          context => registration.component.stop(context),
        );
        if (this.operations.hasActive(id)) throw new Error('Stop operation still pending');
        this.lifecycle(id, 'STOPPED');
      } catch (error) {
        blockedComponents.push(id);
        this.lifecycle(id, 'FAILED');
        this.event(id, 'shutdown.incomplete', describe(error));
      }
    }

    this.active = false;
    return { clean: blockedComponents.length === 0, blockedComponents };
  }
}

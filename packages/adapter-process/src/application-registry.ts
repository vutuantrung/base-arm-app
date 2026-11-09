import { EventEmitter } from 'node:events';
import type { RemoteArmMetricsCollector } from './remote-arm-metrics-collector.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

export type ApplicationDiscoveryStatus =
  | 'REGISTERED' | 'CONNECTED' | 'STALE' | 'DISCONNECTED' | 'EXPIRED';

export type ExternalProcessStatus = 'UNKNOWN';

export interface ApplicationRegistration {
  applicationId: string;
  instanceId: string;
  metricsUrl: string;
}

export interface RegisteredApplication extends ApplicationRegistration {
  id: string;
  registeredAt: string;
  lastSeenAt: string;
  expiresAt: string;
  status: ApplicationDiscoveryStatus;
  statusChangedAt: string;
  /** External registration grants monitoring only; it does not prove OS process liveness. */
  processStatus: ExternalProcessStatus;
  management: 'monitor-only';
}

export interface ApplicationStateTransition {
  id: string;
  previous: ApplicationDiscoveryStatus;
  current: ApplicationDiscoveryStatus;
  changedAt: string;
}

export interface DiscoveryQuery {
  status?: ApplicationDiscoveryStatus;
  applicationId?: string;
  includeExpired?: boolean;
}

function isInvalidApplicationId(applicationId: string, instanceId: string): boolean {
  return !IDENTIFIER_PATTERN.test(applicationId) || !IDENTIFIER_PATTERN.test(instanceId);
}

function isInvalidMetricsEndpoint(metricsUrl: string): boolean {
  let url: URL;
  try { url = new URL(metricsUrl); } catch { return true; }

  return url.protocol !== 'ws:'
    || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/metrics/ws'
    || !!url.search || !!url.hash || !!url.username || !!url.password;
}

function validateRegistration(input: ApplicationRegistration): void {
  if (isInvalidApplicationId(input.applicationId, input.instanceId)) {
    throw new Error('Invalid applicationId or instanceId');
  }
  if (isInvalidMetricsEndpoint(input.metricsUrl)) {
    throw new Error('Only loopback ws://127.0.0.1:<port>/metrics/ws is allowed');
  }
}

/**
 * In-memory discovery for externally started applications.
 * Discovery status is the *monitoring* status, never an OS process health claim.
 */
export class ApplicationRegistry extends EventEmitter {
  private readonly apps = new Map<string, RegisteredApplication>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly transitions: ApplicationStateTransition[] = [];
  private closed = false;

  constructor(
    private readonly collector: RemoteArmMetricsCollector,
    private readonly targetMetricsToken?: string,
    private readonly leaseMs = 45000,
    private readonly expiredRetentionMs = 300000,
  ) {
    super();
    if (leaseMs < 3000) throw new Error('leaseMs must be >= 3000');
    if (expiredRetentionMs < 0) throw new Error('expiredRetentionMs must be >= 0');

    this.collector.on('connected', this.onCollectorEvent);
    this.collector.on('disconnected', this.onCollectorEvent);
    this.collector.on('metrics', this.onCollectorEvent);
    this.collector.on('connection_error', this.onCollectorEvent);

    this.sweepTimer = setInterval(
      () => this.refreshStates(), Math.min(this.leaseMs, 1000),
    );
    this.sweepTimer.unref();
  }

  static idOf(applicationId: string, instanceId: string): string {
    return `${applicationId}/${instanceId}`;
  }

  register(input: ApplicationRegistration): RegisteredApplication {
    this.assertOpen();
    validateRegistration(input);
    const id = ApplicationRegistry.idOf(input.applicationId, input.instanceId);
    const now = new Date();
    const previous = this.apps.get(id);

    const record: RegisteredApplication = {
      ...input,
      id,
      registeredAt: previous?.registeredAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      status: previous?.status === 'EXPIRED' ? 'REGISTERED' : previous?.status ?? 'REGISTERED',
      statusChangedAt: previous?.status === 'EXPIRED'
        ? now.toISOString() : previous?.statusChangedAt ?? now.toISOString(),
      processStatus: 'UNKNOWN',
      management: 'monitor-only',
    };

    this.apps.set(id, record);
    this.collector.upsert({
      id,
      metricsUrl: input.metricsUrl,
      metricsToken: this.targetMetricsToken,
    });

    if (previous?.status === 'EXPIRED') {
      this.emitStateTransition(record, 'EXPIRED', 'REGISTERED', now.toISOString());
    } else {
      this.updateStatus(record, now.getTime());
    }
    this.emit('registered', { ...record });
    return { ...record };
  }

  get(id: string): RegisteredApplication | undefined {
    this.refreshStates();
    const app = this.apps.get(id);
    return app ? { ...app } : undefined;
  }

  list(query: DiscoveryQuery = {}): RegisteredApplication[] {
    this.refreshStates();
    return [...this.apps.values()]
      .filter(app => this.matchesDiscoveryQuery(app, query))
      .map(app => ({ ...app }));
  }

  recentTransitions(limit = 100): ApplicationStateTransition[] {
    const safeLimit = Math.max(0, Math.min(200, Math.trunc(limit)));
    if (safeLimit === 0) return [];
    return this.transitions.slice(-safeLimit).map(transition => ({ ...transition }));
  }

  unregister(id: string): boolean {
    const existed = this.apps.delete(id);
    if (!existed) return false;
    this.collector.remove(id);
    this.emit('unregistered', { id });
    return true;
  }

  expire(now = Date.now()): void {
    this.refreshStates(now);
  }

  /** Re-evaluate leases and stale snapshots; also called periodically. */
  refreshStates(now = Date.now()): void {
    if (this.closed) return;

    for (const app of this.apps.values()) {
      this.updateStatus(app, now);
      if (this.shouldPurgeExpiredRecord(app, now)) {
        this.apps.delete(app.id);
        this.emit('purged', { id: app.id });
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    this.collector.off('connected', this.onCollectorEvent);
    this.collector.off('disconnected', this.onCollectorEvent);
    this.collector.off('metrics', this.onCollectorEvent);
    this.collector.off('connection_error', this.onCollectorEvent);
    for (const id of this.apps.keys()) this.collector.remove(id);
    this.apps.clear();
  }

  private readonly onCollectorEvent = (event: { id: string }): void => {
    const app = this.apps.get(event.id);
    if (app) this.updateStatus(app, Date.now());
  };

  private updateStatus(app: RegisteredApplication, now: number): void {
    const next = this.resolveStatus(app, now);
    if (app.status === next) return;

    const previous = app.status;
    const timestamp = new Date(now).toISOString();
    app.status = next;
    app.statusChangedAt = timestamp;
    this.emitStateTransition(app, previous, next, timestamp);

    if (next === 'EXPIRED') {
      this.collector.remove(app.id);
      this.emit('expired', { id: app.id });
    }
  }

  private resolveStatus(app: RegisteredApplication, now: number): ApplicationDiscoveryStatus {
    if (now >= Date.parse(app.expiresAt)) return 'EXPIRED';
    if (app.status === 'EXPIRED') return 'EXPIRED';

    const metrics = this.collector.get(app.id);
    if (!metrics) return 'REGISTERED';
    if (!metrics.connected) {
      return metrics.lastError || metrics.disconnectedAt ? 'DISCONNECTED' : 'REGISTERED';
    }
    if (this.collector.isFresh(app.id, now)) return 'CONNECTED';

    const lastActivity = metrics.lastSnapshotAt ?? metrics.connectedAt;
    if (lastActivity && now - Date.parse(lastActivity) >= this.collector.freshnessMs) {
      return 'STALE';
    }
    return 'CONNECTED';
  }

  private shouldPurgeExpiredRecord(app: RegisteredApplication, now: number): boolean {
    return app.status === 'EXPIRED'
      && now >= Date.parse(app.expiresAt) + this.expiredRetentionMs;
  }

  private matchesDiscoveryQuery(app: RegisteredApplication, query: DiscoveryQuery): boolean {
    if (!query.includeExpired && app.status === 'EXPIRED') return false;
    if (query.status && app.status !== query.status) return false;
    if (query.applicationId && app.applicationId !== query.applicationId) return false;
    return true;
  }

  private emitStateTransition(
    app: RegisteredApplication,
    previous: ApplicationDiscoveryStatus,
    current: ApplicationDiscoveryStatus,
    changedAt: string,
  ): void {
    const transition: ApplicationStateTransition = {
      id: app.id, previous, current, changedAt,
    };
    this.transitions.push(transition);
    if (this.transitions.length > 200) this.transitions.shift();
    this.emit('state_changed', transition);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ApplicationRegistry already closed');
  }
}

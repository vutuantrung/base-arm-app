import { EventEmitter } from 'node:events';
import type { RemoteArmMetricsCollector } from './remote-arm-metrics-collector.js';

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

export interface ApplicationRegistration {
  applicationId: string;
  instanceId: string;
  metricsUrl: string;
}

export interface RegisteredApplication extends ApplicationRegistration {
  id: string;
  lastSeenAt: string;
  /** A registration lease; absence of heartbeat expires monitoring, not process. */
  expiresAt: string;
  management: 'monitor-only';
}

function validate(reg: ApplicationRegistration): void {
  if (!identifier.test(reg.applicationId) || !identifier.test(reg.instanceId)) {
    throw new Error('Invalid applicationId or instanceId');
  }
  let url: URL;
  try { url = new URL(reg.metricsUrl); } catch { throw new Error('Invalid metricsUrl'); }
  // Version 1 allows ONLY loopback to avoid server-side request forgery.
  // Exact IP literals prevent DNS rebinding; remote hosts require an explicit allowlist.
  if (url.protocol !== 'ws:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/metrics/ws' || url.search || url.hash ||
      url.username || url.password) {
    throw new Error('Only loopback ws://127.0.0.1:<port>/metrics/ws is allowed');
  }
}

export class ApplicationRegistry extends EventEmitter {
  private readonly apps = new Map<string, RegisteredApplication>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly collector: RemoteArmMetricsCollector,
    private readonly targetMetricsToken?: string,
    private readonly leaseMs = 45000,
  ) {
    super();
    if (leaseMs < 3000) throw new Error('leaseMs must be >= 3000');
    this.sweepTimer = setInterval(() => this.expire(), Math.min(leaseMs, 5000));
    this.sweepTimer.unref();
  }

  static idOf(applicationId: string, instanceId: string): string {
    return `${applicationId}/${instanceId}`;
  }

  register(input: ApplicationRegistration): RegisteredApplication {
    validate(input);
    const id = ApplicationRegistry.idOf(input.applicationId, input.instanceId);
    const now = Date.now();
    const record: RegisteredApplication = {
      ...input, id, management: 'monitor-only',
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.leaseMs).toISOString(),
    };
    this.apps.set(id, record);
    this.collector.upsert({
      id, metricsUrl: input.metricsUrl, metricsToken: this.targetMetricsToken,
    });
    this.emit('registered', { ...record });
    return { ...record };
  }

  get(id: string): RegisteredApplication | undefined {
    const record = this.apps.get(id);
    return record ? { ...record } : undefined;
  }

  list(): RegisteredApplication[] {
    return [...this.apps.values()].map(x => ({ ...x }));
  }

  unregister(id: string): boolean {
    const existed = this.apps.delete(id);
    if (existed) {
      this.collector.remove(id);
      this.emit('unregistered', { id });
    }
    return existed;
  }

  expire(now = Date.now()): void {
    for (const [id, app] of this.apps) {
      if (Date.parse(app.expiresAt) <= now) {
        this.unregister(id);
        this.emit('expired', { id });
      }
    }
  }

  close(): void {
    clearInterval(this.sweepTimer);
    for (const id of this.apps.keys()) this.collector.remove(id);
    this.apps.clear();
  }
}

import { MetricsRegistry, NodeMetricsCollector } from '../../core/src/metrics.js';
import {
  ReliabilityManager,
  type ComponentRegistration,
  type ReliabilityOptions,
  type ShutdownResult,
} from '../../core/src/reliability.js';
import { MetricsServer, type MetricsServerOptions } from '../../adapter-http/src/server.js';
import {
  ApplicationRegistrationClient,
  type RegistrationClientOptions,
  type RegistrationErrorHandler,
} from './application-registration-client.js';

export interface ArmRuntimeConfig {
  /** ARM-managed dependencies. Register them before starting the runtime. */
  components?: ComponentRegistration[];
  reliability?: ReliabilityOptions;
  metrics?: {
    maxMetrics?: number;
    collectionIntervalMs?: number;
    server?: MetricsServerOptions;
  };
  /** Optional registration with a separate Supervisor. No process control is granted. */
  supervisor?: Omit<RegistrationClientOptions, 'metricsUrl'> & {
    /** Override only when Supervisor reaches a different advertised endpoint. */
    metricsUrl?: string;
    onError?: RegistrationErrorHandler;
  };
}

export type ArmRuntimeStatus = 'CREATED' | 'STARTING' | 'RUNNING' |
  'STOPPING' | 'STOPPED' | 'FAILED';

/**
 * One-entry-point ARM setup for a Node.js application.
 * Owns component lifecycle, collection, telemetry HTTP/WS and optional registration.
 * Never installs global signal handlers or terminates the host process.
 */
export class ArmRuntime {
  readonly metrics: MetricsRegistry;
  readonly reliability: ReliabilityManager;
  readonly nodeMetrics: NodeMetricsCollector;
  readonly metricsServer: MetricsServer;

  private registration?: ApplicationRegistrationClient;
  private startTask?: Promise<void>;
  private stopTask?: Promise<ShutdownResult>;
  private statusValue: ArmRuntimeStatus = 'CREATED';
  private metricsServerStarted = false;

  constructor(private readonly config: ArmRuntimeConfig = {}) {
    this.metrics = new MetricsRegistry(config.metrics?.maxMetrics);
    this.reliability = new ReliabilityManager(this.metrics, config.reliability);
    this.nodeMetrics = new NodeMetricsCollector(
      this.metrics, config.metrics?.collectionIntervalMs,
    );
    this.metricsServer = new MetricsServer(
      this.metrics, config.metrics?.server, this.reliability,
    );
    this.registerComponents(config.components ?? []);
    this.validateSupervisorConfiguration();
  }

  get status(): ArmRuntimeStatus {
    return this.statusValue;
  }

  /** Start once. Concurrent calls share one startup operation. */
  start(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.statusValue !== 'CREATED') {
      return Promise.reject(new Error('ARM runtime cannot be restarted after shutdown'));
    }
    this.statusValue = 'STARTING';
    this.startTask = this.startInternal();
    return this.startTask;
  }

  /** Graceful, idempotent shutdown. Does not kill the Node.js process. */
  stop(): Promise<ShutdownResult> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = this.stopInternal();
    return this.stopTask;
  }

  readiness(): ReturnType<ReliabilityManager['readiness']> {
    return this.reliability.readiness();
  }

  private registerComponents(components: ComponentRegistration[]): void {
    for (const registration of components) {
      this.reliability.register(registration);
    }
  }

  private validateSupervisorConfiguration(): void {
    const supervisor = this.config.supervisor;
    if (!supervisor) return;
    if (!supervisor.metricsUrl && !this.hasReachableLocalMetricsEndpoint()) {
      throw new Error(
        'Supervisor metricsUrl is required when metrics server binds a non-loopback host or port 0',
      );
    }
  }

  private hasReachableLocalMetricsEndpoint(): boolean {
    const server = this.config.metrics?.server;
    return (server?.port ?? 3100) > 0 &&
      ['127.0.0.1', 'localhost', '::1'].includes(server?.host ?? '127.0.0.1');
  }

  private async startInternal(): Promise<void> {
    try {
      await this.reliability.start();
      this.nodeMetrics.start();
      await this.metricsServer.start();
      this.metricsServerStarted = true;
      this.startSupervisorRegistration();
      this.statusValue = 'RUNNING';
    } catch (error) {
      this.statusValue = 'FAILED';
      await this.cleanupAfterFailedStart();
      throw error;
    }
  }

  private startSupervisorRegistration(): void {
    const supervisor = this.config.supervisor;
    if (!supervisor) return;

    const { onError, ...registrationConfig } = supervisor;
    this.registration = new ApplicationRegistrationClient({
      ...registrationConfig,
      metricsUrl: supervisor.metricsUrl ?? this.defaultMetricsUrl(),
    });
    this.registration.start(onError);
  }

  private defaultMetricsUrl(): string {
    const host = this.config.metrics?.server?.host ?? '127.0.0.1';
    const port = this.config.metrics?.server?.port ?? 3100;
    const hostname = host === '::1' ? '[::1]' : host;
    return `ws://${hostname}:${port}/metrics/ws`;
  }

  private async cleanupAfterFailedStart(): Promise<void> {
    this.registration?.stop();
    this.nodeMetrics.stop();
    if (this.metricsServerStarted) {
      await this.metricsServer.stop().catch(() => {});
      this.metricsServerStarted = false;
    }
    await this.reliability.stop().catch(() => {});
  }

  private async stopInternal(): Promise<ShutdownResult> {
    if (this.statusValue === 'CREATED') {
      this.statusValue = 'STOPPED';
      return { clean: true, blockedComponents: [] };
    }

    // Stop may arrive while startup is in progress.
    await this.startTask?.catch(() => {});
    this.statusValue = 'STOPPING';

    this.registration?.stop();
    this.nodeMetrics.stop();
    if (this.metricsServerStarted) {
      await this.metricsServer.stop();
      this.metricsServerStarted = false;
    }

    const result = await this.reliability.stop();
    this.statusValue = 'STOPPED';
    return result;
  }
}

/** Create a configured ARM runtime without starting any background tasks. */
export function createArmRuntime(config: ArmRuntimeConfig = {}): ArmRuntime {
  return new ArmRuntime(config);
}

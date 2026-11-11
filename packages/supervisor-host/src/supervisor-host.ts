import { resolve, join } from 'node:path';
import { ApplicationLifecycleManager } from '../../adapter-process/src/application-lifecycle-manager.js';
import { ApplicationManagementApi } from '../../adapter-process/src/application-management-api.js';
import { BlueGreenDeploymentManager } from '../../adapter-process/src/blue-green-deployment-manager.js';
import { ApplicationRuntimeMonitor, RuntimeStateStore } from '../../runtime-monitor/src/index.js';
import { ApplicationReleaseManager, SafeRolloutManager } from '../../deployment-manager/src/index.js';
import { ArmRuntimeInjector, ArmTelemetryReader } from '../../runtime-injection/src/index.js';
import {
  ApplicationEndpointDiscovery, ApplicationRegistry,
  ApplicationRegistrationServer, RemoteArmMetricsCollector,
} from '../../service-discovery/src/index.js';

export type SupervisorHostState = 'CREATED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED';

export interface SupervisorHostLogger {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

export interface SupervisorHostOptions {
  /** Resolve configuration only from the explicitly supplied environment. */
  environment: NodeJS.ProcessEnv;
  logger?: SupervisorHostLogger;
}

/**
 * Composition root for ARM Supervisor. Owns the service graph and the
 * order of startup/teardown, but never owns business application state.
 * Detatched children remain alive when the host is stopped.
 */
export class SupervisorHost {
  readonly lifecycle: ApplicationLifecycleManager;
  readonly monitor: ApplicationRuntimeMonitor;
  readonly releases: ApplicationReleaseManager;
  readonly rollout: SafeRolloutManager;
  readonly blueGreen?: BlueGreenDeploymentManager;
  readonly registry?: ApplicationRegistry;
  readonly collector?: RemoteArmMetricsCollector;
  readonly registrationServer?: ApplicationRegistrationServer;
  readonly endpoints: ApplicationEndpointDiscovery;
  readonly api: ApplicationManagementApi;

  private readonly logger: SupervisorHostLogger;
  private stateValue: SupervisorHostState = 'CREATED';
  private collectorStarted = false;
  private registrationStarted = false;
  private blueGreenStarted = false;
  private monitoringStarted = false;
  private apiStarted = false;
  private closed = false;

  constructor(options: SupervisorHostOptions) {
    const env = options.environment;
    this.logger = options.logger ?? console;
    const token = env.ARM_MANAGEMENT_TOKEN;
    if (!token || token.length < 16) {
      throw new Error('Set ARM_MANAGEMENT_TOKEN (at least 16 characters)');
    }

    const storageRoot = resolve(env.ARM_DEPLOYMENT_ROOT ?? './supervisor-data');
    const managementPort = this.readPort(env.ARM_MANAGEMENT_PORT, 3300, true);
    const bridgeId = env.ARM_CLIENT_BRIDGE_APP_ID;
    const registrationPort = this.readPort(env.ARM_BRIDGE_REGISTRATION_PORT, 3200);
    const bridgeRegistrationToken = env.ARM_BRIDGE_REGISTRATION_TOKEN;
    const bridgeMetricsToken = env.ARM_BRIDGE_METRICS_TOKEN;
    const injectionEnabled = env.ARM_AUTO_INJECT === '1' || !!bridgeId;
    const telemetryRoot = join(storageRoot, 'telemetry');
    const runtimeEnv = env.ARM_DISCOVERY_TOKEN ? {
      ARM_DISCOVERY_URL: `http://127.0.0.1:${managementPort}`,
      ARM_DISCOVERY_TOKEN: env.ARM_DISCOVERY_TOKEN,
    } : undefined;

    const injector = injectionEnabled ? new ArmRuntimeInjector({
      mode: bridgeId ? 'bridge' : 'automatic',
      telemetryRoot,
      ...(bridgeId ? {
        bridgeApplicationId: bridgeId,
        bridgeMetricsBasePort: this.readPort(env.ARM_BRIDGE_METRICS_BASE_PORT, 3500),
        bridgeRegistrationUrl: `http://127.0.0.1:${registrationPort}/`,
        bridgeRegistrationToken,
        bridgeMetricsToken,
      } : {}),
      sampleIntervalMs: this.readPositiveInteger(env.ARM_TELEMETRY_INTERVAL_MS, 1000),
    }) : undefined;

    const telemetry = injectionEnabled ? new ArmTelemetryReader(telemetryRoot) : undefined;
    this.collector = bridgeId ? new RemoteArmMetricsCollector([], 2000, 15000) : undefined;
    this.registry = this.collector
      ? new ApplicationRegistry(this.collector, bridgeMetricsToken) : undefined;
    this.registrationServer = this.registry && this.collector && bridgeRegistrationToken
      ? new ApplicationRegistrationServer(this.registry, this.collector, {
          token: bridgeRegistrationToken, port: registrationPort,
        }) : undefined;
    if (bridgeId && !this.registrationServer) {
      throw new Error('ARM Client Bridge requires registration and metrics tokens');
    }

    this.lifecycle = new ApplicationLifecycleManager({
      storageRoot, injector, metricsToken: env.ARM_METRICS_TOKEN, runtimeEnv,
    });
    this.monitor = new ApplicationRuntimeMonitor(this.lifecycle, {
      intervalMs: this.readPositiveInteger(env.ARM_MONITOR_INTERVAL_MS, 1000),
      stableResetMs: this.readPositiveInteger(env.ARM_STABLE_RESET_MS, 60000),
    }, new RuntimeStateStore(storageRoot));
    this.registerMonitorDiagnostics();

    this.releases = new ApplicationReleaseManager(this.monitor, { storageRoot });
    this.rollout = new SafeRolloutManager(this.monitor, this.releases, storageRoot, {
      stabilityWindowMs: this.readPositiveInteger(env.ARM_ROLLOUT_STABILITY_MS, 1500),
    });

    // Blue/Green remains a deployment coordinator, not a traffic adapter.
    this.blueGreen = env.ARM_BLUE_GREEN_APP_ID ? new BlueGreenDeploymentManager({
      storageRoot, injector, runtimeEnv,
      applicationId: env.ARM_BLUE_GREEN_APP_ID,
      proxyPort: this.readPort(env.ARM_PROXY_PORT, 3400),
      ...(env.ARM_BLUE_PORT ? { bluePort: this.readPort(env.ARM_BLUE_PORT, 3401) } : {}),
      ...(env.ARM_GREEN_PORT ? { greenPort: this.readPort(env.ARM_GREEN_PORT, 3402) } : {}),
    }) : undefined;

    this.endpoints = new ApplicationEndpointDiscovery(this.monitor, this.blueGreen);
    this.api = new ApplicationManagementApi(this.monitor, {
      releaseManager: this.releases,
      rolloutManager: this.rollout,
      blueGreenManager: this.blueGreen,
      telemetryReader: telemetry,
      registrationRegistry: this.registry,
      registrationCollector: this.collector,
      endpointDiscovery: this.endpoints,
      discoveryToken: env.ARM_DISCOVERY_TOKEN,
      bearerToken: token,
      port: managementPort,
    });
  }

  get state(): SupervisorHostState {
    return this.stateValue;
  }

  async start(): Promise<void> {
    if (this.stateValue !== 'CREATED') {
      throw new Error('SupervisorHost may start only once');
    }
    this.stateValue = 'STARTING';
    try {
      await this.startRegistrationPlane();
      await this.lifecycle.initialize();
      if (this.blueGreen) {
        await this.blueGreen.initialize();
        this.blueGreenStarted = true;
      }

      await this.monitor.restoreRunningApplications();
      const recovered = await this.rollout.recoverIncompleteRollouts();
      for (const operation of recovered) {
        this.logger.log('[ARM rollout recovery]', operation.applicationId, operation.phase);
      }
      this.monitor.startMonitoring();
      this.monitoringStarted = true;

      await this.api.start();
      this.apiStarted = true;
      this.stateValue = 'RUNNING';
    } catch (error) {
      const cleanupErrors = await this.cleanup();
      this.stateValue = 'FAILED';
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors],
          'Supervisor startup failed and cleanup encountered errors');
      }
      throw error;
    }
  }

  /** Stop only Supervisor resources. Never terminate adopted child processes. */
  async stop(): Promise<void> {
    if (this.stateValue === 'STARTING') {
      throw new Error('SupervisorHost cannot stop during startup');
    }
    if (this.closed) return;
    this.stateValue = 'STOPPING';
    const errors = await this.cleanup();
    this.stateValue = errors.length ? 'FAILED' : 'STOPPED';
    if (errors.length) {
      throw new AggregateError(errors, 'Supervisor shutdown failed');
    }
  }

  private async startRegistrationPlane(): Promise<void> {
    if (!this.registrationServer || !this.collector) return;
    this.collector.start();
    this.collectorStarted = true;
    await this.registrationServer.start();
    this.registrationStarted = true;
  }

  private async cleanup(): Promise<unknown[]> {
    if (this.closed) return [];
    this.closed = true;
    const errors: unknown[] = [];
    const close = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); }
      catch (error) { errors.push(error); this.logger.error('[ARM shutdown]', error); }
    };

    // Reverse of initialization; monitoring cannot issue new restarts during teardown.
    if (this.apiStarted) await close(() => this.api.stop());
    if (this.monitoringStarted) this.monitor.stopMonitoring();
    if (this.blueGreenStarted) await close(() => this.blueGreen!.close());
    if (this.registrationStarted) await close(() => this.registrationServer!.stop());
    if (this.registry) await close(() => this.registry!.close());
    if (this.collectorStarted) await close(() => this.collector!.stop());
    await close(() => this.monitor.close()); // closes lifecycle bookkeeping, not child PIDs
    return errors;
  }

  private registerMonitorDiagnostics(): void {
    this.monitor.on('monitor.error', event => this.logger.error('[ARM monitor]', event));
    this.monitor.on('recovery.scheduled', event => this.logger.log('recovery.scheduled', event));
    this.monitor.on('recovery.failed', event => this.logger.error('recovery.failed', event));
    this.monitor.on('recovery.succeeded', event => this.logger.log('recovery.succeeded', event));
    this.monitor.on('recovery.exhausted', event => this.logger.error('recovery.exhausted', event));
    this.monitor.on('process.completed', event => this.logger.log('process.completed', event));
  }

  private readPort(raw: string | undefined, fallback: number, allowZero = false): number {
    const port = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(port) || port < (allowZero ? 0 : 1) || port > 65535) {
      throw new Error('Invalid Supervisor port');
    }
    return port;
  }

  private readPositiveInteger(raw: string | undefined, fallback: number): number {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Invalid Supervisor timing setting');
    }
    return value;
  }
}

/**
 * Phase R1: proposed inter-module contracts.
 *
 * These interfaces intentionally do NOT replace the existing implementation
 * APIs yet. Adapters and mapping are introduced incrementally during R2-R5.
 * No runtime imports: this package must remain free of implementation deps.
 */

export type ApplicationId = string;
export type InstanceId = string;
export type ReleaseVersion = string;
export type ProcessStatus = 'RUNNING' | 'STOPPED' | 'UNKNOWN';
export type EndpointState = 'ASSIGNED' | 'BOUND' | 'READY' | 'UNAVAILABLE';

export interface ProcessLaunchRequest {
  instanceId: InstanceId;
  applicationId: ApplicationId;
  entry: string;
  cwd?: string;
  arguments?: readonly string[];
  applicationEnvironment?: Readonly<Record<string, string>>;
  runtimeEnvironment?: Readonly<Record<string, string>>;
}

export interface ProcessInstance {
  instanceId: InstanceId;
  applicationId: ApplicationId;
  status: ProcessStatus;
  pid?: number;
  startedAt?: string;
  adopted: boolean;
  endpoint?: {
    host: string;
    port: number;
    state: EndpointState;
  };
}

export interface ProcessController {
  start(request: ProcessLaunchRequest): Promise<ProcessInstance>;
  stop(instanceId: InstanceId): Promise<void>;
  restart(instanceId: InstanceId): Promise<ProcessInstance>;
  inspect(instanceId: InstanceId): Promise<ProcessInstance>;
}

export interface ReleaseDescriptor {
  applicationId: ApplicationId;
  version: ReleaseVersion;
  entry: string;
  directory: string;
}

export interface PackageCatalog {
  getRelease(applicationId: ApplicationId, version: ReleaseVersion):
    Promise<ReleaseDescriptor | undefined>;
  listReleases(applicationId: ApplicationId): Promise<readonly ReleaseDescriptor[]>;
}

export interface ReleaseSelector {
  activeRelease(applicationId: ApplicationId): Promise<ReleaseDescriptor | undefined>;
  activate(applicationId: ApplicationId, version: ReleaseVersion): Promise<void>;
}

export interface ApplicationDesiredState {
  applicationId: ApplicationId;
  desired: 'RUNNING' | 'STOPPED';
  releaseVersion: ReleaseVersion;
}

export interface RuntimeStatusReader {
  inspect(applicationId: ApplicationId): Promise<{
    desired: ApplicationDesiredState;
    process: ProcessInstance | undefined;
    readiness: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN' | 'NOT_CONFIGURED';
  }>;
}

export interface HttpEndpoint {
  applicationId: ApplicationId;
  instanceId: InstanceId;
  url: string;
  host: string;
  port: number;
  mode: 'singleton' | 'blue-green';
}

export interface EndpointDirectory {
  find(applicationId: ApplicationId): Promise<HttpEndpoint | undefined>;
  list(): Promise<readonly HttpEndpoint[]>;
}

export interface TrafficRouter {
  activate(applicationId: ApplicationId, target: HttpEndpoint): Promise<void>;
  current(applicationId: ApplicationId): Promise<HttpEndpoint | undefined>;
  drain(applicationId: ApplicationId, timeoutMs: number): Promise<boolean>;
}

export interface ApplicationConfiguration {
  applicationId: ApplicationId;
  environment: Readonly<Record<string, string>>;
}

export interface ApplicationConfigurationReader {
  read(applicationId: ApplicationId): Promise<ApplicationConfiguration>;
}

export interface ChildEnvironmentPolicy {
  build(options: {
    applicationEnvironment?: Readonly<Record<string, string>>;
    runtimeEnvironment?: Readonly<Record<string, string>>;
    injectionEnvironment?: Readonly<Record<string, string>>;
  }): NodeJS.ProcessEnv;
}

export interface TelemetrySnapshot {
  applicationId: ApplicationId;
  instanceId: InstanceId;
  observedAt: string;
  metrics: ReadonlyArray<{ name: string; value: number }>;
}

export interface TelemetryReader {
  read(instanceId: InstanceId): Promise<TelemetrySnapshot | undefined>;
}

/**
 * Event payloads for post-commit notifications. Consumers must NOT assume
 * exactly-once delivery, cross-module transactionality or ordering.
 */
export interface DomainEventMap {
  'process.started': {
    instanceId: InstanceId;
    applicationId: ApplicationId;
    pid: number;
  };
  'process.exited': {
    instanceId: InstanceId;
    applicationId: ApplicationId;
    observedAt: string;
    exitCode?: number;
    signal?: string;
  };
  'endpoint.changed': {
    instanceId: InstanceId;
    applicationId: ApplicationId;
    endpoint?: HttpEndpoint;
  };
  'release.activated': {
    applicationId: ApplicationId;
    version: ReleaseVersion;
  };
  'rollout.finished': {
    applicationId: ApplicationId;
    version: ReleaseVersion;
    outcome: 'SUCCEEDED' | 'ROLLED_BACK' | 'NEEDS_ATTENTION';
  };
}

export interface DomainEventPublisher {
  publish<K extends keyof DomainEventMap>(
    name: K, payload: DomainEventMap[K],
  ): Promise<void>;
}

import { accessSync, constants, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ArmInjectionMode = 'disabled' | 'automatic' | 'bridge';

export interface ArmRuntimeInjection {
  mode: ArmInjectionMode;
  bootstrapPath?: string;
  telemetryRoot?: string;
  sampleIntervalMs?: number;
  /** Bridge is limited to one named app to avoid metrics-port collisions. */
  bridgeApplicationId?: string;
  bridgeMetricsBasePort?: number;
  bridgeRegistrationUrl?: string;
  bridgeRegistrationToken?: string;
  bridgeMetricsToken?: string;
}

/** Supervisor-owned preload/SDK configuration. Never accept paths from application ZIPs. */
export class ArmRuntimeInjector {
  constructor(private readonly config: ArmRuntimeInjection) {
    if (!['disabled', 'automatic', 'bridge'].includes(config.mode)) {
      throw new Error('Invalid ARM injection mode');
    }
    if (config.mode !== 'disabled' && !config.telemetryRoot) {
      throw new Error('ARM telemetryRoot is required');
    }
    if (config.sampleIntervalMs !== undefined &&
      (!Number.isSafeInteger(config.sampleIntervalMs) ||
        config.sampleIntervalMs < 250 || config.sampleIntervalMs > 60000)) {
      throw new Error('Invalid ARM sample interval');
    }
    if (config.mode === 'bridge') this.validateBridgeConfiguration();
  }

  nodeArguments(entry: string, args: string[] = [], applicationId?: string): string[] {
    if (this.config.mode === 'disabled') return [entry, ...args];
    const bridge = this.shouldBridge(applicationId);
    const bootstrap = this.config.bootstrapPath ?? fileURLToPath(new URL(
      bridge ? '../runtime/bridge-bootstrap.mjs' : '../runtime/bootstrap.mjs', import.meta.url));
    accessSync(bootstrap, constants.R_OK);
    return ['--import', bootstrap, entry, ...args];
  }

  environment(applicationId: string, instanceId: string): Record<string, string> {
    if (this.config.mode === 'disabled') return {};
    const basic = {
      ARM_INJECTION_ENABLED: '1',
      ARM_APPLICATION_ID: applicationId,
      ARM_INSTANCE_ID: instanceId,
      ARM_TELEMETRY_ROOT: this.config.telemetryRoot!,
      ARM_SAMPLE_INTERVAL_MS: String(this.config.sampleIntervalMs ?? 1000),
    };
    if (!this.shouldBridge(applicationId)) return basic;
    return {
      ...basic,
      ARM_BRIDGE_ENABLED: '1',
      ARM_BRIDGE_METRICS_PORT: String(this.portFor(instanceId)),
      ARM_BRIDGE_MODULE_PATH: this.resolveArmClientModule(),
      ARM_BRIDGE_REGISTRATION_URL: this.config.bridgeRegistrationUrl!,
      ARM_BRIDGE_REGISTRATION_TOKEN: this.config.bridgeRegistrationToken!,
      ARM_BRIDGE_METRICS_TOKEN: this.config.bridgeMetricsToken!,
    };
  }

  /**
   * Resolve the compiled SDK from either source/tsx or dist/compiled execution.
   * The Supervisor owns this module, never an uploaded application ZIP.
   */
  private resolveArmClientModule(): string {
    const candidates = [
      new URL('../../../dist/packages/library/src/arm-runtime.js', import.meta.url),
      new URL('../../library/src/arm-runtime.js', import.meta.url),
    ];
    const compiled = candidates.map(url => fileURLToPath(url)).find(path => existsSync(path));
    if (!compiled) {
      throw new Error('ARM Client Runtime Bridge requires compiled SDK. Run npm run build first.');
    }
    return compiled;
  }

  bridgeEnabledFor(applicationId: string): boolean {
    return this.shouldBridge(applicationId);
  }

  bridgeMetricsPort(instanceId: string): number {
    return this.portFor(instanceId);
  }

  private shouldBridge(applicationId?: string): boolean {
    return this.config.mode === 'bridge' && applicationId === this.config.bridgeApplicationId;
  }

  private portFor(instanceId: string): number {
    const base = this.config.bridgeMetricsBasePort!;
    const offset = instanceId.endsWith('-blue') ? 1 : instanceId.endsWith('-green') ? 2 : 0;
    return base + offset;
  }

  private validateBridgeConfiguration(): void {
    if (!this.config.bridgeApplicationId ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(this.config.bridgeApplicationId)) {
      throw new Error('Invalid bridge application ID');
    }
    const base = this.config.bridgeMetricsBasePort;
    if (!Number.isSafeInteger(base) || base! < 1024 || base! > 65533) {
      throw new Error('Invalid ARM bridge metrics base port');
    }
    if (!this.config.bridgeRegistrationToken || !this.config.bridgeMetricsToken ||
      this.config.bridgeRegistrationToken.length < 16 ||
      this.config.bridgeMetricsToken.length < 16) {
      throw new Error('Bridge requires two distinct tokens of at least 16 characters');
    }
    if (this.config.bridgeRegistrationToken === this.config.bridgeMetricsToken) {
      throw new Error('Bridge registration and metrics tokens must differ');
    }
    const endpoint = new URL(this.config.bridgeRegistrationUrl ?? '');
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== '/') {
      throw new Error('Bridge registration URL must be loopback HTTP origin');
    }
  }
}

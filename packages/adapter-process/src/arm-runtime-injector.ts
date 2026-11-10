import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ArmInjectionMode = 'disabled' | 'automatic';

export interface ArmRuntimeInjection {
  mode: ArmInjectionMode;
  bootstrapPath?: string;
  telemetryRoot?: string;
  sampleIntervalMs?: number;
}

/** Validates Supervisor-owned preload configuration, never reads it from ZIP. */
export class ArmRuntimeInjector {
  constructor(private readonly config: ArmRuntimeInjection) {
    if (config.mode !== 'disabled' && config.mode !== 'automatic') {
      throw new Error('Invalid ARM injection mode');
    }
    if (config.mode === 'automatic') {
      if (!config.telemetryRoot) throw new Error('ARM telemetryRoot is required');
      if (config.sampleIntervalMs !== undefined &&
        (!Number.isSafeInteger(config.sampleIntervalMs) ||
        config.sampleIntervalMs < 250 || config.sampleIntervalMs > 60000)) {
        throw new Error('Invalid ARM sample interval');
      }
    }
  }

  nodeArguments(entry: string, args: string[] = []): string[] {
    if (this.config.mode === 'disabled') return [entry, ...args];
    const bootstrap = this.config.bootstrapPath ??
      fileURLToPath(new URL('../runtime/bootstrap.mjs', import.meta.url));
    accessSync(bootstrap, constants.R_OK);
    return ['--import', bootstrap, entry, ...args];
  }

  environment(applicationId: string, instanceId: string): Record<string, string> {
    if (this.config.mode === 'disabled') return {};
    return {
      ARM_INJECTION_ENABLED: '1',
      ARM_APPLICATION_ID: applicationId,
      ARM_INSTANCE_ID: instanceId,
      ARM_TELEMETRY_ROOT: this.config.telemetryRoot!,
      ARM_SAMPLE_INTERVAL_MS: String(this.config.sampleIntervalMs ?? 1000),
    };
  }
}

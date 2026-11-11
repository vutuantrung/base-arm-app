/**
 * Small OS-process boundary: no dependency on ARM SDK / concrete injector.
 * ArmRuntimeInjector satisfies this interface structurally.
 */
export interface ProcessLaunchInstrumentation {
  nodeArguments(entry: string, args?: string[], applicationId?: string): string[];
  environment(applicationId: string, instanceId: string): Record<string, string>;
}

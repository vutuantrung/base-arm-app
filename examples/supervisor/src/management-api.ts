import { resolve } from 'node:path';
import { ApplicationLifecycleManager } from '../../../packages/adapter-process/src/application-lifecycle-manager.js';
import { ApplicationRuntimeMonitor } from '../../../packages/adapter-process/src/application-runtime-monitor.js';
import { ApplicationManagementApi } from '../../../packages/adapter-process/src/application-management-api.js';
import { RuntimeStateStore } from '../../../packages/adapter-process/src/runtime-state-store.js';
import { ApplicationReleaseManager } from '../../../packages/adapter-process/src/application-release-manager.js';
import { SafeRolloutManager } from '../../../packages/adapter-process/src/safe-rollout-manager.js';

async function main(): Promise<void> {
  const token = process.env.ARM_MANAGEMENT_TOKEN;
  if (!token) throw new Error('Set ARM_MANAGEMENT_TOKEN (at least 16 characters)');
  const storageRoot = resolve(process.env.ARM_DEPLOYMENT_ROOT ?? './supervisor-data');
  const lifecycle = new ApplicationLifecycleManager({
    storageRoot,
    metricsToken: process.env.ARM_METRICS_TOKEN,
  });
  await lifecycle.initialize();

  const monitor = new ApplicationRuntimeMonitor(lifecycle, {
    intervalMs: Number(process.env.ARM_MONITOR_INTERVAL_MS ?? 1000),
    stableResetMs: Number(process.env.ARM_STABLE_RESET_MS ?? 60000),
  }, new RuntimeStateStore(storageRoot));
  monitor.on('monitor.error', error => console.error('[ARM monitor]', error));
  monitor.on('recovery.scheduled', event => console.log('recovery.scheduled', event));
  monitor.on('recovery.failed', event => console.error('recovery.failed', event));
  monitor.on('recovery.succeeded', event => console.log('recovery.succeeded', event));
  monitor.on('recovery.exhausted', event => console.error('recovery.exhausted', event));
  monitor.on('process.completed', event => console.log('process.completed', event));

  const releases = new ApplicationReleaseManager(monitor, { storageRoot });
  const rollout = new SafeRolloutManager(monitor, releases, storageRoot, {
    stabilityWindowMs: Number(process.env.ARM_ROLLOUT_STABILITY_MS ?? 1500),
  });
  const api = new ApplicationManagementApi(monitor, {
    releaseManager: releases,
    rolloutManager: rollout,
    bearerToken: token,
    port: Number(process.env.ARM_MANAGEMENT_PORT ?? 3300),
  });
  await monitor.restoreRunningApplications();
  const recovered = await rollout.recoverIncompleteRollouts();
  for (const operation of recovered) {
    console.log('[ARM rollout recovery]', operation.applicationId, operation.phase);
  }
  monitor.startMonitoring();
  await api.start();
  console.log('Supervisor management API listening at http://127.0.0.1:' +
    (process.env.ARM_MANAGEMENT_PORT ?? 3300));
  console.log('Use the management API to start apps and enable recovery tracking.');

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    monitor.stopMonitoring();
    void api.stop().finally(() => { monitor.close(); });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch(error => {
  console.error('[ARM supervisor]', error);
  process.exitCode = 1;
});

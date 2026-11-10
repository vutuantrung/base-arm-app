import { resolve } from 'node:path';
import { ApplicationLifecycleManager } from '../../../packages/adapter-process/src/application-lifecycle-manager.js';
import { ApplicationRuntimeMonitor } from '../../../packages/adapter-process/src/application-runtime-monitor.js';
import { ApplicationManagementApi } from '../../../packages/adapter-process/src/application-management-api.js';

async function main(): Promise<void> {
  const token = process.env.ARM_MANAGEMENT_TOKEN;
  if (!token) throw new Error('Set ARM_MANAGEMENT_TOKEN (at least 16 characters)');
  const lifecycle = new ApplicationLifecycleManager({
    storageRoot: resolve(process.env.ARM_DEPLOYMENT_ROOT ?? './supervisor-data'),
    metricsToken: process.env.ARM_METRICS_TOKEN,
  });
  await lifecycle.initialize();

  const monitor = new ApplicationRuntimeMonitor(lifecycle, {
    intervalMs: Number(process.env.ARM_MONITOR_INTERVAL_MS ?? 1000),
  });
  monitor.on('monitor.error', error => console.error('[ARM monitor]', error));
  monitor.on('recovery.scheduled', event => console.log('recovery.scheduled', event));
  monitor.on('recovery.failed', event => console.error('recovery.failed', event));
  monitor.on('recovery.succeeded', event => console.log('recovery.succeeded', event));
  monitor.on('recovery.exhausted', event => console.error('recovery.exhausted', event));

  const api = new ApplicationManagementApi(monitor, {
    bearerToken: token,
    port: Number(process.env.ARM_MANAGEMENT_PORT ?? 3300),
  });
  await api.start();
  await monitor.restoreRunningApplications();
  monitor.startMonitoring();
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

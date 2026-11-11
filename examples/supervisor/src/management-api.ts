import 'dotenv/config';
import { resolve } from 'node:path';
import { ApplicationLifecycleManager } from '../../../packages/adapter-process/src/application-lifecycle-manager.js';
import { ApplicationRuntimeMonitor } from '../../../packages/runtime-monitor/src/index.js';
import { ApplicationManagementApi } from '../../../packages/adapter-process/src/application-management-api.js';
import { RuntimeStateStore } from '../../../packages/runtime-monitor/src/index.js';
import { ApplicationReleaseManager } from '../../../packages/deployment-manager/src/index.js';
import { SafeRolloutManager } from '../../../packages/deployment-manager/src/index.js';
import { BlueGreenDeploymentManager } from '../../../packages/adapter-process/src/blue-green-deployment-manager.js';
import { ArmRuntimeInjector } from '../../../packages/runtime-injection/src/index.js';
import { ArmTelemetryReader } from '../../../packages/runtime-injection/src/index.js';
import { join } from 'node:path';
import { ApplicationRegistry } from '../../../packages/service-discovery/src/index.js';
import { RemoteArmMetricsCollector } from '../../../packages/service-discovery/src/index.js';
import { ApplicationRegistrationServer } from '../../../packages/service-discovery/src/index.js';
import { ApplicationEndpointDiscovery } from '../../../packages/service-discovery/src/index.js';

async function main(): Promise<void> {
  const token = process.env.ARM_MANAGEMENT_TOKEN;
  if (!token) throw new Error('Set ARM_MANAGEMENT_TOKEN (at least 16 characters)');
  const storageRoot = resolve(process.env.ARM_DEPLOYMENT_ROOT ?? './supervisor-data');
  const bridgeApplicationId = process.env.ARM_CLIENT_BRIDGE_APP_ID;
  const injectionEnabled = process.env.ARM_AUTO_INJECT === '1' || !!bridgeApplicationId;
  const bridgeRegistrationPort = Number(process.env.ARM_BRIDGE_REGISTRATION_PORT ?? 3200);
  const bridgeRegistrationToken = process.env.ARM_BRIDGE_REGISTRATION_TOKEN;
  const bridgeMetricsToken = process.env.ARM_BRIDGE_METRICS_TOKEN;
  const telemetryRoot = join(storageRoot, 'telemetry');
  const injector = injectionEnabled ? new ArmRuntimeInjector({
    mode: bridgeApplicationId ? 'bridge' : 'automatic',
    telemetryRoot,
    ...(bridgeApplicationId ? {
      bridgeApplicationId,
      bridgeMetricsBasePort: Number(process.env.ARM_BRIDGE_METRICS_BASE_PORT ?? 3500),
      bridgeRegistrationUrl: `http://127.0.0.1:${bridgeRegistrationPort}/`,
      bridgeRegistrationToken,
      bridgeMetricsToken,
    } : {}),
    sampleIntervalMs: Number(process.env.ARM_TELEMETRY_INTERVAL_MS ?? 1000),
  }) : undefined;
  const telemetry = injectionEnabled ? new ArmTelemetryReader(telemetryRoot) : undefined;
  const collector = bridgeApplicationId
    ? new RemoteArmMetricsCollector([], 2000, 15000) : undefined;
  const registry = collector
    ? new ApplicationRegistry(collector, bridgeMetricsToken) : undefined;
  const registrationServer = registry && collector && bridgeRegistrationToken
    ? new ApplicationRegistrationServer(registry, collector, {
        token: bridgeRegistrationToken,
        port: bridgeRegistrationPort,
      }) : undefined;
  if (bridgeApplicationId && !registrationServer) {
    throw new Error('ARM Client Bridge requires registration and metrics tokens');
  }
  if (registrationServer) {
    collector!.start();
    await registrationServer.start();
  }
  const lifecycle = new ApplicationLifecycleManager({
    storageRoot,
    injector,
    metricsToken: process.env.ARM_METRICS_TOKEN,
    ...(process.env.ARM_DISCOVERY_TOKEN ? {
      runtimeEnv: {
        // Application service discovery uses a restricted bearer, never the
        // management API token.
        ARM_DISCOVERY_URL: `http://127.0.0.1:${process.env.ARM_MANAGEMENT_PORT ?? 3300}`,
        ARM_DISCOVERY_TOKEN: process.env.ARM_DISCOVERY_TOKEN,
      },
    } : {}),
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
  // Phase 7 is opt-in and uses a distinct slot process registry and public proxy.
  // Do not enable against a legacy app still bound to the public port.
  const blueGreen = process.env.ARM_BLUE_GREEN_APP_ID
    ? new BlueGreenDeploymentManager({
        storageRoot,
        injector,
        ...(process.env.ARM_DISCOVERY_TOKEN ? {
          runtimeEnv: {
            ARM_DISCOVERY_URL: `http://127.0.0.1:${process.env.ARM_MANAGEMENT_PORT ?? 3300}`,
            ARM_DISCOVERY_TOKEN: process.env.ARM_DISCOVERY_TOKEN,
          },
        } : {}),
        applicationId: process.env.ARM_BLUE_GREEN_APP_ID,
        proxyPort: Number(process.env.ARM_PROXY_PORT ?? 3400),
        ...(process.env.ARM_BLUE_PORT ? { bluePort: Number(process.env.ARM_BLUE_PORT) } : {}),
        ...(process.env.ARM_GREEN_PORT ? { greenPort: Number(process.env.ARM_GREEN_PORT) } : {}),
      })
    : undefined;
  if (blueGreen) await blueGreen.initialize();

  const endpoints = new ApplicationEndpointDiscovery(monitor, blueGreen);
  const api = new ApplicationManagementApi(monitor, {
    releaseManager: releases,
    rolloutManager: rollout,
    blueGreenManager: blueGreen,
    telemetryReader: telemetry,
    registrationRegistry: registry,
    registrationCollector: collector,
    endpointDiscovery: endpoints,
    discoveryToken: process.env.ARM_DISCOVERY_TOKEN,
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
    void api.stop().finally(async () => {
      await blueGreen?.close();
      await registrationServer?.stop();
      registry?.close();
      collector?.stop();
      monitor.close();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch(error => {
  console.error('[ARM supervisor]', error);
  process.exitCode = 1;
});

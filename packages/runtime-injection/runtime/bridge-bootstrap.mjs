/**
 * Phase 9: preload the actual ARM Client runtime without mutating the application.
 * Fail closed: if the SDK cannot initialize, do not launch the business entrypoint.
 */
import './bootstrap.mjs';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';

if (isMainThread && process.env.ARM_BRIDGE_ENABLED === '1') {
  const modulePath = process.env.ARM_BRIDGE_MODULE_PATH;
  const applicationId = process.env.ARM_APPLICATION_ID;
  const instanceId = process.env.ARM_INSTANCE_ID;
  const port = Number(process.env.ARM_BRIDGE_METRICS_PORT);
  const registrationUrl = process.env.ARM_BRIDGE_REGISTRATION_URL;
  const registrationToken = process.env.ARM_BRIDGE_REGISTRATION_TOKEN;
  const metricsToken = process.env.ARM_BRIDGE_METRICS_TOKEN;
  const identifier = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
  if (!modulePath || !identifier.test(applicationId ?? '') ||
      !identifier.test(instanceId ?? '') ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !registrationUrl || !registrationToken || !metricsToken) {
    throw new Error('Invalid ARM Client Runtime Bridge configuration');
  }

  // Imported from a Supervisor build artifact, never the application ZIP.
  const { createArmRuntime } = await import(pathToFileURL(modulePath).href);
  const runtime = createArmRuntime({
    metrics: {
      collectionIntervalMs: 1000,
      server: {
        host: '127.0.0.1',
        port,
        authToken: metricsToken,
      },
    },
    supervisor: {
      applicationId,
      instanceId,
      supervisorUrl: registrationUrl,
      token: registrationToken,
    },
  });
  await runtime.start();
  // No business components are declared by an unmodified application. The
  // SDK readiness endpoint cannot assert that DBs, queues or HTTP are ready.
  process.once('beforeExit', () => {
    void runtime.stop().catch(() => {});
  });
}

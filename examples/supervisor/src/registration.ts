import { RemoteArmMetricsCollector } from '../../../packages/adapter-process/src/remote-arm-metrics-collector.js';
import { ApplicationRegistry } from '../../../packages/adapter-process/src/application-registry.js';
import { ApplicationRegistrationServer } from '../../../packages/adapter-process/src/application-registration-server.js';

const registrationToken = process.env.SUPERVISOR_REGISTRATION_TOKEN;
if (!registrationToken) throw new Error('Set SUPERVISOR_REGISTRATION_TOKEN');

const collector = new RemoteArmMetricsCollector([], 2000, 15000);
const registry = new ApplicationRegistry(collector, process.env.ARM_METRICS_TOKEN);
const server = new ApplicationRegistrationServer(registry, collector, {
  token: registrationToken,
  port: Number(process.env.SUPERVISOR_PORT ?? 3200),
});

collector.on('connected', ({ id }) => console.log('Metrics connected:', id));
collector.on('disconnected', ({ id }) => console.log('Metrics disconnected:', id));
registry.on('registered', ({ id }) => console.log('Registered:', id));

collector.start();
await server.start();
console.log('Dynamic registration listening on 127.0.0.1:' + (process.env.SUPERVISOR_PORT ?? '3200'));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await server.stop();
  registry.close();
  collector.stop();
}
process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });

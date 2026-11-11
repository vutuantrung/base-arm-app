import 'dotenv/config';
import { resolve } from 'node:path';
import { ProcessManager } from '../../../packages/adapter-process/src/process-manager.js';
import { RemoteArmMetricsCollector } from '../../../packages/adapter-process/src/remote-arm-metrics-collector.js';

const stateFile = resolve('.arm-state/processes.json');
const app = {
  id: 'example-app',
  entry: resolve('dist/examples/nodejs-api/src/index.js'),
  metricsUrl: 'ws://127.0.0.1:3210/metrics/ws',
  env: {
    PORT: '3210',
    ...(process.env.ARM_METRICS_TOKEN
      ? { ARM_METRICS_TOKEN: process.env.ARM_METRICS_TOKEN }
      : {}),
  },
  metricsToken: process.env.ARM_METRICS_TOKEN,
};

const manager = new ProcessManager(stateFile);
await manager.initialize([app]);
const child = await manager.start(app.id);
console.log(`Managed ${app.id} PID=${child.pid} (may be adopted)`);

const collector = new RemoteArmMetricsCollector([app], 2000, 15_000);
collector.on('connected', message => console.log('ARM WS connected', message));
collector.on('disconnected', message => console.log('ARM WS disconnected', message));
collector.on('metrics', ({ id }) => {
  const state = collector.get(id);
  console.log('metrics', id, {
    count: state?.metrics.length,
    processRss: state?.metrics.find(m => m.name === 'process.memory.rss_bytes')?.value,
  });
});
collector.start();

// Stopping this Supervisor intentionally does NOT terminate the child.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    collector.stop();
    manager.close();
    process.exit(0);
  });
}

console.log('Supervisor running. Ctrl+C stops only the Supervisor.');

import { MetricsRegistry, NodeMetricsCollector } from '../../../packages/core/src/metrics.js';
import { ReliabilityManager, type ManagedComponent } from '../../../packages/core/src/reliability.js';
import { MetricsServer } from '../../../packages/adapter-http/src/server.js';

const metrics = new MetricsRegistry();
const arm = new ReliabilityManager(metrics, { checkIntervalMs: 2000 });

let connected = false;
const exampleComponent: ManagedComponent = {
  id: 'example-worker',
  async start() { connected = true; },
  async stop() { connected = false; },
  async recover() { connected = true; },
  async checkHealth() {
    return {
      status: connected ? 'HEALTHY' : 'UNHEALTHY',
      checkedAt: new Date().toISOString()
    };
  },
};

arm.register({
  component: exampleComponent,
  critical: true,
  recovery: {
    enabled: true,
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    timeoutMs: 2000
  }
});

const server = new MetricsServer(
  metrics
  , {
    port: Number(process.env.PORT ?? 3100),
    authToken: process.env.ARM_METRICS_TOKEN
  }
  , arm);
const collector = new NodeMetricsCollector(metrics, 2000);
collector.start();

await arm.start();

const business = setInterval(() => metrics.increment('app.jobs.completed_total'), 3000);
business.unref();
await server.start();

console.log(`ARM listening at http://127.0.0.1:${process.env.PORT ?? 3100}/metrics`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(business);
  collector.stop();
  await arm.stop();
  await server.stop();
}
process.once('SIGTERM', () => {
  void shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
});
process.once('SIGINT', () => {
  void shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
});

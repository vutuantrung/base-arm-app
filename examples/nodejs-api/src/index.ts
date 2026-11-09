import {
  createArmRuntime,
  type ManagedComponent,
  type RecoveryPolicy,
} from '../../../packages/library/src/index.js';

const policy: RecoveryPolicy = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  timeoutMs: 2000,
};

function createExampleWorker(): ManagedComponent {
  let connected = false;
  return {
    id: 'example-worker',
    async start() { connected = true; },
    async stop() { connected = false; },
    async recover() { connected = true; },
    async checkHealth() {
      return {
        status: connected ? 'HEALTHY' : 'UNHEALTHY',
        checkedAt: new Date().toISOString(),
      };
    },
  };
}

const registrationToken = process.env.SUPERVISOR_REGISTRATION_TOKEN;
const arm = createArmRuntime({
  components: [{
    component: createExampleWorker(),
    critical: true,
    recovery: policy,
  }],
  reliability: { checkIntervalMs: 2000 },
  metrics: {
    collectionIntervalMs: 2000,
    server: {
      host: '127.0.0.1',
      port: Number(process.env.PORT ?? 3100),
      authToken: process.env.ARM_METRICS_TOKEN,
      broadcastIntervalMs: 2000,
    },
  },
  supervisor: registrationToken ? {
    applicationId: process.env.ARM_APPLICATION_ID ?? 'example-app',
    instanceId: process.env.ARM_INSTANCE_ID ?? `pid-${process.pid}`,
    supervisorUrl: process.env.SUPERVISOR_URL ?? 'http://127.0.0.1:3200',
    token: registrationToken,
    onError: error => console.warn('[ARM] Supervisor unavailable:', error),
  } : undefined,
});

await arm.start();

const business = setInterval(() => arm.metrics.increment('app.jobs.completed_total'), 3000);
business.unref();

console.log('ARM started:', arm.status);
console.log('ARM metrics on http://127.0.0.1:' + (process.env.PORT ?? 3100) + '/metrics');

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(business);
  const result = await arm.stop();
  if (!result.clean) console.error('ARM shutdown incomplete', result.blockedComponents);
}

process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)).catch(() => process.exit(1)); });
process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)).catch(() => process.exit(1)); });

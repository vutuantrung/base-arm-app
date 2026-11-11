import 'dotenv/config';
import { SupervisorHost } from '../../../packages/supervisor-host/src/index.js';

async function main(): Promise<void> {
  const host = new SupervisorHost({ environment: process.env });
  await host.start();

  const address = host.api.http.address();
  const port = address && typeof address !== 'string'
    ? address.port
    : (process.env.ARM_MANAGEMENT_PORT ?? 3300);
  console.log(`Supervisor management API listening at http://127.0.0.1:${port}`);
  console.log('Use the management API to start apps and enable recovery tracking.');

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await host.stop();
    } catch (error) {
      console.error('[ARM supervisor shutdown]', error);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

void main().catch(error => {
  console.error('[ARM supervisor]', error);
  process.exitCode = 1;
});

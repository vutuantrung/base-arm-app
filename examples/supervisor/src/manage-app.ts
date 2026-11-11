import 'dotenv/config';
import { resolve } from 'node:path';
import { ApplicationLifecycleManager } from '../../../packages/adapter-process/src/application-lifecycle-manager.js';

const command = process.argv[2];
const id = process.argv[3];
const version = process.argv[4];

const manager = new ApplicationLifecycleManager({
  storageRoot: resolve(process.env.ARM_DEPLOYMENT_ROOT ?? './supervisor-data'),
  metricsToken: process.env.ARM_METRICS_TOKEN,
});

async function run(): Promise<unknown> {
  await manager.initialize();
  switch (command) {
    case 'activate':
      if (!id || !version) throw new Error('Usage: app:manage activate <applicationId> <version>');
      return manager.activateRelease(id, version);
    case 'start':
      if (!id) throw new Error('Usage: app:manage start <applicationId>');
      return manager.startApplication(id);
    case 'stop':
      if (!id) throw new Error('Usage: app:manage stop <applicationId>');
      return manager.stopApplication(id);
    case 'restart':
      if (!id) throw new Error('Usage: app:manage restart <applicationId>');
      return manager.restartApplication(id);
    case 'inspect':
      if (!id) throw new Error('Usage: app:manage inspect <applicationId>');
      return manager.inspectApplication(id);
    case 'list':
      return manager.listApplications();
    default:
      throw new Error('Usage: app:manage <activate|start|stop|restart|inspect|list> [id] [version]');
  }
}

void run()
  .then(value => console.log(JSON.stringify(value, null, 2)))
  .catch(error => {
    console.error('[ARM Supervisor]', error);
    process.exitCode = 1;
  })
  .finally(() => manager.close());

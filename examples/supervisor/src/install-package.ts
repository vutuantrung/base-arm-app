import { resolve } from 'node:path';
import { DeploymentManager } from '../../../packages/adapter-process/src/deployment/deployment-manager.js';

async function main(): Promise<void> {
  const archivePath = process.argv[2];
  if (!archivePath) throw new Error('Usage: npm run deploy:zip -- <absolute-or-relative-zip-path>');
  const manager = new DeploymentManager({
    storageRoot: resolve(process.env.ARM_DEPLOYMENT_ROOT ?? './supervisor-data'),
  });
  const receipt = await manager.installZip(resolve(archivePath));
  console.log(JSON.stringify(receipt, null, 2));
}
void main().catch(error => {
  console.error('[ARM Deployment]', error);
  process.exitCode = 1;
});

import { isSea } from 'node:sea';
import { resolveSupervisorPaths } from '../packages/supervisor-host/src/supervisor-paths.js';

if (process.argv[2] === '--sea-self-check') {
  const paths = resolveSupervisorPaths({});
  console.log(JSON.stringify({
    sea: isSea(), platform: process.platform, arch: process.arch,
    nodeVersion: process.versions.node, baseDirectory: paths.baseDirectory,
  }));
  if (!isSea()) process.exitCode = 1;
} else {
  // Require the bundled module only after the self-check branch. The source
  // entrypoint continues to own dotenv loading, lifecycle and signals.
  void import('../examples/supervisor/src/management-api.js').catch(error => {
    console.error('[ARM SEA]', error);
    process.exitCode = 1;
  });
}

import { dirname, resolve, join } from 'node:path';
import { isSea } from 'node:sea';

export interface SupervisorPathContext {
  packaged: boolean;
  executable: string;
  workingDirectory: string;
}
export interface SupervisorPaths {
  readonly baseDirectory: string;
  readonly environmentFile: string;
  readonly storageRoot: string;
  readonly runtimeAssets?: string;
  readonly nodeExecutable?: string;
  readonly npmCli?: string;
}
export function currentPathContext(): SupervisorPathContext {
  return { packaged: isSea(), executable: process.execPath, workingDirectory: process.cwd() };
}

/** Source mode retains CWD semantics; packaged mode never depends on CWD. */
export function resolveSupervisorPaths(
  environment: NodeJS.ProcessEnv, context = currentPathContext(),
): SupervisorPaths {
  const baseDirectory = context.packaged
    ? dirname(resolve(context.executable)) : resolve(context.workingDirectory);
  const fromBase = (value: string): string => resolve(baseDirectory, value);
  const node = environment.ARM_NODE_EXECUTABLE ||
    (context.packaged ? join('runtime', 'node.exe') : undefined);
  return Object.freeze({
    baseDirectory,
    environmentFile: fromBase(environment.DOTENV_CONFIG_PATH || '.env'),
    storageRoot: fromBase(environment.ARM_DEPLOYMENT_ROOT || './supervisor-data'),
    runtimeAssets: environment.ARM_RUNTIME_ASSETS || context.packaged
      ? fromBase(environment.ARM_RUNTIME_ASSETS || 'runtime-assets') : undefined,
    nodeExecutable: node ? fromBase(node) : undefined,
    npmCli: environment.ARM_NPM_CLI ? fromBase(environment.ARM_NPM_CLI) : undefined,
  });
}

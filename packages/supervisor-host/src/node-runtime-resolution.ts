import { execFileSync } from 'node:child_process';
import { statSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { isSea } from 'node:sea';
import type { NodeRuntimeToolchain } from '../../contracts/src/index.js';

/** Resolve only trusted operator settings. Never accept paths from app packages. */
export function resolveNodeRuntime(
  environment: NodeJS.ProcessEnv, baseDirectory = process.cwd(),
): NodeRuntimeToolchain | undefined {
  const executableSetting = environment.ARM_NODE_EXECUTABLE || undefined;
  const npmCliSetting = environment.ARM_NPM_CLI || undefined;
  if (!executableSetting && !npmCliSetting && !isSea() && process.platform !== 'win32') {
    return undefined; // Legacy source-mode Node + system npm on POSIX.
  }
  if (isSea() && !executableSetting) {
    throw new Error('ARM_NODE_EXECUTABLE is required for packaged Supervisor');
  }
  const executable = resolveRuntimeFile(
    executableSetting ?? process.execPath, baseDirectory, 'Node executable');
  if (!/^node(?:\.exe)?$/i.test(basename(executable))) {
    throw new Error('Invalid Node executable filename (expected node or node.exe)');
  }
  if (isSea() && executable.toLowerCase() === realpathSync(process.execPath).toLowerCase()) {
    throw new Error('Supervisor executable cannot be used as child Node runtime');
  }
  const npmCli = resolveRuntimeFile(npmCliSetting ?? resolve(dirname(executable),
    'node_modules', 'npm', 'bin', 'npm-cli.js'), baseDirectory, 'npm CLI');
  if (basename(npmCli) !== 'npm-cli.js') throw new Error('Invalid npm CLI filename');
  const version = probeNodeVersion(executable);
  return Object.freeze({ executable, version, npmCli });
}

function resolveRuntimeFile(setting: string, baseDirectory: string, label: string): string {
  try {
    const path = realpathSync(resolve(baseDirectory, setting));
    if (!statSync(path).isFile()) throw new Error('Not a regular file');
    return path;
  } catch {
    throw new Error(`Invalid ${label}: configure an existing file`);
  }
}

function probeNodeVersion(executable: string): string {
  // Probe without Node preloads or inherited Supervisor credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  let version: string;
  try {
    version = execFileSync(executable, ['--version'], {
      env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('Invalid Node executable: version probe failed');
  }
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Node runtime version');
  return version.slice(1);
}

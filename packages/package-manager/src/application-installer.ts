import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { NodeRuntimeToolchain } from '../../contracts/src/index.js';

export interface DependencyInstaller {
  install(directory: string, timeoutMs: number): Promise<void>;
}
/** Dependency installation runs with no shell and no lifecycle scripts. */
export class NpmCiInstaller implements DependencyInstaller {
  constructor(private readonly runtime?: NodeRuntimeToolchain) {}
  async install(directory: string, timeoutMs: number): Promise<void> {
    await this.assertLockfilePresent(directory);
    await this.runNpmCi(directory, timeoutMs);
  }
  private async assertLockfilePresent(directory: string): Promise<void> {
    await access(join(directory, 'package.json'));
    await access(join(directory, 'package-lock.json'));
  }
  private async runNpmCi(directory: string, timeoutMs: number): Promise<void> {
    const executable = this.runtime?.executable ?? (process.platform === 'win32' ? process.execPath : 'npm');
    const npmCli = this.runtime?.npmCli ?? (process.platform === 'win32'
      ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined);
    const args = [...(npmCli ? [npmCli] : []), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: directory, shell: false, stdio: 'ignore',
        env: { ...process.env, npm_config_update_notifier: 'false' },
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error('Dependency installation timed out'));
        else if (code !== 0) reject(new Error(`npm ci exited with code ${code}, signal ${signal}`));
        else resolve();
      });
    });
  }
}

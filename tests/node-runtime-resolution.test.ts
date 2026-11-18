import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNodeRuntime } from '../packages/supervisor-host/src/index.js';
import { validateRuntimeCompatibility, NpmCiInstaller } from '../packages/package-manager/src/index.js';
import { ProcessManager, ChildProcessLogs } from '../packages/process-manager/src/index.js';

test('legacy version validator accepts an explicit child version', () => {
  assert.doesNotThrow(() => validateRuntimeCompatibility('>=22', '22.0.0'));
  assert.throws(() => validateRuntimeCompatibility('>=22', '20.0.0'), /requires Node/);
});

test('trusted runtime resolution rejects missing files', () => {
  assert.throws(() => resolveNodeRuntime({
    ARM_NODE_EXECUTABLE: './missing-node-runtime', ARM_NPM_CLI: './missing-npm-cli',
  }), /Invalid Node executable/);
});

test('explicit Node executable is used for child spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-pkg1-'));
  const executable = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  const npmCli = join(root, 'npm-cli.js');
  const entry = join(root, 'worker.cjs');
  await copyFile(process.execPath, executable);
  await writeFile(npmCli, '');
  await writeFile(entry, 'console.log(process.execPath); setInterval(() => {}, 100);');
  const runtime = resolveNodeRuntime({
    ARM_NODE_EXECUTABLE: executable, ARM_NPM_CLI: npmCli,
  });
  assert.ok(runtime);
  assert.equal(runtime.version, process.versions.node);
  const logs = new ChildProcessLogs(join(root, 'logs'));
  const manager = new ProcessManager(join(root, 'state.json'), undefined, undefined, logs, runtime.executable);
  let pid: number | undefined;
  try {
    await manager.initialize([{ id: 'worker', entry }]);
    pid = (await manager.start('worker')).pid;
    const deadline = Date.now() + 5000;
    let output = '';
    while (Date.now() < deadline) {
      output = (await logs.readTail('worker', 'stdout'))?.text ?? '';
      if (output.trim()) break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(output.trim().toLowerCase(), runtime.executable.toLowerCase());
    await manager.stop('worker');
    pid = undefined;
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('configured npm CLI runs through Node with fixed install arguments and no shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-pkg1-npm-'));
  try {
    const npmCli = join(root, 'npm-cli.js');
    await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    await writeFile(join(root, 'package-lock.json'), '{}');
    await writeFile(npmCli, "require('node:fs').writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), executable: process.execPath }));");
    const runtime = resolveNodeRuntime({ ARM_NODE_EXECUTABLE: process.execPath, ARM_NPM_CLI: npmCli });
    assert.ok(runtime);
    await new NpmCiInstaller(runtime).install(root, 5000);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')), {
      executable: runtime.executable,
      args: ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'release', 'sea');
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function requireWindowsBuildHost() {
  if (process.platform !== 'win32' || process.arch !== 'x64' ||
      process.versions.node.split('.')[0] !== '22') {
    throw new Error('SEA build requires Windows x64 and Node.js 22.x');
  }
  if (!process.env.npm_execpath) throw new Error('Run npm run build:exe');
}

function runNode(args, options = {}) {
  return run(process.execPath, args, options);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, shell: false, stdio: 'inherit', windowsHide: true,
    timeout: 300000, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${executable}`);
  return result.stdout;
}

async function bundleSupervisor(directory) {
  const main = join(directory, 'supervisor.cjs');
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['scripts/sea-entry.ts'],
    outfile: main, bundle: true, platform: 'node', target: 'node22',
    format: 'cjs', metafile: true,
    // The fallback source paths are never used in SEA; explicit PKG.2
    // resource paths are injected at runtime. Do not leave import.meta empty.
    define: { 'import.meta.url': '__armSeaModuleUrl' },
    banner: { js: "const __armSeaModuleUrl = require('node:url').pathToFileURL(process.execPath).href;" },
    // ws optional native accelerators are intentionally unavailable in SEA.
    external: ['bufferutil', 'utf-8-validate'],
  });
  const report = Object.values(result.metafile.outputs).flatMap(item => item.imports);
  const builtins = new Set((await import('node:module')).builtinModules);
  const unexpected = report.filter(item => item.external &&
    !item.path.startsWith('node:') && !builtins.has(item.path) &&
    !['bufferutil', 'utf-8-validate'].includes(item.path));
  if (unexpected.length) throw new Error('Unexpected external bundle imports: ' +
    unexpected.map(item => item.path).join(', '));
  return main;
}

async function createExecutable(directory, main) {
  const blob = join(directory, 'sea-prep.blob');
  const config = join(directory, 'sea-config.json');
  const exe = join(directory, 'arm-supervisor.exe');
  await writeFile(config, JSON.stringify({
    main, output: blob, disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false,
  }, null, 2));
  runNode(['--experimental-sea-config', config]);
  await copyFile(process.execPath, exe);
  // Windows signature removal is optional per Node 22 SEA documentation.
  // postject may warn about the original signature; the result is unsigned.
  // Pinned build-only tool, fetched by npm exec on demand; no app dependency.
  runNode([process.env.npm_execpath, 'exec', '--yes',
    '--package=postject@1.0.0-alpha.6', '--', 'postject',
    exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', fuse]);
  return exe;
}

export async function verifyExecutable(exe) {
  const cwd = await mkdtemp(join(tmpdir(), 'arm-sea-check-'));
  try {
    const output = run(exe, ['--sea-self-check'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15000,
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.sea, true);
    assert.equal(result.platform, 'win32');
    assert.equal(result.arch, 'x64');
    assert.equal(result.nodeVersion, process.versions.node);
    assert.equal(resolve(result.baseDirectory).toLowerCase(), dirname(exe).toLowerCase());
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

/** Run the actual bundled management daemon without project CWD or config. */
export async function verifyManagementApi(exe, runtime = { executable: process.execPath, npmCli: process.env.npm_execpath }) {
  const cwd = await mkdtemp(join(tmpdir(), 'arm-sea-api-'));
  const configPath = join(dirname(exe), '.env');
  const token = randomBytes(24).toString('hex');
  let child;
  let exit;
  try {
    // Only the disposable staging folder is modified, never a user's .env.
    await writeFile(configPath, [
      'ARM_MANAGEMENT_TOKEN=' + token,
      'ARM_MANAGEMENT_PORT=0',
      'ARM_DEPLOYMENT_ROOT=./smoke-data',
      ...(runtime.isolated ? [] : [
        'ARM_NODE_EXECUTABLE=' + JSON.stringify(runtime.executable.replaceAll('\\', '/')),
        'ARM_NPM_CLI=' + JSON.stringify(runtime.npmCli.replaceAll('\\', '/')),
      ]),
      'ARM_AUTO_INJECT=0',
    ].join('\n') + '\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(ARM_|DOTENV_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
    if (runtime.isolated) {
      for (const key of Object.keys(env)) if (/^(path|node_path|npm_.*)$/i.test(key)) delete env[key];
      env.PATH = join(process.env.SystemRoot || 'C:/Windows', 'System32');
    }
    child = spawn(exe, [], {
      cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exit = once(child, 'close');
    // Attach rejection handler immediately, even if spawn fails before polling.
    exit.catch(() => {});
    let stdout = '';
    let stderr = '';
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.stdout.setEncoding('utf8').on('data', data => { stdout = (stdout + data).slice(-16384); });
    child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-16384); });
    const deadline = Date.now() + 20000;
    let port;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('SEA management process exited: ' + stderr);
      }
      const match = /Supervisor management API listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) { port = Number(match[1]); break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!port) throw new Error('SEA management startup timed out: ' + stderr);
    const url = `http://127.0.0.1:${port}/applications`;
    const unauthorized = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(unauthorized.status, 401);
    await unauthorized.body?.cancel();
    const response = await fetch(url, {
      headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
    console.log('[ARM SEA] Management API smoke test passed');
  } finally {
    if (child && exit) {
      child.kill();
      await exit.catch(() => {});
    }
    await rm(configPath, { force: true });
    await rm(join(dirname(exe), 'smoke-data'), { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function main() {
  requireWindowsBuildHost();
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, 'build-'));
  try {
    const main = await bundleSupervisor(staging);
    const exe = await createExecutable(staging, main);
    await verifyExecutable(exe);
    await verifyManagementApi(exe);
    const destination = join(output, 'arm-supervisor.exe');
    await rename(exe, destination);
    console.log(`[ARM SEA] Verified executable: ${destination}`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();

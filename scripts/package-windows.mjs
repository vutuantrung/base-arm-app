import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { verifyExecutable, verifyManagementApi } from './build-sea.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'release', 'portable');
const version = process.versions.node;
const nodeName = 'node-v' + version + '-win-x64';
const tar = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');

function run(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, {
    cwd, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${executable} (${result.status})\n${result.stderr}`);
  return result.stdout.trim();
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error('Download failed: ' + url + ' HTTP ' + response.status);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
}

async function stageNodeRuntime(staging, distribution) {
  const origin = 'https://nodejs.org/dist/v' + version + '/';
  const zipName = nodeName + '.zip';
  const archive = join(staging, zipName);
  const checksums = join(staging, 'SHASUMS256.txt');
  await download(origin + 'SHASUMS256.txt', checksums);
  const expected = (await readFile(checksums, 'utf8')).split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .find(parts => parts[1] === zipName)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Missing official Node ZIP checksum');
  await download(origin + zipName, archive);
  assert.equal(await sha256(archive), expected.toLowerCase(), 'Node runtime checksum mismatch');
  run(tar, ['-xf', archive, '-C', staging], staging);
  await rename(join(staging, nodeName), join(distribution, 'runtime'));
  await copyFile(checksums, join(distribution, 'NODE-SHASUMS256.txt'));
  return expected;
}

async function stageRuntimeAssets(distribution) {
  const assets = join(distribution, 'runtime-assets');
  const packages = join(assets, 'dist', 'packages');
  await mkdir(packages, { recursive: true });
  await cp(join(root, 'dist', 'packages', 'runtime-injection', 'runtime'),
    join(assets, 'preloads'), { recursive: true });
  for (const name of ['arm-client-sdk', 'core', 'adapter-http', 'shared', 'library']) {
    await cp(join(root, 'dist', 'packages', name), join(packages, name), { recursive: true });
  }
  // Copy only the SDK runtime's locked external dependency, not workspace
  // symlinks, TypeScript, tsx, or esbuild. ws native accelerators are optional.
  await mkdir(join(assets, 'node_modules'), { recursive: true });
  await cp(join(root, 'node_modules', 'ws'), join(assets, 'node_modules', 'ws'), { recursive: true });
  await writeFile(join(assets, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));
}

async function stageConfiguration(distribution) {
  const example = (await readFile(join(root, '.env.example'), 'utf8'))
    .replace(/^ARM_NODE_EXECUTABLE=.*$/m, 'ARM_NODE_EXECUTABLE=./runtime/node.exe')
    .replace(/^ARM_NPM_CLI=.*$/m, 'ARM_NPM_CLI=./runtime/node_modules/npm/bin/npm-cli.js')
    .replace(/^ARM_RUNTIME_ASSETS=.*$/m, 'ARM_RUNTIME_ASSETS=./runtime-assets');
  await writeFile(join(distribution, '.env.example'), example);
  await copyFile(join(root, 'docs', 'PHASE_PKG_4_PORTABLE_DISTRIBUTION.md'), join(distribution, 'README.md'));
  await cp(join(root, 'scripts', 'windows'), join(distribution, 'scripts'), { recursive: true });
}

async function verifyDistribution(distribution, staging) {
  const exe = join(distribution, 'arm-supervisor.exe');
  const executable = join(distribution, 'runtime', 'node.exe');
  const npmCli = join(distribution, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cwd = join(staging, 'unrelated working directory');
  await mkdir(cwd);
  const env = { SystemRoot: process.env.SystemRoot || 'C:/Windows',
    PATH: join(process.env.SystemRoot || 'C:/Windows', 'System32'),
    TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  assert.equal(run(executable, ['--version'], cwd, env), 'v' + version);
  const npmVersion = run(executable, [npmCli, '--version'], cwd, env);
  assert.match(npmVersion, /^\d+\.\d+\.\d+/);
  const sdk = join(distribution, 'runtime-assets', 'dist', 'packages', 'arm-client-sdk', 'src', 'arm-runtime.js');
  run(executable, ['--input-type=module', '-e',
    'const sdk = await import(' + JSON.stringify(pathToFileURL(sdk).href) + '); if(typeof sdk.createArmRuntime !== "function") process.exit(1);'], cwd, env);
  const fixture = join(staging, 'npm fixture');
  await mkdir(fixture);
  await writeFile(join(fixture, 'package.json'), '{"name":"arm-offline-fixture","version":"1.0.0"}');
  await writeFile(join(fixture, 'package-lock.json'), '{"name":"arm-offline-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"arm-offline-fixture","version":"1.0.0"}}}');
  run(executable, [npmCli, 'ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], fixture, env);
  await verifyExecutable(exe);
  await verifyManagementApi(exe, { executable, npmCli, isolated: true });
  return npmVersion;
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !version.startsWith('22.')) {
    throw new Error('Portable packaging requires Windows x64 and Node 22');
  }
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, 'build-'));
  try {
    const distribution = join(staging, 'ARM Supervisor');
    await mkdir(distribution);
    await copyFile(join(root, 'release', 'sea', 'arm-supervisor.exe'), join(distribution, 'arm-supervisor.exe'));
    const nodeSha256 = await stageNodeRuntime(staging, distribution);
    await stageRuntimeAssets(distribution);
    await stageConfiguration(distribution);
    const npmVersion = await verifyDistribution(distribution, staging);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFile(join(distribution, 'distribution.json'), JSON.stringify({
      schemaVersion: 1, version: pkg.version, platform: 'win32', arch: 'x64',
      nodeVersion: version, npmVersion, nodeArchiveSha256: nodeSha256,
      supervisorSha256: await sha256(join(distribution, 'arm-supervisor.exe')),
    }, null, 2));
    const filename = 'arm-supervisor-' + pkg.version + '-win-x64.zip';
    const zip = join(staging, filename);
    // Archive the whole tree, including npm's hidden files and .env.example.
    run(tar, ['-a', '-cf', zip, '-C', distribution, '.'], staging);
    // Re-extract before publication to catch archive/layout errors, including hidden files.
    const extracted = join(staging, 'extracted distribution');
    await mkdir(extracted);
    run(tar, ['-xf', zip, '-C', extracted], staging);
    assert.equal(await sha256(join(extracted, 'arm-supervisor.exe')), await sha256(join(distribution, 'arm-supervisor.exe')));
    assert.equal(await sha256(join(extracted, '.env.example')), await sha256(join(distribution, '.env.example')));
    await verifyExecutable(join(extracted, 'arm-supervisor.exe'));
    await verifyManagementApi(join(extracted, 'arm-supervisor.exe'), { isolated: true });
    const digest = await sha256(zip);
    await writeFile(join(staging, filename + '.sha256'), digest + '  ' + filename + '\n');
    await rename(zip, join(output, filename));
    await rename(join(staging, filename + '.sha256'), join(output, filename + '.sha256'));
    console.log('[ARM portable] Verified distribution: ' + join(output, filename));
  } finally { await rm(staging, { recursive: true, force: true }); }
}

await main();

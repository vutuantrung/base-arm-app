import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireNodeArchive } from './node-runtime-archive.mjs';

test('local and cached archives are checked without network access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arm-node-source-'));
  try {
    const version = '22.11.0';
    const name = 'node-v' + version + '-win-x64.zip';
    const cache = join(root, 'cache');
    const source = join(cache, 'v' + version);
    await mkdir(source, { recursive: true });
    const archive = join(source, name);
    const checksums = join(source, 'SHASUMS256.txt');
    const digest = createHash('sha256').update('fixture').digest('hex');
    await writeFile(archive, 'fixture');
    await writeFile(checksums, digest + '  ' + name + '\n');
    const staging = join(root, 'staging');
    await mkdir(staging);
    assert.equal((await acquireNodeArchive({ version, cache, staging, localArchive: archive })).expected, digest);
    assert.equal((await acquireNodeArchive({ version, cache, staging })).expected, digest);
    await writeFile(archive, 'corrupt');
    await assert.rejects(acquireNodeArchive({ version, cache, staging }), /checksum mismatch/);
    await assert.rejects(acquireNodeArchive({ version, cache, staging, localArchive: archive }), /checksum mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

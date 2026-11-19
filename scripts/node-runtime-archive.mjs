import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function verifyArchive(archive, checksums, name) {
  const matches = (await readFile(checksums, 'utf8')).split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts[1] === name);
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/i.test(matches[0][0])) {
    throw new Error('Missing or ambiguous official Node ZIP checksum: ' + name);
  }
  const expected = matches[0][0].toLowerCase();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('Node runtime checksum mismatch: ' + archive);
  return expected;
}

async function download(url, destination) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
      return;
    } catch (error) {
      await rm(destination, { force: true });
      if (attempt === 3) throw new Error(
        'Cannot download ' + url + '. Provide ARM_NODE_ZIP and ARM_NODE_SHASUMS to package locally. ' +
        (error.cause?.code || error.message), { cause: error });
      console.warn('[ARM portable] Download attempt ' + attempt + ' failed; retrying');
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/** Acquire trusted operator input or a verified, version-specific archive cache. */
export async function acquireNodeArchive({ version, cache, staging, localArchive, localChecksums }) {
  if (!/^22\.\d+\.\d+$/.test(version)) throw new Error('Unsupported build Node version');
  const name = 'node-v' + version + '-win-x64.zip';
  const archive = join(staging, name);
  const checksums = join(staging, 'SHASUMS256.txt');
  if (localArchive || localChecksums) {
    if (!localArchive) throw new Error('ARM_NODE_ZIP required with ARM_NODE_SHASUMS');
    const source = resolve(localArchive);
    const sums = resolve(localChecksums || join(dirname(source), 'SHASUMS256.txt'));
    await copyFile(source, archive);
    await copyFile(sums, checksums);
    const expected = await verifyArchive(archive, checksums, name);
    console.log('[ARM portable] Verified local Node archive: ' + source);
    return { archive, checksums, expected };
  }

  const cacheDir = join(cache, 'v' + version);
  const cachedArchive = join(cacheDir, name);
  const cachedSums = join(cacheDir, 'SHASUMS256.txt');
  if (await exists(cachedArchive) && await exists(cachedSums)) {
    await copyFile(cachedArchive, archive);
    await copyFile(cachedSums, checksums);
    const expected = await verifyArchive(archive, checksums, name);
    console.log('[ARM portable] Verified cached Node archive: ' + cachedArchive);
    return { archive, checksums, expected };
  }

  const origin = 'https://nodejs.org/dist/v' + version + '/';
  await download(origin + 'SHASUMS256.txt', checksums);
  await download(origin + name, archive);
  const expected = await verifyArchive(archive, checksums, name);
  // Cache publication follows verification; version directory is trusted local storage.
  await mkdir(cacheDir, { recursive: true });
  const temporary = await mkdtemp(join(cacheDir, 'incoming-'));
  try {
    await copyFile(archive, join(temporary, name));
    await copyFile(checksums, join(temporary, 'SHASUMS256.txt'));
    await rename(join(temporary, name), cachedArchive);
    await rename(join(temporary, 'SHASUMS256.txt'), cachedSums);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { archive, checksums, expected };
}

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { validateArchiveEntryPath } from './application-package-validator.js';

export interface ArchiveLimits {
  maxExtractedBytes: number;
  maxEntries: number;
}
interface ZipEntry {
  path: string;
  isDirectory: boolean;
  compressedSize: number;
  size: number;
  method: number;
  crc32: number;
  localOffset: number;
}
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_ZIP_COMMENT = 65535;

function readEndDirectory(buffer: Buffer): { offset: number; count: number; directoryOffset: number } {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - MAX_ZIP_COMMENT); offset--) {
    if (buffer.readUInt32LE(offset) !== ZIP_END) continue;
    if (offset + 22 + buffer.readUInt16LE(offset + 20) !== buffer.length) continue;
    if (buffer.readUInt16LE(offset + 4) !== 0 || buffer.readUInt16LE(offset + 6) !== 0 ||
        buffer.readUInt16LE(offset + 8) !== buffer.readUInt16LE(offset + 10)) {
      throw new Error('Multi-disk ZIP archives are not supported');
    }
    return {
      offset,
      count: buffer.readUInt16LE(offset + 10),
      directoryOffset: buffer.readUInt32LE(offset + 16),
    };
  }
  throw new Error('Invalid ZIP end-of-central-directory record');
}

function isUnsafeEntryMode(externalAttributes: number, madeBy: number): boolean {
  if ((madeBy >>> 8) !== 3) return false;
  const mode = externalAttributes >>> 16;
  const type = mode & 0o170000;
  return type !== 0 && type !== 0o100000 && type !== 0o040000;
}
function validateEntryType(externalAttributes: number, madeBy: number, directory: boolean): void {
  if (isUnsafeEntryMode(externalAttributes, madeBy)) {
    throw new Error('ZIP contains symlink or special filesystem entry');
  }
  if ((madeBy >>> 8) === 3) {
    const type = (externalAttributes >>> 16) & 0o170000;
    if ((directory && type === 0o100000) || (!directory && type === 0o040000)) {
      throw new Error('ZIP entry type does not match directory marker');
    }
  }
}

function parseEntries(buffer: Buffer, limits: ArchiveLimits): ZipEntry[] {
  if (buffer.length < 22) throw new Error('Not a ZIP archive');
  const end = readEndDirectory(buffer);
  if (end.count > limits.maxEntries) throw new Error('Too many ZIP entries');
  let offset = end.directoryOffset;
  let extractedBytes = 0;
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < end.count; index++) {
    if (offset + 46 > end.offset || buffer.readUInt32LE(offset) !== ZIP_CENTRAL) {
      throw new Error('Malformed ZIP central directory');
    }
    const madeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end.offset) throw new Error('Truncated ZIP central directory');
    if ((flags & 1) !== 0 || (flags & 0x40) !== 0) throw new Error('Encrypted ZIP not supported');
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    if ((flags & 0x800) === 0 && rawName.some(byte => byte >= 128)) {
      throw new Error('Non-UTF-8 ZIP filenames are not supported');
    }
    if (![0, 8].includes(method) || size === 0xffffffff || compressedSize === 0xffffffff ||
        localOffset === 0xffffffff) throw new Error('Unsupported ZIP format');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const isDirectory = name.endsWith('/');
    const path = validateArchiveEntryPath(name);
    validateEntryType(externalAttributes, madeBy, isDirectory);
    if (seen.has(path)) throw new Error(`Duplicate ZIP entry: ${path}`);
    seen.add(path);
    if (isDirectory && size !== 0) throw new Error('Directory ZIP entry has data');
    extractedBytes += size;
    if (extractedBytes > limits.maxExtractedBytes) throw new Error('ZIP extraction size limit exceeded');
    entries.push({ path, isDirectory, compressedSize, size, method, crc32, localOffset });
    offset = next;
  }
  if (offset !== end.offset) throw new Error('ZIP central directory does not match entry count');
  return entries;
}

function extractEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_LOCAL) {
    throw new Error('Invalid ZIP local file header');
  }
  const localNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + localNameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error('Truncated ZIP entry');
  const localName = buffer.toString('utf8', offset + 30, offset + 30 + localNameLength);
  if (localName !== entry.path + (entry.isDirectory ? '/' : '')) {
    throw new Error('ZIP header filename mismatch');
  }
  const raw = buffer.subarray(start, end);
  const data = entry.method === 0 ? raw : inflateRawSync(raw, {
    maxOutputLength: entry.size + 1,
  });
  if (data.length !== entry.size) throw new Error('ZIP entry size mismatch');
  if (crc32(data) !== entry.crc32) throw new Error('ZIP CRC32 mismatch');
  return data;
}

function crc32(data: Buffer): number {
  let result = -1;
  for (const byte of data) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0);
    }
  }
  return (result ^ -1) >>> 0;
}

/** Verifies every entry before writing, then extracts only regular files and directories. */
export async function extractApplicationArchive(
  archive: Buffer,
  destination: string,
  limits: ArchiveLimits,
): Promise<void> {
  const entries = parseEntries(archive, limits);
  const paths = new Set(entries.filter(entry => !entry.isDirectory).map(entry => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let length = 1; length < parts.length; length++) {
      if (paths.has(parts.slice(0, length).join('/'))) {
        throw new Error('ZIP entry path conflicts with an existing file');
      }
    }
    if (entry.isDirectory && paths.has(entry.path)) {
      throw new Error('ZIP directory conflicts with a regular file');
    }
  }
  const contents = entries.map(entry => ({ entry, data: extractEntry(archive, entry) }));
  await mkdir(destination, { recursive: true });
  for (const { entry, data } of contents) {
    const target = join(destination, ...entry.path.split('/'));
    if (!target.startsWith(destination + sep)) throw new Error('Invalid resolved ZIP path');
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    }
  }
}

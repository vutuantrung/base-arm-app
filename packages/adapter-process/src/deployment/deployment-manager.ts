import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { validateApplicationManifest, validateRuntimeCompatibility } from './application-package-validator.js';
import { extractApplicationArchive } from './application-package-extractor.js';
import { ApplicationStorage } from './application-storage.js';
import { NpmCiInstaller, type DependencyInstaller } from './application-installer.js';
import type { ApplicationManifest, DeploymentOptions, DeploymentReceipt, InstalledRelease } from './deployment-types.js';

const DEFAULT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_INSTALL_TIMEOUT = 120_000;

/** Phase 1: ZIP artifact -> verified staging -> npm ci -> immutable release. */
export class DeploymentManager {
  readonly storage: ApplicationStorage;
  private readonly pending = new Set<string>();
  constructor(
    private readonly options: DeploymentOptions,
    private readonly installer: DependencyInstaller = new NpmCiInstaller(),
  ) {
    this.storage = new ApplicationStorage(options.storageRoot);
  }
  async installZip(archivePath: string): Promise<DeploymentReceipt> {
    const archive = await this.readAndValidateArchive(archivePath);
    const staging = await this.storage.createStagingDirectory();
    let publishComplete = false;
    try {
      await extractApplicationArchive(archive.data, staging, {
        maxExtractedBytes: this.options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES,
        maxEntries: this.options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      });
      const manifest = await this.readAndValidateManifest(staging);
      const key = `${manifest.applicationId}@${manifest.version}`;
      if (this.pending.has(key)) throw new Error(`Deployment already pending: ${key}`);
      this.pending.add(key);
      try {
        const receipt = await this.installStagedRelease(staging, manifest, archive.sha256);
        publishComplete = !receipt.alreadyInstalled;
        return receipt;
      } finally {
        this.pending.delete(key);
      }
    } finally {
      if (!publishComplete) await this.storage.removeStaging(staging);
    }
  }
  private async readAndValidateArchive(path: string): Promise<{ data: Buffer; sha256: string }> {
    const maximum = this.options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    const file = await stat(path);
    if (!file.isFile() || file.size > maximum) throw new Error('ZIP archive exceeds size limit');
    const data = await readFile(path);
    if (data.length > maximum) throw new Error('ZIP archive exceeds size limit');
    return { data, sha256: createHash('sha256').update(data).digest('hex') };
  }
  private async readAndValidateManifest(staging: string): Promise<ApplicationManifest> {
    const raw = await readFile(join(staging, 'app.manifest.json'), 'utf8');
    const manifest = validateApplicationManifest(JSON.parse(raw) as unknown);
    validateRuntimeCompatibility(manifest.runtime.nodeVersion);
    await this.assertRegularFileInStaging(staging, manifest.runtime.entry);
    await this.assertRegularFileInStaging(staging, 'package.json');
    await this.assertRegularFileInStaging(staging, 'package-lock.json');
    return manifest;
  }
  private async assertRegularFileInStaging(staging: string, entry: string): Promise<void> {
    const target = await realpath(join(staging, entry));
    if (!target.startsWith(resolve(staging) + sep)) throw new Error('Entry escapes staging');
    if (!(await stat(target)).isFile()) throw new Error(`Missing regular file: ${entry}`);
  }
  private async installStagedRelease(
    staging: string,
    manifest: ApplicationManifest,
    sha256: string,
  ): Promise<DeploymentReceipt> {
    const { applicationId, version } = manifest;
    const existing = await this.storage.readRelease(applicationId, version);
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error('Immutable release version checksum conflict');
      return { release: existing, alreadyInstalled: true };
    }
    await this.installer.install(staging, this.options.installationTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT);
    const directory = this.storage.releaseDirectory(applicationId, version);
    const release: InstalledRelease = {
      applicationId, version, directory,
      entry: join(directory, manifest.runtime.entry),
      sha256,
      installedAt: new Date().toISOString(),
      manifest,
    };
    await this.storage.publishRelease(staging, release);
    return { release, alreadyInstalled: false };
  }
}

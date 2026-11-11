import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstalledRelease } from './deployment-types.js';

export class ApplicationStorage {
  readonly root: string;
  constructor(storageRoot: string) {
    this.root = resolve(storageRoot);
  }
  async createStagingDirectory(): Promise<string> {
    const dir = join(this.root, 'staging', randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  releaseDirectory(applicationId: string, version: string): string {
    return join(this.root, 'applications', applicationId, 'releases', version);
  }
  async readRelease(applicationId: string, version: string): Promise<InstalledRelease | undefined> {
    const file = join(this.releaseDirectory(applicationId, version), '.deployment.json');
    try {
      return JSON.parse(await readFile(file, 'utf8')) as InstalledRelease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async listReleases(applicationId: string): Promise<InstalledRelease[]> {
    const releasesDir = join(this.root, 'applications', applicationId, 'releases');
    let names: string[];
    try {
      names = await readdir(releasesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const releases = await Promise.all(names.map(name => this.readRelease(applicationId, name)));
    return releases.filter((item): item is InstalledRelease => item !== undefined);
  }
  async publishRelease(stagingDir: string, release: InstalledRelease): Promise<void> {
    const destination = release.directory;
    await mkdir(join(this.root, 'applications', release.applicationId, 'releases'), {
      recursive: true,
    });
    await writeFile(join(stagingDir, '.deployment.json'), JSON.stringify(release, null, 2), {
      flag: 'wx', mode: 0o600,
    });
    await rename(stagingDir, destination);
  }
  async removeStaging(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }
}

import type { PackageCatalog, ReleaseDescriptor } from '../../contracts/src/index.js';
import { ApplicationStorage } from './application-storage.js';
import type { InstalledRelease } from './deployment-types.js';

function toReleaseDescriptor(release: InstalledRelease): ReleaseDescriptor {
  return {
    applicationId: release.applicationId,
    version: release.version,
    entry: release.entry,
    directory: release.directory,
  };
}

/** Read-only projection of immutable installed releases. */
export class PackageCatalogAdapter implements PackageCatalog {
  constructor(private readonly storage: ApplicationStorage) {}

  async getRelease(applicationId: string, version: string): Promise<ReleaseDescriptor | undefined> {
    const release = await this.storage.readRelease(applicationId, version);
    return release ? toReleaseDescriptor(release) : undefined;
  }

  async listReleases(applicationId: string): Promise<readonly ReleaseDescriptor[]> {
    return (await this.storage.listReleases(applicationId)).map(toReleaseDescriptor);
  }
}

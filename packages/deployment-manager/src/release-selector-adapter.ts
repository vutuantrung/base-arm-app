import type {
  PackageCatalog, ReleaseDescriptor, ReleaseSelector,
} from '../../contracts/src/index.js';
import type { ReleaseRuntimePort } from './runtime-ports.js';
import { ApplicationReleaseManager } from './application-release-manager.js';

/** Release selection still uses the existing safety/audit workflow. */
export class ReleaseSelectorAdapter implements ReleaseSelector {
  constructor(
    private readonly releases: ApplicationReleaseManager,
    private readonly runtime: ReleaseRuntimePort,
    private readonly catalog: PackageCatalog,
  ) {}

  async activeRelease(applicationId: string): Promise<ReleaseDescriptor | undefined> {
    const applications = await this.runtime.lifecycle.listApplications();
    const active = applications.find(item => item.applicationId === applicationId);
    return active ? this.catalog.getRelease(applicationId, active.version) : undefined;
  }

  async activate(applicationId: string, version: string): Promise<void> {
    await this.releases.activateRelease(applicationId, version);
  }
}

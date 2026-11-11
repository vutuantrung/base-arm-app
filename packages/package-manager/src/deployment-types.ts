export interface ApplicationManifest {
  schemaVersion: '1.0';
  applicationId: string;
  version: string;
  runtime: { type: 'nodejs'; nodeVersion: string; entry: string };
  install: { strategy: 'npm-ci'; buildRequired: false };
  arm: { enabled: boolean; metricsPort?: number };
  lifecycle: {
    autoStart: boolean;
    restartPolicy: 'never' | 'on-failure' | 'always';
    maxRestarts: number;
    stopTimeoutMs: number;
  };
}
export interface InstalledRelease {
  applicationId: string;
  version: string;
  directory: string;
  entry: string;
  sha256: string;
  installedAt: string;
  manifest: ApplicationManifest;
}
export interface DeploymentOptions {
  storageRoot: string;
  maxArchiveBytes?: number;
  maxExtractedBytes?: number;
  maxEntries?: number;
  installationTimeoutMs?: number;
}
export interface DeploymentReceipt {
  release: InstalledRelease;
  alreadyInstalled: boolean;
}

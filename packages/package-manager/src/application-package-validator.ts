import { isAbsolute, posix } from 'node:path';
import type { ApplicationManifest } from './deployment-types.js';

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path)) return false;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  const parts = path.split('/');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..') &&
    posix.normalize(path) === path;
}
function hasSafeRuntime(value: unknown): value is ApplicationManifest['runtime'] {
  return isRecord(value) && value.type === 'nodejs' &&
    typeof value.nodeVersion === 'string' &&
    /^>=\s*(20|21|22|23|24|25|26)(?:\.\d+)?(?:\.\d+)?$/.test(value.nodeVersion) &&
    typeof value.entry === 'string' && isSafeRelativePath(value.entry) &&
    value.entry.endsWith('.js');
}
function hasSafeInstall(value: unknown): value is ApplicationManifest['install'] {
  return isRecord(value) && value.strategy === 'npm-ci' && value.buildRequired === false;
}
function hasValidArm(value: unknown): value is ApplicationManifest['arm'] {
  return isRecord(value) && typeof value.enabled === 'boolean' &&
    (value.metricsPort === undefined ||
      (Number.isInteger(value.metricsPort) && (value.metricsPort as number) >= 1 &&
        (value.metricsPort as number) <= 65535));
}
function hasValidLifecycle(value: unknown): value is ApplicationManifest['lifecycle'] {
  return isRecord(value) && typeof value.autoStart === 'boolean' &&
    ['never', 'always', 'on-failure'].includes(String(value.restartPolicy)) &&
    Number.isInteger(value.maxRestarts) && (value.maxRestarts as number) >= 0 &&
    (value.maxRestarts as number) <= 100 &&
    Number.isInteger(value.stopTimeoutMs) && (value.stopTimeoutMs as number) >= 100 &&
    (value.stopTimeoutMs as number) <= 600_000;
}
/** Validates the manifest without allowing user-controlled shell commands. */
export function validateApplicationManifest(value: unknown): ApplicationManifest {
  if (!isRecord(value) || value.schemaVersion !== '1.0' ||
      typeof value.applicationId !== 'string' || !IDENTIFIER.test(value.applicationId) ||
      typeof value.version !== 'string' || !VERSION.test(value.version) ||
      !hasSafeRuntime(value.runtime) || !hasSafeInstall(value.install) ||
      !hasValidArm(value.arm) || !hasValidLifecycle(value.lifecycle)) {
    throw new Error('Invalid application manifest (schemaVersion 1.0 required)');
  }
  return value as unknown as ApplicationManifest;
}
/** Paths from ZIP central-directory entries must not escape deployment staging. */
export function validateArchiveEntryPath(name: string): string {
  const entry = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!isSafeRelativePath(entry)) {
    throw new Error(`Unsafe archive entry path: ${name}`);
  }
  return entry;
}
export function validateRuntimeCompatibility(required: string): void {
  const minimum = Number(/^>=\s*(\d+)/.exec(required)?.[1]);
  if (!Number.isInteger(minimum) || Number(process.versions.node.split('.')[0]) < minimum) {
    throw new Error(`This deployment requires Node.js ${required}`);
  }
}

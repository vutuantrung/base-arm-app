import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VALID_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ApplicationConfiguration {
  schemaVersion: 1;
  environment: Record<string, string>;
}

/** Operator-controlled config outside immutable ZIP releases. No inherited .env. */
export class ApplicationConfigurationStore {
  constructor(private readonly storageRoot: string) {}

  async read(applicationId: string): Promise<ApplicationConfiguration> {
    if (!VALID_ID.test(applicationId)) throw new Error('Invalid application ID');
    const file = join(this.storageRoot, 'applications', applicationId, 'application-config.json');
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, environment: {} };
      }
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid application configuration');
    }
    const object = data as Record<string, unknown>;
    if (object.schemaVersion !== 1 || !object.environment ||
      typeof object.environment !== 'object' || Array.isArray(object.environment)) {
      throw new Error('Invalid application configuration schema');
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(object.environment)) {
      if (!VALID_KEY.test(key) || typeof value !== 'string' || value.includes('\0')) {
        throw new Error(`Invalid application environment entry: ${key}`);
      }
      env[key] = value;
    }
    return { schemaVersion: 1, environment: env };
  }
}

import { mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Build-time copy of Node --import assets. Keep the original Phase 8/9
 * dist location for processes configured before the R5 migration.
 */
for (const directory of ['adapter-process', 'runtime-injection']) {
  const source = fileURLToPath(new URL(`../packages/${directory}/runtime/`, import.meta.url));
  const output = fileURLToPath(new URL(`../dist/packages/${directory}/runtime/`, import.meta.url));
  await mkdir(output, { recursive: true });
  await cp(source, output, { recursive: true });
}

import { mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../packages/adapter-process/runtime/', import.meta.url));
const output = fileURLToPath(new URL('../dist/packages/adapter-process/runtime/', import.meta.url));
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

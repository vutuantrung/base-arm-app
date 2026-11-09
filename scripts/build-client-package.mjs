import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const packageRoot = resolve(root, 'packages/library');
const target = resolve(packageRoot, 'dist');

execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(root, 'dist/packages'), resolve(target, 'packages'), { recursive: true });

await writeFile(resolve(target, 'index.js'),
  "export * from './packages/library/src/index.js';\n");
await writeFile(resolve(target, 'index.d.ts'),
  "export * from './packages/library/src/index.js';\n");

console.log('Client ARM library built at packages/library/dist');
console.log('Next: cd packages/library && npm pack');

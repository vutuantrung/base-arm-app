#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageRoot = join(root, 'packages');

/**
 * Allowed dependency directions. Legacy orchestrators in adapter-process are
 * intentionally excluded until their contracts can be migrated without changing
 * recovery and Blue/Green behavior.
 */
const dependencies = {
  'contracts': [],
  'process-manager': ['contracts'],
  'package-manager': ['contracts'],
  'deployment-manager': ['contracts', 'package-manager'],
  'runtime-monitor': ['contracts', 'process-manager', 'package-manager'],
  'service-discovery': ['contracts', 'process-manager', 'core'],
  'traffic-router': ['contracts'],
  'arm-client-sdk': ['core', 'adapter-http'],
  'runtime-injection': ['contracts'],
  'supervisor-host': [
    'contracts', 'adapter-process', 'process-manager', 'package-manager',
    'deployment-manager', 'runtime-monitor', 'service-discovery',
    'traffic-router', 'runtime-injection', 'arm-client-sdk',
  ],
};
const errors = [];
const edges = new Map();

async function walk(directory) {
  const results = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) results.push(...await walk(path));
    else if (item.isFile() && path.endsWith('.ts')) results.push(path);
  }
  return results;
}

function referencedModule(file, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const absolute = resolve(dirname(file), specifier);
  const rel = relative(packageRoot, absolute).split(sep);
  return rel.length >= 2 && rel[0] !== '..' ? rel[0] : undefined;
}

function findImports(code) {
  const results = [];
  // Static import/export and dynamic import (string literal) syntax.
  const staticImports = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImports = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [staticImports, dynamicImports]) {
    for (const match of code.matchAll(pattern)) results.push(match[1]);
  }
  return results;
}

for (const [owner, allowed] of Object.entries(dependencies)) {
  const folder = join(packageRoot, owner, 'src');
  for (const file of await walk(folder)) {
    const code = await readFile(file, 'utf8');
    for (const specifier of findImports(code)) {
      const target = referencedModule(file, specifier);
      if (!target || target === owner) continue;
      if (!allowed.includes(target)) {
        errors.push(`${relative(root, file)} imports forbidden dependency ${target} via ${specifier}`);
      }
      if (!edges.has(owner)) edges.set(owner, new Set());
      edges.get(owner).add(target);
    }
  }
}

// Dependency cycles among protected modules are forbidden (core/adapter-http
// remain internal SDK packages until their independent extraction).
const protectedPackages = new Set(Object.keys(dependencies));
function visit(node, stack, visited) {
  if (stack.includes(node)) {
    errors.push(`Circular module dependency: ${[...stack, node].join(' -> ')}`);
    return;
  }
  if (visited.has(node)) return;
  visited.add(node);
  for (const next of edges.get(node) ?? []) {
    if (protectedPackages.has(next)) visit(next, [...stack, node], visited);
  }
}
const visited = new Set();
for (const owner of protectedPackages) visit(owner, [], visited);

if (errors.length) {
  for (const error of errors) console.error('[architecture]', error);
  process.exitCode = 1;
} else {
  console.log('ARM module dependency rules passed for ' +
    Object.keys(dependencies).length + ' protected modules.');
}

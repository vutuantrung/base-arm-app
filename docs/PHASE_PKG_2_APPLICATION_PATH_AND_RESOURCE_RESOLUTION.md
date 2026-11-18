# PKG.2 — Application Path & Resource Resolution

Baseline: 6e2e493cf38d0de5478a1e46d8d52d3e2cabdd89. Target: Windows x64 portable distribution. No executable build yet.

## Path policy
Source/compiled execution keeps working-directory semantics. SEA uses dirname(process.execPath). Resolve .env (DOTENV_CONFIG_PATH override), storage, optional Node/npm settings and assets from this base. Absolute overrides remain absolute. Existing OS environment wins over .env. No global chdir. Standalone demo/CLI entrypoints retain their legacy source behavior; only management is the intended SEA entrypoint.

## Portable resource contract
```
ARM/
  arm-supervisor.exe
  .env
  runtime/node.exe
  runtime/node_modules/npm/bin/npm-cli.js
  runtime-assets/
    preloads/bootstrap.mjs
    preloads/bridge-bootstrap.mjs
    dist/packages/arm-client-sdk/src/arm-runtime.js
    dist/packages/... (preserve all SDK transitive relative imports)
    package.json (type: module)
    node_modules/ (SDK production dependencies, including ws)
  supervisor-data/
```
PKG.4 will assemble this tree; PKG.2 only resolves it. npm CLI defaults adjacent to the selected Node executable. Explicit ARM_RUNTIME_ASSETS selects the same tree in source mode, useful for testing. Explicit assets fail if missing rather than silently falling back to source. Existing source injection and legacy SDK fallback remain unchanged. On Windows use file URL for --import to support drive paths. Paths are trusted operator configuration, never manifest values. Injection assets are validated on use; full startup preflight remains future work.

Storage layout and state schema unchanged; existing releases contain absolute paths, so moving a populated data root is NOT supported without migration/reinstall. Configuration refresh fix at baseline preserved; add missing pathFor helper required by existing tests. No Windows PID adoption changes and no R7.2 adapter implementation.

## Verification
npm ci
npm run build
npm run check:architecture
node --import tsx --test tests/supervisor-paths.test.ts
npm run verify

Windows smoke test with absolute and relative paths, different CWD, spaces in paths and active SDK bridge is required in PKG.5. Existing Blue/Green and dynamic registration failures are separate.

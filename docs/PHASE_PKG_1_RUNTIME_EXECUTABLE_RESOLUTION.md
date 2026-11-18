# PKG.1 — Runtime Executable Resolution

Target: Windows x64 portable distribution. Baseline: 12bb100f93346d801503c6bd5eeaac79b32e19c4.
This increment is source-mode preparation, not SEA packaging or R7.2.

## Decision and ownership
- SupervisorHost resolves operator-owned NodeRuntimeToolchain (executable, actual version, npm CLI). Shared contract is data only; no process ownership changes.
- ProcessManager receives an optional executable argument. Existing callers default to process.execPath. Both singleton and Blue/Green use the same configured executable.
- PackageManager invokes npm-cli.js with the same Node executable, shell disabled; no npm.cmd in Windows mode. Manifest minimum Node major is checked against the configured runtime during installation. Existing major-only comparison is intentionally preserved.
- POSIX with no settings retains legacy system npm and process.execPath. Windows source defaults to node.exe and its adjacent node_modules/npm/bin/npm-cli.js; nonstandard installations must specify paths.
- SEA requires explicit child executable; no self-spawning fallback at the configured host boundary. Paths are resolved against current working directory in PKG.1. Executable-relative assets/config are PKG.2.
- Only operator-controlled trusted paths; regular file validation and bounded version probe. This is not sandboxing or cryptographic provenance verification. Existing installed releases are not revalidated on every spawn; use a compatible toolchain for all existing releases.
- R7.1 remains unchanged: runtime adapter will eventually consume resolved executable, prepare launch only, shared OS lifecycle. No runtime field, manifest 1.1, registry migration, or adapter implementation in PKG.1.

## Source-mode Windows smoke test
Extract the official Windows x64 Node ZIP to runtime/. Run from repository root:
```dotenv
ARM_NODE_EXECUTABLE=./runtime/node.exe
ARM_NPM_CLI=./runtime/node_modules/npm/bin/npm-cli.js
```
Then npm install, npm run build, npm run dev:management. Upload a fresh ZIP, activate and start through existing API. Check child executable using PowerShell Get-CimInstance Win32_Process. Restart the child to change executable; adoption does not relaunch it.
Legacy source CLI deploy:zip and app:manage also use resolution. Do not run concurrent writers.
No EXE yet, no bundled Node download, no changes to runtime assets resolution. Windows PID adoption remains a known limitation. Stop managed Windows children before replacing/restarting Supervisor to avoid unverified live PIDs.

## Verification
npm run build
npm run check:architecture
node --import tsx --test tests/node-runtime-resolution.test.ts
npm test

Windows x64 integration: upload/install without npm.cmd/PATH, spawn with configured runtime, logging, injection, recovery, Blue/Green and safe stop behavior. Existing CI baseline failures must not be mistaken for passing verification.

# ADR-R7-002 — Runtime Manifest v1.1 and Legacy Node.js Compatibility

- **Status:** Proposed for acceptance (v1.0 retained, v1.1 introduced — approved by project owner)
- **Date:** 2026-11-12
- **Branch / inspected HEAD:** `arm-supervisor` / `dbe499a78b51543bcef6f6473791812cb34b66f7`
- **Scope:** Manifest and release mapping only; no code changes

## Context

Existing manifest is strictly `schemaVersion: '1.0'`, `runtime.type='nodejs'`, `nodeVersion`, normalized JS `entry`, `install.strategy='npm-ci'` and `buildRequired=false`, plus required `arm` and `lifecycle`. `DeploymentManager` checks Node compatibility and requires `package.json`/`package-lock.json`; it writes immutable `InstalledRelease` metadata and an absolute `release.entry`.

`ApplicationStorage.readRelease` parses persisted `.deployment.json` with a TS assertion rather than runtime shape validation. The singleton lifecycle coordinator validates manifests on `requireRelease`, whereas the Blue/Green coordinator directly accesses `release.manifest.arm.enabled`. This inconsistency is implicated in the current CI error but the precise fixture/root cause is not yet confirmed.

## Decision

1. Preserve **all existing v1.0 shape and validation semantics**; do not broaden v1.0 to accept non-Node runtime or `prebuilt` installs.
2. Add strictly versioned **v1.1** manifests with a discriminated `runtime.type` (`nodejs`, `electron`, `executable`) and compatible install strategy per runtime.
3. Parse external/receipt JSON as `unknown`, dispatch by explicit `schemaVersion`, and validate with version-specific type guards. Reject unknown versions and mismatched runtime/install combinations; avoid unvalidated `as InstalledRelease` at trust boundary.
4. Keep package-manager as owner of schema validation, installation, immutable receipt, release-entry containment. The application coordinator translates validated release to optional-runtime `ProcessSpec`; process-manager does not parse ZIP manifests.
5. Maintain `ProcessSpec.runtime` optional, defaulting to Node.js semantics for legacy direct callers. New runtime requests must be explicitly discriminated and validated.
6. `prebuilt` never executes archive-specified install scripts. Executable entry must be within validated release root or an operator-authorized trusted runtime binary reference. Use argument arrays only, not shell command strings.
7. Existing `.deployment.json`, `active.json`, PID registries, rollout/BlueGreen metadata and legacy paths remain readable without implicit rewrite/migration.

## Proposed v1.1 shape (draft, subject to implementation validation)

```ts
type Runtime11 =
  | { type: 'nodejs'; nodeVersion: string; entry: string; args?: string[] }
  | { type: 'electron'; binaryRef: string; entry: string; args?: string[] }
  | { type: 'executable'; entry: string; args?: string[] };

type Install11 = { strategy: 'npm-ci'; buildRequired: false } | { strategy: 'prebuilt' };

// Schema is a discriminated union of *runtime and allowed install combinations*,
// not the uncorrelated cartesian product Runtime11 x Install11.
```

- v1.1 Node.js: `npm-ci` supported, same Node compatibility and injection rules as existing behavior by default.
- v1.1 Electron: trusted Electron binary (configured operator-side), release-contained app entry, initial `prebuilt` packaging. GUI session and signed application handling deferred to R7.5.
- v1.1 executable: release-contained executable and `prebuilt` packaging, execute-bit/platform policy and identity validation deferred to R7.4.
- `arm.enabled=true` in non-Node v1.1 should fail closed initially unless an explicit supported SDK integration contract is introduced; do not infer that Electron renderer or any native process supports Node `--import`.

## Compatibility and security requirements

| Case | Expected |
|---|---|
| Valid existing 1.0 Node ZIP | Same installation, release path, runtime launch |
| Invalid 1.0 manifest | Still rejected; do not silently normalize to 1.1 |
| Valid 1.1 explicit Node | Validated, does not override legacy calls |
| 1.1 executable with `npm-ci` | Rejected if pairing disallowed |
| 1.1 executable absolute path, `..`, symlink escape | Rejected before spawn |
| 1.1 unknown type, unknown version, malformed fields | Rejected with diagnostic validation error |
| Old `.deployment.json` and PID registry | Read without rewrite/migration |
| Persisted malformed `.deployment.json` | Fail closed with explicit validation error, not generic TypeError |
| Already-installed release checksum match | Validate receipt before treating as valid installation |
| Adopted Node process | Never re-inject/re-spawn to change runtime on reconciliation |

Paths must be validated after canonicalization, with symlink/race checks; avoid trusting archive-controlled permission flags or absolute host binary selection. Trust registry and OS execution policy own privileged executable resolution. Manifest v1.1 does not grant ability to opt into `shell: true`, arbitrary `NODE_OPTIONS`, `ARM_*` secrets or OS process kill scope.

## Consequences

Version-specific validators and installer policies increase code surface, but preserve old deployments and isolate new runtime requirements. Release reads must be consistently validated for singleton, Blue/Green and deployment queries. Introducing schema 1.1 does not itself implement runtime support; unsupported runtime should fail explicitly until its adapter and installation/OS capabilities are enabled.

## Follow-up and acceptance

Define the exact v1.1 JSON schema, supported OS/architecture requirements and trusted executable registry keys; preserve identical v1.0 behavior; implement typed release validation shared across coordinators; add malformed persisted-receipt and Blue/Green fixture regressions. Do not treat current GitHub Actions CI as passed until regression run completes successfully. Architecture gate must preserve R1–R6 boundaries.

## References

- `docs/PHASE_R3_PACKAGE_AND_DEPLOYMENT_EXTRACTION.md`
- `packages/package-manager/src/deployment-types.ts`
- `packages/package-manager/src/application-package-validator.ts`
- `packages/package-manager/src/deployment-manager.ts`
- `packages/package-manager/src/application-storage.ts`
- `packages/adapter-process/src/blue-green-deployment-manager.ts`
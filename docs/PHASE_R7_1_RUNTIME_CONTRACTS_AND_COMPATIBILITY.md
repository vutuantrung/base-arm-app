# Phase R7.1 — Runtime Contracts & Backward Compatibility

**Project:** ARM Supervisor — `vutuantrung/base-arm-app`  
**Branch / inspected baseline:** `arm-supervisor` / `dbe499a78b51543bcef6f6473791812cb34b66f7`  
**Date:** 2026-11-12  
**Status:** Architecture proposal; user approved four foundational choices; implementation NOT started.

## 1. Objective and boundaries

Extend ARM's Node-only process launch model into multi-runtime process management, while retaining R1–R6 ownership: package-manager validates/packages/releases, process-manager owns process identity and lifecycle, runtime-monitor owns desired state/recovery, deployment-manager coordinates release changes, supervisor-host composes concrete dependencies, and runtime-injection retains Node SDK instrumentation.

**Explicitly selected choices**:
1. `RuntimeAdapter` prepares a `LaunchPlan` only; it does not spawn/stop/inspect.
2. `ProcessSpec.runtime` is optional; absence means legacy Node.js behavior.
3. Preserve manifest `schemaVersion: '1.0'` unchanged; introduce version `1.1` for new runtimes.
4. A single shared OS process layer owns spawn, identity, adoption, termination and process-tree control.

**Non-goals for R7.1:** modifying source/runtime behavior, adding actual Electron or native process spawning, replacing the global per-app operation lock, cross-platform adoption implementation, SDK reimplementation, introducing remote processes/microservices.

## 2. Verified current baseline / source touchpoints

- `packages/contracts/src/index.ts`: `ProcessLaunchRequest` includes `entry`, `cwd`, `arguments`, and separate application/runtime environment; `ProcessController` start/stop/restart/inspect must remain source-compatible.
- `packages/process-manager/src/process-manager.ts`: legacy `ProcessSpec` has `entry`, `args`, `cwd`, `env`, `applicationEnv`, metrics fields; spawn uses `process.execPath`, optionally Node `--import` arguments, `detached: true`, `stdio: 'ignore'`, `windowsHide: true`. Linux adopted PID verified by `/proc/<pid>/stat` start time; other platforms do not safely adopt unknown PIDs. `close()` deliberately does not kill children.
- `packages/process-manager/src/process-launch-instrumentation.ts`: `nodeArguments()` and `environment()` are currently Node-specific. Do not break this port for legacy call sites.
- `packages/package-manager/src/deployment-types.ts`: only Node.js with `nodeVersion`, JS `entry`, `install.strategy='npm-ci'`, `buildRequired=false`, `arm` and `lifecycle` required.
- `packages/package-manager/src/application-package-validator.ts`: strict current 1.0 validator, relative normalized path, `.js` entry, Node semver and npm-ci. No relaxation for v1.0.
- `packages/package-manager/src/deployment-manager.ts`: Node-version validation, `package.json` and `package-lock.json` checks, `npm ci`, `InstalledRelease.entry` absolute path.
- `packages/package-manager/src/application-storage.ts`: `readRelease` parses JSON with a TypeScript assertion but no runtime validation; need read boundary validation without implicit migration.
- `packages/adapter-process/src/application-lifecycle-manager.ts`: converts installed release into `ProcessSpec`, validates persisted release manifest at `requireRelease`.
- `packages/adapter-process/src/blue-green-deployment-manager.ts`: `buildSpec` directly reads persisted release and accesses `release.manifest.arm.enabled` without manifest validation; CI currently reports TypeError there on a Phase 7 test.
- `packages/supervisor-host/src/supervisor-host.ts`: explicit composition root, currently constructs legacy managers; should bind runtime registry once.

**CI gate:** latest inspected GitHub Actions run 43055376989 is `cancelled` after TypeScript build and architecture checker succeeded, with Phase 7 Blue/Green test failure (`release.manifest.arm.enabled` undefined). Do not mark R6 regression green. Root cause of invalid fixture vs validation bypass not yet established.

## 3. Domain model and translation boundaries

Do NOT equate these types:

- **Untrusted manifest**: JSON from ZIP or persisted metadata; owned and validated by package-manager.
- **Validated release**: immutable installed artifact and canonical entry path, owned by package-manager.
- **ProcessSpec**: trusted runtime launch *request* produced by an application orchestration boundary, owned by process-manager (legacy shape remains accepted).
- **RuntimeLaunchRequest**: normalized, discriminated request consumed by a runtime adapter; must not expose raw unvalidated manifest JSON.
- **LaunchPlan**: validated executable, literal argument vector, cwd, sanitized env, and OS launch policy. It is ephemeral, not durable state.
- **ManagedProcessState**: PID, start identity, port and lifecycle metadata written after spawn; do not persist a LaunchPlan or secrets.

### 3.1 Draft TypeScript contracts (illustrative, not committed API)

```ts
export type BuiltinRuntimeType = 'nodejs' | 'electron' | 'executable';

export type RuntimeConfiguration =
  | { readonly type: 'nodejs'; readonly nodeExecutable?: 'supervisor' }
  | { readonly type: 'electron'; readonly binaryRef: string }
  | { readonly type: 'executable'; readonly executableRef: string };

// Extend existing ProcessSpec — do not remove/rename legacy fields.
export interface ProcessSpec {
  id: string;
  entry: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  applicationEnv?: Record<string, string>;
  metricsUrl?: string;
  metricsToken?: string;
  runtime?: RuntimeConfiguration; // omitted -> legacy Node.js
}

export interface RuntimeLaunchRequest {
  readonly applicationId: string;
  readonly instanceId: string;
  readonly runtime: RuntimeConfiguration;
  readonly releaseRoot?: string;
  readonly entry: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface RuntimeLaunchContext {
  readonly platform: NodeJS.Platform;
  readonly trustedExecutableResolver: TrustedExecutableResolver;
  readonly nodeInstrumentation?: NodeLaunchInstrumentation;
}

export interface RuntimeAdapter {
  readonly type: BuiltinRuntimeType;
  prepareLaunch(
    request: RuntimeLaunchRequest,
    context: RuntimeLaunchContext
  ): Promise<RuntimeLaunchTemplate>;
}

// The adapter selects runtime-specific executable + argv; no process I/O.
export interface RuntimeLaunchTemplate {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly additionalRuntimeEnvironment?: Readonly<Record<string, string>>;
  readonly requestedProcessPolicy?: Readonly<Partial<ProcessLaunchPolicy>>;
}

// Final, trusted plan is assembled/validated by process manager/OS policy.
export interface LaunchPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly processPolicy: Readonly<ProcessLaunchPolicy>;
}

export interface ProcessLaunchPolicy {
  readonly detached: boolean;
  readonly windowsHide: boolean;
  readonly stdio: 'ignore' | 'pipe';
  readonly shell: false; // never user-controlled
}

export interface RuntimeAdapterRegistry {
  resolve(type: BuiltinRuntimeType): RuntimeAdapter;
}

export interface TrustedExecutableResolver {
  resolve(reference: string, runtime: BuiltinRuntimeType): Promise<string>;
}

export interface NodeLaunchInstrumentation {
  nodeArguments(entry: string, args?: string[], applicationId?: string): string[];
  environment(applicationId: string, instanceId: string): Record<string, string>;
}
```

**Contract refinement before implementation:** A dedicated `RuntimeLaunchTemplate` keeps runtime selection separate from environment-policy ownership. The term `LaunchPlan` denotes the *final* sanitized and validated spawn input. Do not pass executable-relevant strings directly from untrusted manifests to `spawn()`. In future, runtime capabilities, identity provider, and graceful-shutdown strategy may require additional trusted policy types; no `any`, `shell: true`, or arbitrary command strings.

### 3.2 Prepare and spawn lifecycle

```mermaid
sequenceDiagram
  participant API as Application Coordinator
  participant PM as ProcessManager
  participant R as RuntimeAdapterRegistry
  participant A as RuntimeAdapter
  participant EP as Environment / Execution Policy
  participant OS as OSProcessController
  participant S as Durable State
  API->>PM: start(applicationId)
  PM->>PM: acquire existing per-process lock; inspect/adopt state
  alt existing PID is verified alive
    PM-->>API: existing ManagedProcessState
  else new launch
    PM->>R: resolve(spec.runtime?.type ?? 'nodejs')
    R-->>PM: adapter
    PM->>A: prepareLaunch(normalized request, trusted context)
    A-->>PM: RuntimeLaunchTemplate
    PM->>EP: resolve env, port and trusted execution policy
    EP-->>PM: validated LaunchPlan
    PM->>OS: spawn(LaunchPlan)
    OS-->>PM: process identity / PID
    PM->>S: atomic persist PID/port/identity
    PM-->>API: ManagedProcessState (not READY)
  end
```

Ordering details: validate app/release + trust first; determine port assignment and construct final env before spawn. For the legacy Node path preserve current allocation/preload timing and `spawn()` options exactly. On errors release claimed port and resources. If spawn succeeded but persistence fails, terminate or safely classify the child to avoid orphaning unmanaged child process; ensure cleanup errors surface.

**Run-time capabilities are NOT health states.** `RUNNING` verifies a process, `ASSIGNED` is a port reservation/probe, `BOUND` is socket listening, `READY` is application readiness, SDK connectedness is separate. Generic GUI and worker apps may have no HTTP endpoint; do not require HTTP binding for successful OS spawn.

### 3.3 Ownership matrix

| Responsibility | Owner | Not responsible for |
|---|---|---|
| Validate manifest schema and package entry | package-manager | Creating process/PID |
| Map validated release + application config to trusted spec | application coordinator (existing interim adapter-process) | OS process syscalls |
| Resolve runtime adapter + per-process lock, port bookkeeping, durable process state | process-manager | Runtime-specific binary syntax |
| Choose executable and argument vector | runtime adapter | spawn/stop/adopt/persist |
| Enforce trusted executable, cwd, env, shell, OS launch policy | OS execution policy / process-manager | Parsing ZIP JSON |
| OS spawn/termination/identity/tree | shared OS process layer | Deployment/rollout decisions |
| Desired state/recovery/readiness | runtime-monitor | PID killing |
| Blue/Green routing and release switching | traffic-router + deployment coordinator | OS process ownership |
| Inject runtime registry and OS backend | supervisor-host | Per-runtime execution business logic |
| Node SDK telemetry/preload | runtime-injection | Electron native or arbitrary binary instrumentation |

Registry is an in-process constructor/composition dependency, not a network service. `process-manager` uses the `RuntimeAdapterRegistry` *interface*; it must not import concrete adapters. Dependencies remain unidirectional and enforced by `check:architecture` once added.

## 4. Manifest versioning and validated release

### 4.1 v1.0 MUST remain byte-semantically compatible

- `schemaVersion: '1.0'` has `runtime.type = 'nodejs'`, `nodeVersion`, `.js` `runtime.entry`, `install.strategy = 'npm-ci'`, `buildRequired: false`, required `arm` and `lifecycle`.
- Preserve its validation restrictions, error behavior where externally relevant, and `InstalledRelease.entry` mapping.
- Missing `ProcessSpec.runtime` means supervisor's `process.execPath` and existing instrumentation, detached process policy, endpoint allocation, and persistence semantics.
- No rewriting of `.deployment.json`, `active.json`, `processes.json`, `blue-green-processes.json` or prior adopted PIDs on read.

### 4.2 v1.1 proposed schema (new, separately validated)

```ts
interface Manifest11Base {
  schemaVersion: '1.1';
  applicationId: string;
  version: string;
  arm: { enabled: boolean; metricsPort?: number };
  lifecycle: {
    autoStart: boolean;
    restartPolicy: 'never' | 'on-failure' | 'always';
    maxRestarts: number;
    stopTimeoutMs: number;
  };
}

type Manifest11 = Manifest11Base & (
  | {
      runtime: { type: 'nodejs'; nodeVersion: string; entry: string; args?: string[] };
      install: { strategy: 'npm-ci'; buildRequired: false };
    }
  | {
      runtime: { type: 'electron'; binaryRef: string; entry: string; args?: string[] };
      install: { strategy: 'prebuilt' };
    }
  | {
      runtime: { type: 'executable'; entry: string; args?: string[] };
      install: { strategy: 'prebuilt' };
    }
);
```

**Interpretation:** For `executable`, `entry` names a release-contained executable; for `electron`, `binaryRef` resolves to a trusted installed Electron runtime and `entry` is a package path. This is an example of constraints, not finalized acceptance of arbitrary v1.1 executables. For v1.1 Node, `nodeVersion` remains validated and node execution must not silently switch to untrusted runtime paths. `arm.enabled = true` for non-Node runtimes should be rejected initially unless a supported explicit SDK integration is established. A policy for Node-capable Electron main process is deferred to R7.5.

**Version dispatcher:** parse `unknown` → inspect `schemaVersion` with a type guard → call `validateManifest10` unchanged or `validateManifest11` strict → produce discriminated validated manifest. Reject unknown versions and invalid runtime/install combinations. Never use a bare `as InstalledRelease` cast for persisted metadata.

**Release loading:** `readRelease()` should validate shape, identity, manifest and trusted entry with a shared release-validation function. A `readRelease()` returning `undefined` only on `ENOENT`; malformed receipts should raise typed validation errors rather than being treated as absent or silently repaired. Keep existing release file format and sha256 semantics. Also validate `alreadyInstalled` receipts at the read boundary.

**Installation:** `npm-ci` stays exactly as current for 1.0. `prebuilt` runs no ZIP-defined scripts; stage and validate binary/file permissions, symlink and path traversal, platform/architecture compatibility, policy and immutable publication. Validation of an archive's `entry` must handle symlink races and release-root containment (not only lexical path checks).

## 5. OS process layer and future lifecycle capabilities

The approved single OS layer is a shared port with platform adapters rather than runtime-specific spawning. Minimal proposed port:

```ts
interface OSProcessController {
  spawn(plan: LaunchPlan): Promise<OSProcessHandle>;
  verify(identity: ProcessIdentity): Promise<'RUNNING' | 'STOPPED' | 'UNKNOWN'>;
  terminate(identity: ProcessIdentity, policy: StopPolicy): Promise<void>;
}

interface OSProcessHandle {
  readonly pid: number;
  readonly identity: ProcessIdentity;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly startMarker?: string;
}

interface StopPolicy {
  readonly gracefulTimeoutMs: number;
  readonly scope: 'main-process' | 'owned-process-group';
}
```

`ProcessIdentity` and `StopPolicy` are **internal proposals**, not a change to current `ManagedProcessState`. The current Linux PID start-time persisted format remains valid. Process group/tree control needs safe scope validation: do not kill an unverified unrelated PID or group; handle reparented children, cross-platform permissions and adopted processes explicitly. Linux process-group signals and Windows Job Objects are *future implementation choices* requiring tests; a Windows Node child `detached` flag is not an adequate process-tree ownership protocol. No process-tree kill is silently added to the legacy Node stop policy.

**Safety:** Never spawn shell commands from manifest; use argument vector, validated cwd, executable allowlist/contained release path; no host path traversal or package-controlled OS flags, preload, privileged env, or cwd escape. Resolve executable trust before spawn and recheck paths/permissions after installation. Operator-owned trusted executables are resolved via a configured registry, not arbitrary manifest absolute paths.

## 6. Compatibility / migration matrix

| Behavior | Existing R1–R6 | R7.1 acceptance policy |
|---|---|---|
| `ProcessController.start` | `ProcessLaunchRequest` without runtime type | Unchanged; maps to legacy Node.js spec |
| `ProcessSpec.runtime` | absent | Optional; absent = Node.js using `process.execPath` |
| Node injection | Node `--import` plus ARM environment | Same behavior and same legacy artifacts |
| `manifest 1.0` | Node-only, npm-ci | Validator remains semantically unchanged |
| `manifest 1.1` | unsupported | New strict version-specific validator; opt-in |
| `.deployment.json` | `InstalledRelease` including `entry` | Existing serialized shape accepted, no rewriting |
| `processes.json` | `id`, `pid`, Linux `startTime`, `startedAt`, optional `port` | Preserved; new metadata optional/versioned later |
| `active.json`, rollout, Blue/Green | existing paths/schema | Unmodified by contract design |
| adopt / restart | Linux identity verification, detached survival | Preserve; do not reprepare running processes |
| dynamic port | assigned, not guaranteed bound | Same Node path; readiness decoupled for new runtimes |
| API/metrics protocol | REST + `arm.metrics.v1` | No breaking changes |

## 7. Failure scenarios and observability

- Unknown `runtime.type`: fail before any port claim/spawn, with typed `UNSUPPORTED_RUNTIME` error.
- Invalid v1.1 manifest or persisted receipt: fail closed with `INVALID_MANIFEST` / `INVALID_RELEASE_METADATA`; do not treat malformed data as a valid Node 1.0 fallback.
- Executable cannot be resolved or violates trust: `EXECUTABLE_NOT_ALLOWED` / `EXECUTABLE_NOT_FOUND`; do not use `shell: true` fallback.
- `prepareLaunch` failure: no PID or persisted state; do not consume restart budget until policy explicitly classifies failure; no leaked port claims.
- Spawn failure: ensure allocated port released; no durable state for process that was not launched.
- Persistence failure after spawn: compensate and report errors; preserve safe state if termination cannot be verified.
- PID exists but identity cannot be verified after restart: status UNKNOWN; refuse duplicate start/stop signals against unsafe PID.
- Runtime not capable of HTTP: no fabricated ready endpoint and no unconditional HTTP port requirement for new runtimes.
- Adapter choice changes after restart: never replace launch of still-running adopted PID; apply new runtime configuration to the next safely allowed spawn only.

Use structured diagnostics with application ID, instance ID, runtime type, failure stage and stable error code; redact secrets and raw application environment in logs. Maintain existing events and wire DTOs.

## 8. Regression and verification plan

**Baseline prerequisite:** fix or explicitly quarantine+document the failing `blue-green-phase7.test.ts` test and diagnose the cancelled/hung CI run; rerun full CI green before claiming end-to-end acceptance. Commit a lockfile/use `npm ci` as a separate R6 hardening change when suitable.

**R7.1 contract tests (when implemented):**
1. Legacy `ProcessSpec` compiles and spawns exactly as before, with and without instrumentation.
2. Existing `ProcessControllerAdapter` remains source-compatible and retains `ASSIGNED` endpoint state.
3. `1.0` Node manifests accepted and old invalid cases rejected unchanged.
4. `1.1` runtime/install discriminated validation rejects mismatches, unknown runtime and unsafe entry/args.
5. Shared registry resolves correct adapter and fails closed for unknown types.
6. LaunchPlan has no PID/status/secret persistence; execution policy rejects host path, symlink escape and shell interpolation.
7. Existing `processes.json` and `.deployment.json` fixtures load without migration; malformed release metadata fails closed.
8. Linux adopted children survive Supervisor restart/close; unverifiable PIDs cannot be signalled.
9. Recovery, activation, Blue/Green, safe rollout, dynamic ports, preload paths and SDK bridge regression suites remain green.
10. Architecture gate forbids process-manager → runtime-adapters and runtime-adapters → process-manager; no cycles.

**Acceptance:** design/ADR review approved, type-level contract definitions agreed, migration/negative test matrix recorded, baseline CI issue resolved. No R7.2 implementation until these gates are agreed; source-level implementation is explicitly outside this document.

## 9. Implementation sequencing after approval (not performed)

- R7.1: merge docs/ADRs first; fix existing CI separately; no behavior change.
- R7.2: introduce contracts/registry, extract Node adapter with behavioral parity, preserve old constructor and injection port, run process adoption/injection/Blue-Green tests.
- R7.3: introduce OSProcessController with parity-first Node process path and identity tests; do NOT change legacy termination scope without opt-in.
- R7.4: v1.1 prebuilt installation and generic executable adapter with trust checks.
- R7.5: Electron adapter with GUI session, process-tree and readiness policy, explicitly staged platform support.
- R7.6: full integration, compatibility fixtures, cross-platform CI, migration documentation.

## 10. Decisions and open architecture issues

**Approved foundation:** prepare-only RuntimeAdapter; optional runtime default Node.js; v1.0 preserved + v1.1; shared OS process layer.

**Recommended refinements to finalize:** (a) RuntimeLaunchTemplate → final LaunchPlan split so env/OS policy remains central, (b) v1.1 exact `arm.enabled` policy for Electron, (c) trusted executable registry naming and permission model, (d) optional persistent identity metadata versioning at R7.3, (e) exact process-tree graceful stop scope, (f) global application operation arbitration as separate hardening effort.
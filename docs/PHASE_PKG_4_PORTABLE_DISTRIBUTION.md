# PKG.4 — Windows x64 Portable Distribution

Baseline: 014615e82dbed817af1706503301e948d08d5698. PKG.3 Windows operation confirmed by project owner.

## Build (developer PC)
Windows x64, official Node 22.x, npm, Windows tar.exe and registry/nodejs.org access.
```powershell
npm ci
npm run package:windows
```
Output: release/portable/arm-supervisor-0.1.0-win-x64.zip and .sha256.
Build invokes PKG.3, downloads matching official Node Windows ZIP, checks its SHA-256 against official HTTPS SHASUMS256.txt (not independent signature verification), copies the SDK resource tree, and verifies the packaged runtime before creating the ZIP. The downloaded distribution includes Node/npm licenses. The ZIP includes ws and its license. No source .env, installed releases, logs, workspace dependencies or test data are copied.

## Run (target PC)
Extract the ZIP into a writable folder. No system Node or npm required. Copy .env.example to .env, set a unique management token (16+ characters), then run .\arm-supervisor.exe. Defaults are relative to executable directory. Injection and bridge are initially disabled; enable via the documented existing configuration. The target still needs network access for applications whose npm dependencies are not already available. Native modules requiring install scripts remain unsupported by existing npm-ci policy.

## Windows helper
```powershell
$env:ARM_MANAGEMENT_TOKEN = 'your-actual-token'
.\scripts\arm.ps1 upload -PackagePath C:\packages\aab-1.0.0.zip
.\scripts\arm.ps1 activate -ApplicationId aab -Version 1.0.0
.\scripts\arm.ps1 start -ApplicationId aab
.\scripts\arm.ps1 inspect -ApplicationId aab
.\scripts\arm.ps1 logs -ApplicationId aab -Stream stderr
```
Also supports list, stop, restart. Logging requires ARM_CHILD_LOGGING=1 before child launch.

## Package validation
Checks bundled node/npm versions, SDK import, offline zero-dependency npm ci, SEA self-check, and Management API authentication/startup with isolated PATH and unrelated CWD. The ZIP is re-extracted and its executable and .env.example checksums are compared; SEA and management startup are repeated from the extracted tree using executable-relative defaults and restricted PATH. These are smoke tests, not complete child deployment, recovery, bridge startup, or Windows process adoption integration tests. PKG.5 will cover lifecycle/injection/recovery on a clean target. Signature and release automation are later work. No process state schema, R7.1 or application API changes. Moving an already populated storage root is not supported; older release records contain absolute paths. Stop Windows children before stopping/replacing supervisor because adoption is limited.

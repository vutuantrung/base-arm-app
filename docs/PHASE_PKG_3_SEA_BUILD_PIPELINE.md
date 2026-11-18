# PKG.3 — SEA Build Pipeline

Baseline: 6428e81eb394ed81798606f873808c58f8c3d582. Target: Windows x64, Node.js 22. User confirmed prior tests passed. This increment builds the management executable only, not the full portable distribution.

## Build
On Windows x64 with the official Node.js 22 distribution:
```powershell
npm ci
npm run build:exe
```
Output: release/sea/arm-supervisor.exe. The build runs TypeScript compilation and copies legacy runtime assets, bundles the dedicated SEA entry with esbuild, creates a preparation blob using the same Node binary that is copied, injects it using pinned postject@1.0.0-alpha.6 (npm exec fetches it on demand), and verifies the executable from an unrelated working directory. Before publishing, a disposable staging .env and storage root are used to launch the actual management daemon and verify HTTP 401 without a token and HTTP 200 with the test token. The smoke process is terminated after the test; this is not a graceful-shutdown or child lifecycle test. No cross-compilation in this increment. The build needs npm registry access on first use of postject. Its transient tool dependencies are not covered by the project lockfile. Esbuild is pinned to the previously locked transitive version. No signing; Windows SmartScreen/security policy may warn or block the output. Do not distribute as a production signed release yet.

## Self-check
```powershell
.\release\sea\arm-supervisor.exe --sea-self-check
```
Expected JSON sea=true, platform=win32, arch=x64, nodeVersion matching the build Node, baseDirectory matching the exe folder. This command alone proves SEA and path resolution, not management lifecycle. The build additionally runs the management smoke test described above.

## Management smoke test
In the executable directory create .env (never commit secrets):
```dotenv
ARM_MANAGEMENT_TOKEN=local-development-token-123456
ARM_NODE_EXECUTABLE=C:/Program Files/nodejs/node.exe
ARM_NPM_CLI=C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js
ARM_MANAGEMENT_PORT=3300
ARM_AUTO_INJECT=0
ARM_CLIENT_BRIDGE_APP_ID=
ARM_BLUE_GREEN_APP_ID=
```
Use actual paths to a separate trusted plain Node installation. Do not point to the Supervisor EXE. From a different PowerShell directory run the EXE by absolute path; in another terminal:
```powershell
curl.exe -H "Authorization: Bearer local-development-token-123456" http://127.0.0.1:3300/applications
```
Expected HTTP 200 and empty list with fresh storage. Stop with Ctrl+C. Use explicit operator-approved test token, not production credentials.

## Boundaries and limitations
The executable bundles Supervisor logic and JS dependencies. Optional ws native accelerators are not required; pure JS fallback is used. Source import.meta.url fallbacks remain in source; bundled fallback uses executable URL, and SEA host supplies explicit external assets as in PKG.2. Injection requires runtime-assets tree assembled in PKG.4. Child Node/npm remain external intentionally. Windows adoption and persistent absolute release paths unchanged. No R7.2 implementation, no application API changes. Build output is ignored by Git. Windows execution and management smoke test require validation on target OS. Official Node 22 SEA instructions: https://nodejs.org/download/release/latest-v22.x/docs/api/single-executable-applications.html.

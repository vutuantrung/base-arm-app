# payment-service 1.0.0 — ARM Supervisor Phase 1 fixture

This tiny service is intentionally **zero-dependency** and uses Node.js built-in HTTP rather than Express. The goal is a real `npm ci --omit=dev --ignore-scripts` installation test without network access or an ARM `.tgz` dependency. `arm.enabled` is therefore `false`. Phase 1 installs but **does not start** the app.

## Artifact

The package ZIP root contains `app.manifest.json`, `package.json`, `package-lock.json` and `dist/main.js`; no enclosing directory. Compatible with the proposed Phase 1 manifest schema.

## Install in ARM Supervisor

Copy `payment-service-1.0.0.zip` to `<arm-supervisor-repository>/supervisor-data/uploads/`, then from the repository root:

```bash
npm install
npm run deploy:zip -- ./supervisor-data/uploads/payment-service-1.0.0.zip
```

The release should appear at `supervisor-data/applications/payment-service/releases/1.0.0/`.

The Supervisor Phase 1 installer does not auto-start an installed process. To test the service manually:

```bash
cd supervisor-data/applications/payment-service/releases/1.0.0
PORT=3201 npm start
```

In another terminal:

```bash
curl http://127.0.0.1:3201/health
curl -X POST http://127.0.0.1:3201/api/payments -H 'Content-Type: application/json' -d '{"amount":125000,"currency":"VND"}'
curl http://127.0.0.1:3201/api/payments
```

## Limitations

Payments are mock objects stored in a process-local Map and disappear after restart. No real money processing, authentication, database or ARM registration is implemented. For an Express + ARM service, compile JS first, include a valid `package-lock.json` and the ARM `.tgz` in `vendor/`, set `arm.enabled` to `true`, and adjust ports/environment before deploying.

# ARM Client Library Branch

This branch focuses exclusively on in-process Node.js ARM: runtime metrics,
`ReliabilityManager`, recovery policies, and HTTP/WebSocket metrics reporting.

No detached Supervisor, process management, remote application registry or
self-registration implementation is included.

## Build locally and install into an application

```bash
npm install
npm run pack:client
cd packages/library
npm pack
```

This creates `base-arm-app-0.1.0.tgz`. Copy it into the consumer project,
then:

```bash
npm install ./vendor/base-arm-app-0.1.0.tgz
```

Usage:

```ts
import { MetricsRegistry, NodeMetricsCollector, ReliabilityManager, MetricsServer }
  from 'base-arm-app';

const registry = new MetricsRegistry();
const collector = new NodeMetricsCollector(registry, 2000);
const arm = new ReliabilityManager(registry);
collector.start();
await arm.start();
const server = new MetricsServer(registry, { port: 3100 }, arm);
await server.start();
```

The ARM library executes inside the application's Node.js process.
It does not require the Supervisor branch. No npm publish is performed.

## Test

```bash
npm run build
npm test
```

The build creates JavaScript and TypeScript declarations. The pack script
constructs a standalone library distribution folder from the compiled
`dist/packages` hierarchy, retaining the original relative module paths.

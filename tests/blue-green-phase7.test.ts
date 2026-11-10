import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { BlueGreenHttpProxy } from '../packages/adapter-process/src/blue-green-http-proxy.js';
import { BlueGreenDeploymentManager } from '../packages/adapter-process/src/blue-green-deployment-manager.js';
import type { InstalledRelease } from '../packages/adapter-process/src/deployment/deployment-types.js';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('Phase 7 proxy retains slow in-flight requests during immediate backend switch', async () => {
  const [publicPort, bluePort, greenPort] = await Promise.all([unusedPort(), unusedPort(), unusedPort()]);
  const blue = createServer((_req, res) => {
    setTimeout(() => res.end('blue'), 180);
  });
  const green = createServer((_req, res) => res.end('green'));
  await Promise.all([
    new Promise<void>(resolve => blue.listen(bluePort, '127.0.0.1', resolve)),
    new Promise<void>(resolve => green.listen(greenPort, '127.0.0.1', resolve)),
  ]);
  const proxy = new BlueGreenHttpProxy(publicPort);
  try {
    await proxy.listen();
    proxy.switchTo({ slot: 'blue', port: bluePort });
    const ongoing = fetch(`http://127.0.0.1:${publicPort}/work`).then(r => r.text());
    const deadline = Date.now() + 3000;
    while (proxy.requestsInFlight('blue') < 1 && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(proxy.requestsInFlight('blue'), 1);
    proxy.switchTo({ slot: 'green', port: greenPort });
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/work`)).text(), 'green');
    assert.equal(await proxy.drain('blue', 10), false);
    assert.equal(await ongoing, 'blue');
    assert.equal(await proxy.drain('blue', 500), true);
  } finally {
    await proxy.close();
    await Promise.all([
      new Promise<void>(resolve => blue.close(() => resolve())),
      new Promise<void>(resolve => green.close(() => resolve())),
    ]);
  }
});

test('Phase 7 deploys installed releases to distinct slots and retains routing after restart', async t => {
  if (process.platform !== 'linux') {
    t.skip('PID adoption integration requires Linux');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'arm-bg-phase7-'));
  const [publicPort, bluePort, greenPort] = await Promise.all([unusedPort(), unusedPort(), unusedPort()]);
  const options = {
    storageRoot: root, applicationId: 'payment-service',
    proxyPort: publicPort, bluePort, greenPort,
    healthTimeoutMs: 4000, drainTimeoutMs: 2000,
  };
  async function release(version: string) {
    const directory = join(root, 'applications', 'payment-service', 'releases', version);
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'main.mjs');
    await writeFile(entry, `import http from 'node:http';
const server = http.createServer((req,res)=>{
  if(req.url==='/health') {res.writeHead(200);res.end('ok');return;}
  res.writeHead(200);res.end('${version}');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
    const metadata = {
      applicationId: 'payment-service', version, directory, entry,
      sha256: 'test', installedAt: new Date().toISOString(),
      manifest: { lifecycle: { stopTimeoutMs: 3000 } },
    } as InstalledRelease;
    await writeFile(join(directory, '.deployment.json'), JSON.stringify(metadata));
  }
  let current: BlueGreenDeploymentManager | undefined;
  try {
    await release('1.0.0');
    await release('1.1.0');
    current = new BlueGreenDeploymentManager(options);
    await current.initialize();
    const first = await current.deploy('1.0.0');
    assert.equal(first.active, 'blue');
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text(), '1.0.0');
    const second = await current.deploy('1.1.0');
    assert.equal(second.active, 'green');
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text(), '1.1.0');
    await current.close();
    current = new BlueGreenDeploymentManager(options);
    await current.initialize();
    assert.equal(current.inspect().state.active, 'green');
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text(), '1.1.0');
    const reverted = await current.deploy('1.0.0');
    assert.equal(reverted.active, 'blue');
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text(), '1.0.0');
  } finally {
    if (current) {
      for (const slot of ['blue', 'green']) {
        try { await current.processes.stop(`payment-service-${slot}`, 3000); } catch {}
      }
      await current.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

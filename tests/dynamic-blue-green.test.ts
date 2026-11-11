import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { BlueGreenDeploymentManager } from '../packages/adapter-process/src/blue-green-deployment-manager.js';
import type { InstalledRelease } from '../packages/adapter-process/src/deployment/deployment-types.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('Blue/Green deploys to OS-selected distinct ports without fixed slot configuration', async t => {
  if (process.platform !== 'linux') {
    t.skip('Linux required for verified PID re-adoption');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'arm-dynamic-bg-'));
  const publicPort = await freePort();
  const opts = {
    storageRoot: root, applicationId: 'payment-service',
    proxyPort: publicPort, healthTimeoutMs: 5000, drainTimeoutMs: 3000,
  };
  for (const version of ['1.0.0', '1.1.0']) {
    const dir = join(root, 'applications', 'payment-service', 'releases', version);
    await mkdir(dir, { recursive: true });
    const entry = join(dir, 'app.mjs');
    await writeFile(entry, `import http from 'node:http';
const server=http.createServer((req,res)=>res.end(req.url==='/health'?'ok':'${version}'));
server.listen(Number(process.env.PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
    const release = {
      applicationId: 'payment-service', version, directory: dir, entry,
      sha256: 'test', installedAt: new Date().toISOString(),
      manifest: { arm: { enabled: false }, lifecycle: { stopTimeoutMs: 3000 } },
    } as InstalledRelease;
    await writeFile(join(dir, '.deployment.json'), JSON.stringify(release));
  }
  let bg: BlueGreenDeploymentManager | undefined;
  try {
    bg = new BlueGreenDeploymentManager(opts);
    await bg.initialize();
    const first = await bg.deploy('1.0.0');
    assert.ok(first.blue?.port);
    assert.notEqual(first.blue?.port, publicPort);
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text(), '1.0.0');
    const second = await bg.deploy('1.1.0');
    assert.ok(second.green?.port);
    assert.notEqual(second.green?.port, first.blue?.port);
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text(), '1.1.0');

    await bg.close();
    bg = new BlueGreenDeploymentManager(opts);
    await bg.initialize();
    assert.equal(bg.inspect().state.green?.port, second.green?.port);
    assert.equal(bg.inspect().green?.port, second.green?.port);
    assert.equal(await (await fetch(`http://127.0.0.1:${publicPort}/`)).text(), '1.1.0');
  } finally {
    if (bg) {
      for (const slot of ['blue', 'green']) {
        try { await bg.processes.stop(`payment-service-${slot}`, 3000); } catch {}
      }
      await bg.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

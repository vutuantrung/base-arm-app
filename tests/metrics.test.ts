import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket from 'ws';
import {MetricsRegistry, NodeMetricsCollector} from '../packages/core/src/metrics.js';
import {MetricsServer} from '../packages/adapter-http/src/server.js';

test('registry supports gauge, monotonic counter, filtering and validation',()=>{
  const r=new MetricsRegistry(2);
  r.gauge('cpu.percent', 10, 'percent');
  r.increment('requests.total'); r.increment('requests.total',2);
  assert.equal(r.get('requests.total')?.value,3);
  assert.deepEqual(r.snapshot(['cpu.percent']).metrics.map(m=>m.name),['cpu.percent']);
  assert.throws(()=>r.gauge('bad name',3));
  assert.throws(()=>r.increment('requests.total',-1));
  assert.throws(()=>r.gauge('overflow',3));
});

test('collector lifecycle is idempotent and produces system metrics',()=>{
  const r=new MetricsRegistry();const c=new NodeMetricsCollector(r,1000);
  c.start(); c.start();assert.ok(r.get('process.memory.rss_bytes'));c.stop();c.stop();
});

test('HTTP snapshot, filtered websocket subscription and auth', async()=>{
  const r=new MetricsRegistry();r.gauge('app.foo',42);r.gauge('app.bar',7);
  const server=new MetricsServer(r,{port:0,authToken:'secret',broadcastIntervalMs:1000});
  await server.start();
  const address=server.http.address();assert.ok(address && typeof address !=='string');
  const port=address.port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/metrics`)).status,401);
    const response=await fetch(`http://127.0.0.1:${port}/metrics`,{headers:{authorization:'Bearer secret'}});
    assert.equal(response.status,200);
    const snapshot = await response.json() as { metrics: unknown[] };
    assert.equal(snapshot.metrics.length,2);
    const ws=new WebSocket(`ws://127.0.0.1:${port}/metrics/ws`,{headers:{authorization:'Bearer secret'}});
    await once(ws,'open');
    const messages: any[] = [];
    ws.on('message', buf => messages.push(JSON.parse(buf.toString())));
    const next=async(type: string)=>{const deadline=Date.now()+2500; while(Date.now()<deadline){const i=messages.findIndex(m=>m.type===type); if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,10));}throw new Error('timeout waiting for '+type);};
    ws.send(JSON.stringify({action:'subscribe',names:['app.foo']}));
    const snap=await next('snapshot');assert.equal(snap.type,'snapshot');assert.deepEqual(snap.data.metrics.map((m:any)=>m.name),['app.foo']);
    const update=await next('metrics');assert.equal(update.type,'metrics');assert.deepEqual(update.data.metrics.map((m:any)=>m.name),['app.foo']);
    ws.close();
  } finally {await server.stop();}
});

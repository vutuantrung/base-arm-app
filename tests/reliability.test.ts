import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket from 'ws';
import {MetricsRegistry} from '../packages/core/src/metrics.js';
import {ReliabilityManager, type ManagedComponent} from '../packages/core/src/reliability.js';
import {MetricsServer} from '../packages/adapter-http/src/server.js';
const policy={enabled:true,maxAttempts:3,baseDelayMs:1,maxDelayMs:5,timeoutMs:500};

test('health, recovery metrics and readiness',async()=>{
  const m=new MetricsRegistry();const arm=new ReliabilityManager(m,{checkIntervalMs:10000});
  let healthy=true;let attempts=0;
  const c:ManagedComponent={id:'worker',async start(){},async stop(){},async checkHealth(){return {status:healthy?'HEALTHY':'UNHEALTHY',checkedAt:new Date().toISOString()};},async recover(){attempts++;healthy=true;}};
  arm.register({component:c,critical:true,recovery:policy});
  await arm.start();
  assert.equal(arm.readiness().ready,true);
  healthy=false;await arm.checkAll();
  // checkAll schedules recovery asynchronously
  await arm.recover('worker');
  assert.equal(attempts,1);
  assert.equal(arm.readiness().ready,true);
  assert.equal(m.get('arm.recovery.success_total')?.value,1);
  assert.ok(arm.recentEvents().some(e=>e.type==='recovery.succeeded'));
  await arm.stop();
  assert.equal(arm.readiness().ready,false);
});

test('API component snapshot and WS event stream',async()=>{
  const m=new MetricsRegistry();const arm=new ReliabilityManager(m,{checkIntervalMs:10000});
  let ok=true;
  arm.register({component:{id:'db',async start(){},async stop(){},async checkHealth(){return {status:ok?'HEALTHY':'UNHEALTHY',checkedAt:new Date().toISOString()};},async recover(){ok=true;}},critical:true,recovery:policy});
  await arm.start();
  const server=new MetricsServer(m,{port:0},arm);
  await server.start();
  const addr=server.http.address();assert.ok(addr && typeof addr!=='string');
  const url=`http://127.0.0.1:${addr.port}`;
  const ws=new WebSocket(`ws://127.0.0.1:${addr.port}/metrics/ws`);
  try {
    assert.equal((await (await fetch(url+'/reliability/components')).json())[0].id,'db');
    assert.equal((await fetch(url+'/reliability/ready')).status,200);
    await once(ws,'open');
    const messages:any[]=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({action:'subscribe_events'}));
    await new Promise(r=>setTimeout(r,25));
    ok=false;await arm.checkAll();await arm.recover('db');
    await new Promise(r=>setTimeout(r,25));
    assert.ok(messages.some(x=>x.type==='reliability_event' && x.data.type==='recovery.succeeded'));
    assert.ok((await (await fetch(url+'/reliability/events')).json()).events.length>0);
  }finally{ws.terminate();await arm.stop();await server.stop();}
});

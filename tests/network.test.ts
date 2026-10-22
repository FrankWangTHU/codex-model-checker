import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket,WebSocketServer} from 'ws';
import {ModelProxy} from '../src/main/proxy';
import {Bridge,BRIDGE_PORT} from '../src/main/bridge';
import {assess} from '../src/core/assessment';
import {entry} from './helpers';
import type {Observation} from '../src/core/types';
const listen=async(server:http.Server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address()as import('node:net').AddressInfo).port;};
const stop=(server:http.Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const portOf=(proxy:ModelProxy)=>(proxy.server.address()as import('node:net').AddressInfo).port;
test('HTTP proxy preserves bytes, status and headers; concurrent attempts stay isolated',async()=>{
  const requests:string[]=[];
  const upstream=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;requests.push(text);
    const body=JSON.parse(text);const response=JSON.stringify({type:'response.completed',response:{id:body.id,model:body.model==='gpt-6-astra'?'gpt-6-luna':body.model}});
    res.writeHead(200,{'content-type':'text/event-stream','x-test':'preserved'});res.write('data: '+response.slice(0,25));setTimeout(()=>res.end(response.slice(25)+'\n\n'),15);
  });
  const upstreamPort=await listen(upstream),observations:Observation[]=[];
  const proxy=new ModelProxy(`http://127.0.0.1:${upstreamPort}/v1`,'test-token',value=>observations.push(structuredClone(value)),()=>{},true);await proxy.start(0);
  try{
    const bodies=['{"model":"gpt-6-astra","id":"a","input":"secret text"}','{"model":"gpt-6.1-sol","id":"b"}'];
    const responses=await Promise.all(bodies.map(body=>fetch(`http://127.0.0.1:${portOf(proxy)}/test-token/v1/responses`,{method:'POST',body,headers:{'content-type':'application/json'}})));
    for(const response of responses){assert.equal(response.status,200);assert.equal(response.headers.get('x-test'),'preserved');assert.match(await response.text(),/^data: /);}
    assert.deepEqual(requests.sort(),bodies.sort());const completed=observations.filter(o=>o.state==='complete');assert.equal(new Set(completed.map(o=>o.id)).size,2);assert.ok(completed.some(o=>assess(o).astraAlert));assert.ok(completed.some(o=>assess(o).verdict==='match'));assert.ok(!JSON.stringify(observations).includes('secret text'));
    assert.equal((await fetch(`http://127.0.0.1:${portOf(proxy)}/wrong/v1/responses`)).status,403);
    assert.equal((await fetch(`http://127.0.0.1:${portOf(proxy)}/test-token/v1/responses`,{headers:{Origin:'https://evil.test'}})).status,403);
  }finally{await proxy.stop();await stop(upstream);}
});
test('upstream failure returns 502 and records an error, not a matching response',async()=>{
  const upstream=http.createServer();const upstreamPort=await listen(upstream);await stop(upstream);const observations:Observation[]=[];
  const proxy=new ModelProxy(`http://127.0.0.1:${upstreamPort}/v1`,'token',o=>observations.push(structuredClone(o)),()=>{},true);await proxy.start(0);
  try{const response=await fetch(`http://127.0.0.1:${portOf(proxy)}/token/v1/responses`,{method:'POST',body:'{"model":"gpt-6-astra"}'});assert.equal(response.status,502);await response.text();assert.ok(observations.some(o=>o.state==='error'));assert.ok(observations.every(o=>assess(o).verdict==='unknown'));}finally{await proxy.stop();}
});
test('downstream abort cancels the upstream stream',async()=>{
  let resolveClosed:()=>void=()=>{};const closed=new Promise<void>(resolve=>resolveClosed=resolve);
  const upstream=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(':keepalive\n\n');const timer=setInterval(()=>res.write(':ping\n\n'),20);res.on('close',()=>{clearInterval(timer);resolveClosed();});});
  const upstreamPort=await listen(upstream),observations:Observation[]=[];const proxy=new ModelProxy(`http://127.0.0.1:${upstreamPort}/v1`,'token',o=>observations.push(structuredClone(o)),()=>{},true);await proxy.start(0);
  try{const controller=new AbortController();const response=await fetch(`http://127.0.0.1:${portOf(proxy)}/token/v1/responses`,{signal:controller.signal});await response.body?.getReader().read();controller.abort();await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream not cancelled')),1500))]);assert.ok(observations.some(o=>o.state==='cancelled'));}finally{await proxy.stop();await stop(upstream);}
});
test('WebSocket proxy forwards original messages and associates interleaved response IDs',async()=>{
  const upstream=http.createServer();const wss=new WebSocketServer({server:upstream});
  const received:string[]=[];
  wss.on('connection',socket=>socket.on('message',data=>{
    received.push(data.toString());const input=JSON.parse(data.toString());
    socket.send(JSON.stringify({type:'response.created',response:{id:input.event_id,model:input.model}}));
    if(received.length===2){socket.send(JSON.stringify({type:'response.completed',response:{id:'b',model:'gpt-6.1-sol'}}));socket.send(JSON.stringify({type:'response.completed',response:{id:'a',model:'gpt-6-luna'}}));}
  }));
  const upstreamPort=await listen(upstream),observations:Observation[]=[];const proxy=new ModelProxy(`http://127.0.0.1:${upstreamPort}/v1`,'token',o=>observations.push(structuredClone(o)),()=>{},true);await proxy.start(0);
  const client=new WebSocket(`ws://127.0.0.1:${portOf(proxy)}/token/v1/responses`);const messages:string[]=[];client.on('message',data=>messages.push(data.toString()));
  try{
    await once(client,'open');const a=JSON.stringify({type:'response.create',model:'gpt-6-astra',event_id:'a'}),b=JSON.stringify({type:'response.create',model:'gpt-6.1-sol',event_id:'b'});client.send(a);client.send(b);
    const start=Date.now();while(messages.length<4&&Date.now()-start<2000)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(messages.length,4);assert.deepEqual(received,[a,b]);const completed=observations.filter(o=>o.state==='complete');assert.ok(completed.some(o=>o.requested==='gpt-6.1-sol'&&assess(o).verdict==='match'));assert.ok(completed.some(o=>o.requested==='gpt-6-astra'&&assess(o).verdict==='conflict'));
  }finally{client.terminate();await proxy.stop();for(const c of wss.clients)c.terminate();wss.close();await stop(upstream);}
});
test('bridge pairing is single-use, token/origin scoped, and strips non-metadata',async()=>{
  const observations:Observation[]=[];const dir=mkdtempSync(join(tmpdir(),'cmc-bridge-'));const bridge=new Bridge(dir,o=>observations.push(o),()=>{},()=>{});await bridge.start(0);bridge.renew();const bridgePort=(bridge.server.address() as import('node:net').AddressInfo).port;
  const origin='chrome-extension://'+'a'.repeat(32);
  const post=(path:string,data:unknown,token?:string,originValue=origin)=>fetch(`http://127.0.0.1:${bridgePort}${path}`,{method:'POST',headers:{Origin:originValue,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
  try{
    assert.equal((await post('/pair',{code:bridge.pairing.code},undefined,'https://evil.test')).status,403);
    const code=bridge.pairing.code,paired=await post('/pair',{code});assert.equal(paired.status,200);const {token}=await paired.json()as {token:string};
    assert.equal((await post('/pair',{code})).status,403);assert.equal((await post('/events',entry())).status,401);
    assert.equal((await post('/events',{...entry(),prompt:'secret'},token)).status,204);assert.equal(observations.length,1);assert.ok(!JSON.stringify(observations).includes('secret'));assert.equal(observations[0].source,'chatgpt');
    assert.equal((await post('/events',entry(),token,'chrome-extension://'+'b'.repeat(32))).status,401);
  }finally{await bridge.stop();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DesktopEvidence,DesktopTraceWatcher,StderrDecoder} from '../src/main/desktop-trace';
import {SessionWatcher} from '../src/main/logs';
import {assess} from '../src/core/assessment';
import {sanitizeObservation} from '../src/core/capture';
import type {Observation} from '../src/core/types';

const context={threadId:'thread-one',turnId:'turn-one',requested:'gpt-6-astra'};
const event=(id:string,msg:string,model:string|undefined='gpt-6-astra',type='response.completed')=>({fields:{message:'Received message '+JSON.stringify({type,response:{id,model,status:'completed',output:msg?[{id:msg,type:'message',role:'assistant',content:[{text:'PRIVATE BODY'}]}]:[]}})}});

test('desktop exact IDs handle parallel turns, retries, aliases, missing models and tool tasks',()=>{
  const rows:Observation[]=[];const e=new DesktopEvidence(o=>rows.push(o));
  e.event(event('r1','m1'),Date.now());assert.equal(rows.length,0);
  e.associate('unrelated',context);assert.equal(rows.length,0);
  e.associate('m1',context);assert.equal(assess(rows.at(-1)!).verdict,'match');
  e.associate('m2',{...context,turnId:'turn-two'});e.event(event('r2','m2','gpt-6-luna'),Date.now());assert.equal(assess(rows.at(-1)!).astraAlert,true);
  e.event(event('retry','m2'),Date.now());assert.notEqual(rows.at(-1)!.id,rows.at(-2)!.id);
  e.associate('alias',{...context,requested:'GPT-6 Astra'});e.event(event('alias','alias'),Date.now());assert.equal(assess(rows.at(-1)!).verdict,'match');
  e.associate('missing',context);const missing=event('missing','missing');delete (missing.fields as any).message;missing.fields.message='SSE event: '+JSON.stringify({type:'response.completed',response:{id:'missing',status:'completed',output:[{id:'missing',type:'message',role:'assistant'}]}});e.event(missing,Date.now());assert.equal(assess(rows.at(-1)!).verdict,'unknown');
  e.associate('tool',{...context,requested:'codex-auto-review'});e.event(event('tool','tool','codex-auto-review'),Date.now());assert.equal(rows.at(-1)!.special,true);
  assert.ok(!JSON.stringify(rows).includes('PRIVATE BODY'));
});

test('conflicting model fields and fork message mappings cannot be promoted to matches',()=>{
  const rows:Observation[]=[];const e=new DesktopEvidence(o=>rows.push(o));e.associate('m',context);
  e.event(event('r','m','gpt-6-luna','response.created'),Date.now());e.event(event('r','m'),Date.now());assert.equal(assess(rows.at(-1)!).verdict,'conflict');
  e.event(event('fork','m'),Date.now());e.associate('m',{...context,threadId:'fork-thread'});assert.equal(assess(rows.at(-1)!).verdict,'conflict');
  const clean=sanitizeObservation(JSON.parse(JSON.stringify(rows.at(-1))),'codex')!;assert.equal(assess(clean).verdict,'conflict');assert.equal(clean.desktop?.association,'conflict');
});

test('mutable session contexts are snapshotted; failed, cancelled and empty warmup responses excluded',()=>{
  const rows:Observation[]=[];const e=new DesktopEvidence(o=>rows.push(o));const c={...context};e.associate('m',c);c.turnId='next-turn';e.event(event('r','m'),Date.now());assert.equal(rows[0].desktop?.turnId,'turn-one');
  const count=rows.length;e.event(event('warmup',''),Date.now());e.event(event('failure','m','gpt-6-luna','response.failed'),Date.now());e.event(event('cancel','m','gpt-6-luna','response.incomplete'),Date.now());assert.equal(rows.length,count);
});

test('JSON decoder handles arbitrarily split and concatenated diagnostic records',()=>{
  const rows:unknown[]=[];const decoder=new StderrDecoder(v=>rows.push(v));const raw=JSON.stringify(event('r','m'))+JSON.stringify(event('r2','m2'));
  for(let i=0;i<raw.length;i+=7)decoder.push(raw.slice(i,i+7),Date.now());assert.equal(rows.length,2);
});

test('passive file integration handles append, truncation and log rotation without writing Codex files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cmc-desktop-'));const logs=join(root,'logs'),sessions=join(root,'sessions');const d=new Date(),suffix=join(String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));
  await mkdir(join(logs,suffix),{recursive:true});await mkdir(join(sessions,suffix),{recursive:true});
  const rows:Observation[]=[];const w=new DesktopTraceWatcher([logs],o=>rows.push(o),()=>{});const s=new SessionWatcher(sessions,()=>{},()=>{},(id,c)=>w.evidence.associate(id,c));
  const sessionFile=join(sessions,suffix,'rollout.jsonl');await writeFile(sessionFile,[{type:'session_meta',payload:{id:'thread-one'}},{type:'turn_context',payload:{turn_id:'turn-one',model:'gpt-6-astra'}},{type:'response_item',payload:{id:'m',role:'assistant',content:'PRIVATE BODY'}}].map(x=>JSON.stringify(x)).join('\n')+'\n');await s['scan']();
  const line=(id:string)=>new Date().toISOString()+' debug [AppServerConnection] Codex CLI stderr message='+JSON.stringify(JSON.stringify(event(id,'m')))+'\n';
  const file=join(logs,suffix,'codex-desktop-test.log'),raw=line('initial-response');await writeFile(file,raw.slice(0,40));await w.scan();assert.equal(rows.length,0);await appendFile(file,raw.slice(40));await w.scan();assert.equal(rows.length,1);await w.scan();assert.equal(rows.length,1);
  await writeFile(file,line('x'));await w.scan();assert.equal(rows.length,2);await writeFile(join(logs,suffix,'codex-desktop-rotation.log'),line('rotated'));await w.scan();assert.equal(rows.length,3);assert.ok(!JSON.stringify(rows).includes('PRIVATE BODY'));s.stop();w.stop();
});

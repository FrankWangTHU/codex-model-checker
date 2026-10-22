import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProbeParser} from '../src/main/probe';
import {diagnosticEntry} from '../src/main/diagnostics';
import {fitBounds,latestPrimary} from '../src/core/presentation';
import {assess} from '../src/core/assessment';
import {entry} from './helpers';

test('probe excludes warmup and correlates created/completed evidence without retaining text',()=>{
  const p=new ProbeParser();
  const emit=(type:string,id:string,model:string,output:unknown[]=[])=>`TRACE tungstenite::protocol: Received message ${JSON.stringify({type,response:{id,model,status:'completed',output}})}\n`;
  const raw=emit('response.completed','warmup','gpt-6-luna')+emit('response.created','real','gpt-6-astra')+emit('response.completed','real','gpt-6-astra',[{type:'message',role:'assistant',content:[{type:'output_text',text:'private response'}]}]);
  for(let i=0;i<raw.length;i+=13)p.push(Buffer.from(raw.slice(i,i+13)));p.finish();
  const rows=p.result('gpt-6-astra','probe-test',true);assert.equal(rows.length,1);assert.equal(rows[0].id,'real');assert.equal(assess(rows[0]).verdict,'match');assert.ok(!JSON.stringify(rows).includes('private response'));assert.deepEqual(p.result('gpt-6-astra','x',false),[]);
});
test('probe ignores outgoing messages and incomplete events',()=>{
  const p=new ProbeParser();p.push(Buffer.from('Sending message {"type":"response.completed","response":{"model":"gpt-6-astra"}}\n'));p.finish();assert.deepEqual(p.result('gpt-6-astra','x',true),[]);
});
test('official diagnostic markers prove their own pair; arbitrary model spans do not',()=>{
  const row={id:12,ts:1792610000,target:'codex_core::session',thread_id:'thread-1',feedback_log_body:'session{model=gpt-6-astra}: server reported model gpt-6-luna while requested model was gpt-6-astra'};
  assert.equal(assess(diagnosticEntry(row)!).verdict,'mismatch');
  assert.equal(diagnosticEntry({...row,feedback_log_body:'model=gpt-6-astra'}),null);
  assert.equal(diagnosticEntry({...row,target:'tool.output'}),null);
  assert.equal(assess(diagnosticEntry({...row,feedback_log_body:'server reported model gpt-6-astra (matches requested model)'})!).verdict,'match');
});
test('primary card excludes probes and auto-review; expanded window stays on screen',()=>{
  const primary=entry({id:'primary'});assert.equal(latestPrimary([entry({requested:'codex-auto-review'}),entry({transport:'probe'}),primary],'codex')?.id,'primary');
  assert.deepEqual(fitBounds({x:1500,y:700},{x:0,y:0,width:1920,height:1080},760,650),{x:1160,y:430,width:760,height:650});
  assert.deepEqual(fitBounds({x:-900,y:500},{x:-1280,y:0,width:1280,height:720},760,650),{x:-900,y:70,width:760,height:650});
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assess} from '../src/core/assessment';
import {evidence,mergeEvidence,requestModel,sanitizeObservation,StreamObserver} from '../src/core/capture';
import {entry} from './helpers';
test('model comparison, labels, aliases, unknowns, conflicts and auto routes',()=>{
  const route=(model:string)=>({field:'response.model',model,kind:'route' as const});
  assert.equal(assess(entry({candidates:[route('gpt-6-astra')]})).verdict,'match');
  assert.equal(assess(entry({requested:'GPT-6 Astra',candidates:[route('gpt-6-astra')]})).verdict,'match');
  const swapped=assess(entry({candidates:[route('gpt-6.1-sol')]}));assert.equal(swapped.verdict,'mismatch');assert.equal(swapped.astraAlert,true);
  assert.equal(assess(entry()).verdict,'unknown');
  assert.equal(assess(entry({candidates:[{field:'assistant.metadata.model_slug',model:'gpt-6-astra',kind:'label'}]})).verdict,'unknown');
  assert.equal(assess(entry({requestEvidence:'session',candidates:[route('gpt-6-astra')]})).verdict,'unknown');
  assert.equal(assess(entry({candidates:[route('gpt-6-astra'),route('gpt-6-luna')]})).verdict,'conflict');
  assert.equal(assess(entry({requested:'auto',candidates:[route('gpt-6-astra')]})).verdict,'auto');
  assert.equal(assess(entry({special:true,candidates:[route('image-model')]})).verdict,'unknown');
  assert.equal(assess(entry({candidates:[route('gpt-6-astra-internal-unknown')]})).verdict,'mismatch');
});
test('SSE handles every byte boundary, CRLF, UTF-8 and incomplete final blocks',()=>{
  const raw=Buffer.from('event: message\r\ndata: {"type":"response.completed","response":{"model":"gpt-6-astra","id":"r1"},"note":"中文"}\r\n\r\ndata: [DONE]\r\n\r\n');
  for(let split=0;split<raw.length;split++){
    const values:unknown[]=[];const observer=new StreamObserver(value=>values.push(value));observer.push(raw.subarray(0,split));observer.push(raw.subarray(split));observer.finish();
    assert.equal(values.length,1);assert.equal(evidence(values[0]).candidates[0].model,'gpt-6-astra');
  }
  const values:unknown[]=[];const parser=new StreamObserver(v=>values.push(v));parser.push('data: {"object":"response","model":"gpt-6-astra"}');parser.finish();assert.equal(values.length,1);
});
test('metadata is extracted without interpreting assistant text or tool arguments',()=>{
  assert.deepEqual(evidence({content:{model:'gpt-6-luna'},arguments:{type:'server_ste_metadata',metadata:{model_slug:'fake'}}}).candidates,[]);
  const response=evidence({type:'server_ste_metadata',metadata:{model_slug:'gpt-6-astra'}});assert.equal(response.candidates[0].kind,'route');
  assert.equal(evidence({message:{author:{role:'tool'},metadata:{model_slug:'tool-model'}}}).candidates.length,0);
  const record=entry();mergeEvidence(record,{type:'response.created',response:{model:'gpt-6-astra'}});mergeEvidence(record,{type:'response.completed',response:{model:'gpt-6-astra'}});assert.equal(record.candidates.length,1);assert.equal(record.state,'complete');
});
test('oversized malformed streams stop observing without throwing',()=>{
  let count=0;const parser=new StreamObserver(()=>count++,'json',32);parser.push('x'.repeat(33));parser.finish();assert.equal(count,0);
});
test('trust boundary strips private fields and validates all model candidates',()=>{
  const safe=sanitizeObservation({...entry(),prompt:'secret',cookie:'secret',candidates:[{field:'response.model',model:'gpt-6-astra',kind:'label',secret:'no'},{field:'text',model:'secret prompt',kind:'route'}]},'chatgpt');
  assert.ok(safe);assert.equal(safe.source,'chatgpt');assert.equal(safe.candidates.length,1);assert.equal(safe.candidates[0].kind,'route');assert.ok(!JSON.stringify(safe).includes('secret'));assert.equal(sanitizeObservation({...entry(),id:'https://bad/'},'codex'),null);
  assert.equal(requestModel({response:{model:'gpt-6-astra'}}),'gpt-6-astra');
});

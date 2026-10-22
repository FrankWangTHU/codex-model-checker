import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionWatcher} from '../src/main/logs';
import type {Observation} from '../src/core/types';
test('session tail handles partial lines, incremental append and truncation without collecting content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cmc-logs-')),now=new Date();const directory=join(root,String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));await mkdir(directory,{recursive:true});
  const file=join(directory,'rollout.jsonl'),observations:Observation[]=[];
  const watcher=new SessionWatcher(root,o=>observations.push(o),()=>{});
  const line=(id:string)=>JSON.stringify({type:'turn_context',timestamp:new Date().toISOString(),payload:{turn_id:id,model:'gpt-6-astra',prompt:'private content'}})+'\n';
  const first=line('first');await writeFile(file,first.slice(0,60));await watcher['scan']();assert.equal(observations.length,0);
  await appendFile(file,first.slice(60));await watcher['scan']();assert.equal(observations.length,1);assert.equal(observations[0].requestEvidence,'session');
  await watcher['scan']();assert.equal(observations.length,1);await appendFile(file,line('second'));await watcher['scan']();assert.equal(observations.length,2);
  await writeFile(file,line('third'));await watcher['scan']();assert.equal(observations.length,3);assert.ok(!JSON.stringify(observations).includes('private content'));watcher.stop();
});

// Read-only experimental desktop observer. Never starts or intercepts a model request.
import {existsSync,readdirSync,readFileSync,statSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';

const root=resolve('test-results','appserver-trace');mkdirSync(root,{recursive:true});
const sessionFile=process.argv.find(a=>a.startsWith('--session='))?.slice(10)||join(root,'desktop-session.json');
if(!existsSync(sessionFile))throw new Error('请先通过 start-desktop-diagnostic.ps1 启动一次诊断模式。');
const session=JSON.parse(readFileSync(sessionFile,'utf8').replace(/^\uFEFF/,''));
const since=Date.parse(session.startedAt);if(!Number.isFinite(since))throw new Error('Invalid diagnostic session time.');
const responses=new Map(),messages=new Map();let skippedLargeFiles=0,malformedChunks=0;
const safe=v=>typeof v==='string'&&/^[\w .:/-]{1,200}$/.test(v);
function files(directory,suffix,depth=0){if(depth>5||!existsSync(directory))return [];const found=[];for(const item of readdirSync(directory,{withFileTypes:true})){const p=join(directory,item.name);if(item.isDirectory())found.push(...files(p,suffix,depth+1));else if(item.isFile()&&item.name.endsWith(suffix))found.push(p);}return found;}
function event(log){
  const message=log?.fields?.message;if(typeof message!=='string')return;
  const match=/\b(?:Received message|SSE event:)\s*(\{.*\})\s*$/.exec(message);if(!match)return;
  let e;try{e=JSON.parse(match[1]);}catch{return;}
  if(!['response.created','response.completed','response.failed','response.incomplete'].includes(e.type)||!safe(e.response?.id))return;
  const r=e.response,entry=responses.get(r.id)??{responseId:r.id,candidates:new Set(),messageIds:new Set(),completed:false};
  if(safe(r.model))entry.candidates.add(r.model);
  if(e.type==='response.completed'&&r.status==='completed'){
    entry.completed=true;
    for(const item of Array.isArray(r.output)?r.output:[])if(item.type==='message'&&item.role==='assistant'&&safe(item.id))entry.messageIds.add(item.id);
  }
  if(e.type==='response.failed'||e.type==='response.incomplete')entry.completed=false;
  responses.set(r.id,entry);
}
// Desktop stderr chunks may split or concatenate JSON records; parse balanced objects.
function decoder(){let buffer='';return chunk=>{
  buffer+=chunk;if(buffer.length>8*1024*1024){buffer='';malformedChunks++;return;}
  let start=-1,depth=0,quoted=false,escaped=false,consumed=0;
  for(let i=0;i<buffer.length;i++){
    const c=buffer[i];if(start<0){if(c==='{'){start=i;depth=1;}continue;}
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{event(JSON.parse(buffer.slice(start,i+1)));}catch{malformedChunks++;}consumed=i+1;start=-1;}
  }
  if(consumed)buffer=buffer.slice(consumed);
};}
for(const file of files(session.logRoot,'.log')){
  const info=statSync(file);if(info.mtimeMs<since)continue;if(info.size>32*1024*1024){skippedLargeFiles++;continue;}
  const push=decoder();
  for(const line of readFileSync(file,'utf8').split('\n')){
    const marker='[AppServerConnection] Codex CLI stderr message=';const i=line.indexOf(marker);if(i<0)continue;
    const time=Date.parse(line.slice(0,line.indexOf(' ')));if(!Number.isFinite(time)||time<since)continue;
    const raw=line.slice(i+marker.length);try{push(raw.startsWith('"')?JSON.parse(raw):raw);}catch{malformedChunks++;}
  }
}
const codexHome=process.env.CODEX_HOME||join(homedir(),'.codex');
for(const file of files(join(codexHome,'sessions'),'.jsonl')){
  const info=statSync(file);if(info.mtimeMs<since)continue;if(info.size>32*1024*1024){skippedLargeFiles++;continue;}
  let threadId=null,turn=null;
  for(const line of readFileSync(file,'utf8').split('\n')){
    let e;try{e=JSON.parse(line);}catch{continue;}
    if(e.type==='session_meta')threadId=safe(e.payload?.id)?e.payload.id:null;
    if(e.type==='turn_context')turn=e.payload;
    if(e.type==='response_item'&&e.payload?.role==='assistant'&&safe(e.payload.id)&&safe(threadId)&&safe(turn?.turn_id)&&safe(turn?.model)){
      const value={threadId,turnId:turn.turn_id,requested:turn.model};const group=messages.get(e.payload.id)??new Map();group.set(JSON.stringify(value),value);messages.set(e.payload.id,group);
    }
  }
}
const records=[];
for(const r of responses.values()){
  if(!r.completed||r.messageIds.size===0)continue;const contexts=new Map();
  for(const id of r.messageIds)for(const [key,value]of messages.get(id)??[])contexts.set(key,value);
  const candidates=[...r.candidates],context=contexts.size===1?[...contexts.values()][0]:null;
  let verdict='无法核验';if(contexts.size>1||candidates.length>1)verdict='证据冲突';else if(context&&candidates.length===1)verdict=context.requested.toLowerCase()===candidates[0].toLowerCase()?'一致':'不一致';
  records.push({responseId:r.responseId,messageIds:[...r.messageIds],...context,candidates,verdict,evidence:'completed response.model + exact rollout message ID',associationCount:contexts.size});
}
const report={checkedAt:new Date().toISOString(),startedAt:session.startedAt,records,skippedLargeFiles,malformedChunks,scope:'仅有明确消息 ID 关联的诊断请求；缺失字段不能核验'};
const outputFile=process.argv.find(a=>a.startsWith('--output='))?.slice(9)||join(root,'desktop-metadata-report.json');
writeFileSync(outputFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

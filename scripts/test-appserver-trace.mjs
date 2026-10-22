// Explicit live diagnostic experiment; never included in npm test or run at startup.
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,mkdtempSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {parse} from 'smol-toml';

const binary=process.env.CMC_TEST_CODEX_BIN||process.env.CODEX_CLI_PATH;
if(!binary||!existsSync(binary))throw new Error('Set CMC_TEST_CODEX_BIN to the installed desktop codex.exe.');
const version=execFileSync(binary,['--version'],{encoding:'utf8',windowsHide:true}).trim();
const configFile=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'config.toml');
const hash=()=>existsSync(configFile)?createHash('sha256').update(readFileSync(configFile)).digest('hex'):null;
const before=hash(),testRoot=resolve('test-results','appserver-trace');mkdirSync(testRoot,{recursive:true});
const directory=mkdtempSync(join(testRoot,'run-'));
const mock=process.argv.includes('--mock');let fixture,websockets;
if(mock){
  const events=()=>{const id='resp_mock_'+Date.now(),message={id:'msg_'+id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'pong',annotations:[]}]};return [{type:'response.created',response:{id,model:'gpt-6-astra',status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'pong'},{type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response:{id,model:'gpt-6-astra',status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];};
  fixture=http.createServer(async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'content-type':'text/event-stream'});for(const e of events())res.write('data: '+JSON.stringify(e)+'\n\n');res.end();});
  websockets=new WebSocketServer({server:fixture});websockets.on('connection',socket=>socket.on('message',()=>{for(const e of events())socket.send(JSON.stringify(e));}));
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
}
const requested='gpt-6-astra';
const report={version,mode:mock?'local-fixture':'live-account',requested,configurationUnchanged:false,initialized:false,threadId:null,turnId:null,turnStatus:null,traceJsonLines:0,inboundResponseEvents:0,responseEvents:[],responseLinks:[],databaseLinks:[],rpcItems:[],loggedItems:[],rolloutLinks:[],logShapes:[],databaseFiles:[],databaseFailure:null,correlationComplete:false,messageCorrelationComplete:false,spanKeys:[],spanModelValues:[],desktopLogSimulation:false,simulationOnly:true,rawDiagnosticSaved:false,failure:null};
const spansKeys=new Set(),spanModels=new Set(),pending=new Map();let requestId=0,stderrRest='',stdoutRest='',done;
const serverShapes=[],startupFailures=[];
const fixtureDesktopLines=[];const startedAt=new Date().toISOString();
const completed=new Promise(resolve=>{done=resolve;});
const stderrDecoder=new StringDecoder('utf8'),stdoutDecoder=new StringDecoder('utf8');
const filters='error,codex_core=trace,codex_app_server::outgoing_message=trace,codex_api::endpoint=trace,tungstenite::protocol=trace,tungstenite::protocol::frame=off,codex_api::sse::responses=trace,feedback_tags=info';
const args=['app-server','--stdio','-c','features.shell_tool=false','-c','features.code_mode=false','-c','features.apps=false','-c','features.plugins=false','-c','notify=[]'];
args.push('-c','sqlite_home='+JSON.stringify(directory));
if(mock)args.push('-c','openai_base_url='+JSON.stringify('http://127.0.0.1:'+fixture.address().port+'/v1'));
if(!mock)try{const config=parse(existsSync(configFile)?readFileSync(configFile,'utf8'):'');for(const name of Object.keys(config.mcp_servers??{}))if(/^[\w-]+$/.test(name))args.push('-c',`mcp_servers.${name}.enabled=false`);}catch{}
const child=spawn(binary,args,{cwd:directory,windowsHide:true,env:{...process.env,...mock?{CODEX_HOME:directory,OPENAI_API_KEY:'test-local-fixture-key'}:{},RUST_LOG:filters,LOG_FORMAT:'json',CODEX_SQLITE_HOME:directory},stdio:['pipe','pipe','pipe']});
let stdoutBytes=0,stderrBytes=0;
const timer=setTimeout(()=>{report.failure='timeout';done();child.kill();},90000);
const notify=(method,params)=>child.stdin.write(JSON.stringify({method,params})+'\n');
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++requestId;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
function stderrLine(line){
  let log;try{log=JSON.parse(line);}catch{if(mock&&startupFailures.length<3)startupFailures.push(line.slice(0,300));return;}
  report.traceJsonLines++;
  const responseIdValue=log.fields?.last_model_response_id;
  if((typeof responseIdValue==='string'||report.logShapes.length<2)&&report.logShapes.length<4)report.logShapes.push({keys:Object.keys(log),fieldKeys:Object.keys(log.fields??{}),spanType:typeof log.span,spansType:typeof log.spans});
  if(typeof responseIdValue==='string'){
    let responseId=responseIdValue;try{responseId=JSON.parse(responseIdValue);}catch{}
    if(typeof responseId==='string'&&/^resp_[\w-]{1,200}$/.test(responseId)){
      const spans=[...(Array.isArray(log.spans)?log.spans:[]),...(log.span?[log.span]:[])];const fields={};
      for(const span of spans)for(const [key,value]of Object.entries(span))if(['model','thread_id','thread.id','conversation.id','turn_id','turn.id','submission.id'].includes(key)&&typeof value==='string'&&/^[\w.-]{1,200}$/.test(value))fields[key]=value;
      report.responseLinks.push({responseId,fields});
    }
  }
  const message=log.fields?.message;
  if(typeof message!=='string')return;
  if(mock&&/item\/completed|ItemCompleted/.test(message)&&serverShapes.length<2)serverShapes.push({target:log.target,fieldKeys:Object.keys(log.fields),prefix:message.slice(0,350)});
  const outgoing=/app-server event:\s*(\{.*\})\s*$/.exec(message);
  if(outgoing)try{const rpc=JSON.parse(outgoing[1]);if(rpc.method==='item/completed'&&rpc.params?.item?.type==='agentMessage')report.loggedItems.push({threadId:rpc.params.threadId,turnId:rpc.params.turnId,messageId:rpc.params.item.id});}catch{}
  const match=/\b(?:Received message|SSE event:)\s*(\{.*\})\s*$/.exec(message);
  if(!match)return;
  let event;try{event=JSON.parse(match[1]);}catch{return;}
  if(!['response.created','response.completed','response.failed','response.incomplete'].includes(event.type))return;
  const r=event.response;if(!r||typeof r.id!=='string')return;
  report.inboundResponseEvents++;
  const spans=[...(Array.isArray(log.spans)?log.spans:[]),...(log.span?[log.span]:[])];
  const models=new Set(),threadIds=new Set(),turnIds=new Set();
  for(const span of spans){for(const [key,value]of Object.entries(span)){
    spansKeys.add(key);
    if(key==='model'&&typeof value==='string'&&/^[\w.-]{1,100}$/.test(value)){spanModels.add(value);models.add(value);}
    if(['thread_id','thread.id','conversation.id'].includes(key)&&typeof value==='string')threadIds.add(value);
    if(['turn.id','turn_id','submission.id'].includes(key)&&typeof value==='string')turnIds.add(value);
  }}
  const output=Array.isArray(r.output)?r.output:[];
  const answer=output.some(o=>o.type==='message'&&o.role==='assistant');
  report.responseEvents.push({event:event.type,responseId:r.id,messageIds:output.filter(o=>o.type==='message'&&o.role==='assistant'&&typeof o.id==='string').map(o=>o.id),model:typeof r.model==='string'&&/^[\w.-]{1,100}$/.test(r.model)?r.model:null,status:r.status??null,hasAssistantOutput:answer,spanModels:[...models],spanThreadIds:[...threadIds],spanTurnIds:[...turnIds]});
  // Model only: simulate the installed desktop's debug message escaping and recover it.
  // This is a parser/format experiment, not an actual desktop GUI integration test.
  const encoded='debug [AppServerConnection] Codex CLI stderr message='+JSON.stringify(line);
  if(mock)fixtureDesktopLines.push(new Date().toISOString()+' '+encoded);
  const recovered=JSON.parse(encoded.slice(encoded.indexOf('message=')+8));
  const restored=JSON.parse(recovered);
  if(restored.fields?.message===message)report.desktopLogSimulation=true;
}
child.stderr.on('data',chunk=>{
  stderrBytes+=chunk.length;if(stderrBytes>32*1024*1024){report.failure='diagnostic-size-limit';done();child.kill();return;}
  stderrRest+=stderrDecoder.write(chunk);let end;
  while((end=stderrRest.indexOf('\n'))>=0){stderrLine(stderrRest.slice(0,end));stderrRest=stderrRest.slice(end+1);}
});
child.stdout.on('data',chunk=>{
  stdoutBytes+=chunk.length;if(stdoutBytes>8*1024*1024){report.failure='protocol-size-limit';done();child.kill();return;}
  stdoutRest+=stdoutDecoder.write(chunk);let end;
  while((end=stdoutRest.indexOf('\n'))>=0){const line=stdoutRest.slice(0,end);stdoutRest=stdoutRest.slice(end+1);let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.id!==undefined&&pending.has(value.id)){const p=pending.get(value.id);pending.delete(value.id);value.error?p.reject(new Error('RPC '+value.error.code)):p.resolve(value.result);}
    else if(value.method==='turn/completed'){report.turnStatus=value.params?.turn?.status??null;done();}
    else if(value.method==='item/completed'&&value.params?.item?.type==='agentMessage'){report.rpcItems.push({threadId:value.params.threadId,turnId:value.params.turnId,messageId:value.params.item.id});}
    else if(value.method&&value.id!==undefined){child.stdin.write(JSON.stringify({id:value.id,error:{code:-32601,message:'Not available in diagnostic test'}})+'\n');}
  }
});
child.on('error',()=>{report.failure='spawn-error';done();});
child.on('close',code=>{if(!report.turnStatus&&!report.failure)report.failure='process-exit-'+code;done();for(const p of pending.values())p.reject(new Error('Process closed'));pending.clear();});
try{
  await rpc('initialize',{clientInfo:{name:'codex_model_checker_diagnostic',version:'0.1.1'},capabilities:{experimentalApi:true}});report.initialized=true;notify('initialized',{});
  const thread=await rpc('thread/start',{model:requested,cwd:directory,ephemeral:!mock,approvalPolicy:'never',sandbox:'read-only'});report.threadId=thread.thread.id;
  const turn=await rpc('turn/start',{threadId:report.threadId,input:[{type:'text',text:'Reply with exactly the single word pong. Do not use tools or read any files.'}],model:requested});report.turnId=turn.turn.id;
  await completed;
}catch(error){report.failure=String(error.message).slice(0,100);}
finally{
  clearTimeout(timer);child.stdin.end();
  if(child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('close',resolve)),new Promise(resolve=>setTimeout(()=>{child.kill();resolve();},2000))]);}
  if(stderrRest)stderrLine(stderrRest+stderrDecoder.end());
  report.spanKeys=[...spansKeys];report.spanModelValues=[...spanModels];report.configurationUnchanged=before===hash();
  let db;
  try{
    db=new DatabaseSync(join(directory,'logs_2.sqlite'),{readOnly:true});db.exec('PRAGMA busy_timeout=0;PRAGMA query_only=ON;');
    const rows=db.prepare("SELECT feedback_log_body FROM logs WHERE target='feedback_tags' AND feedback_log_body LIKE '%last_model_response_id%'").all();
    for(const row of rows){const body=row.feedback_log_body??'';for(const event of report.responseEvents.filter(e=>e.event==='response.completed'))if(body.includes(event.responseId)){
      const modelValues=[...new Set([...body.matchAll(/\bmodel\s*=\s*"?([\w.-]{1,100})/g)].map(m=>m[1]))];
      report.databaseLinks.push({responseId:event.responseId,modelValues,threadIdMatch:body.includes(report.threadId),turnIdMatch:body.includes(report.turnId)});
    }}
  }catch(error){report.databaseFailure=error.code??'unavailable';}finally{db?.close();}
  report.databaseFiles=(await import('node:fs')).readdirSync(directory).filter(n=>n.includes('sqlite'));
  // Only responses whose message was actually delivered to the test turn are turn evidence.
  // Unlinked warm-up/other responses must not be assigned by arrival order or timestamp.
  const completedResponses=report.responseEvents.filter(e=>e.event==='response.completed'&&e.hasAssistantOutput&&report.rpcItems.some(item=>e.messageIds.includes(item.messageId)&&item.threadId===report.threadId&&item.turnId===report.turnId));
  function rollouts(root){if(!existsSync(root))return;for(const item of readdirSync(root,{withFileTypes:true})){const file=join(root,item.name);if(item.isDirectory())rollouts(file);else if(item.name.endsWith('.jsonl')){let threadId=null,turn=null;for(const line of readFileSync(file,'utf8').split('\n')){let value;try{value=JSON.parse(line);}catch{continue;}if(value.type==='session_meta')threadId=value.payload?.id;if(value.type==='turn_context')turn=value.payload;if(value.type==='response_item'&&value.payload?.role==='assistant'&&turn)report.rolloutLinks.push({threadId,turnId:turn.turn_id??null,requested:turn.model??null,messageId:value.payload.id??null});}}}}
  if(mock)rollouts(join(directory,'sessions'));
  report.correlationComplete=completedResponses.length>0&&completedResponses.every(e=>report.databaseLinks.some(l=>l.responseId===e.responseId&&l.modelValues.length===1&&l.modelValues[0]===requested&&l.threadIdMatch&&l.turnIdMatch));
  report.messageCorrelationComplete=completedResponses.length>0&&completedResponses.every(e=>report.rolloutLinks.some(l=>e.messageIds.includes(l.messageId)&&l.threadId===report.threadId&&l.turnId===report.turnId&&l.requested===requested));
  if(mock){
    const logs=join(directory,'desktop-logs');mkdirSync(logs,{recursive:true});writeFileSync(join(logs,'fixture.log'),fixtureDesktopLines.join('\n'));
    const sessionPath=join(directory,'fixture-session.json'),outputPath=join(directory,'fixture-observer-report.json');
    writeFileSync(sessionPath,JSON.stringify({startedAt,logRoot:logs}));
    const output=execFileSync(process.execPath,['scripts/read-desktop-models.mjs','--session='+sessionPath,'--output='+outputPath],{encoding:'utf8',env:{...process.env,CODEX_HOME:directory}});
    const observed=JSON.parse(output);
    report.desktopObserverPass=observed.records.some(r=>r.threadId===report.threadId&&r.turnId===report.turnId&&r.requested===requested&&r.candidates.length===1&&r.candidates[0]===requested&&r.verdict==='一致');
  }
  writeFileSync(join(testRoot,'metadata-report.json'),JSON.stringify(report,null,2));
  if(mock)console.log(JSON.stringify({fixtureOnlyServerShapes:serverShapes,startupFailures}));
  if(mock){for(const client of websockets.clients)client.terminate();websockets.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));}
  // Delete only the freshly created test directory after checking its absolute boundary.
  const rel=relative(testRoot,resolve(directory));if(rel&&!rel.startsWith('..')&&!isAbsolute(rel))rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:200});
  console.log(JSON.stringify(report,null,2));
}

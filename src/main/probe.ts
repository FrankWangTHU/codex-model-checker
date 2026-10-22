import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, delimiter } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Candidate, Observation } from '../core/types';

export function findCodex():string|null {
  if(process.env.CODEX_CLI_PATH?.endsWith('.exe')&&existsSync(process.env.CODEX_CLI_PATH))return process.env.CODEX_CLI_PATH;
  const root=join(homedir(),'AppData','Local','OpenAI','Codex','bin');
  try{const binaries=readdirSync(root).map(dir=>join(root,dir,'codex.exe')).filter(p=>existsSync(p)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);if(binaries[0])return binaries[0];}catch{}
  const dirs=[...(process.env.PATH??'').split(delimiter),join(homedir(),'AppData','Roaming','npm')];
  for(const dir of dirs){
    for(const path of [join(dir,'codex.exe'),join(dir,'node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'),join(dir,'node_modules','@openai','codex','vendor','x86_64-pc-windows-msvc','codex','codex.exe')])if(existsSync(path))return path;
  }
  return null;
}

// Consume only inbound events. No raw logs, output text, credentials, or prompt bodies persist.
export class ProbeParser {
  private buffer='';private decoder=new StringDecoder('utf8');
  private responses=new Map<string,{candidates:Candidate[];completed:boolean;answered:boolean}>();
  private bytes=0;overflow=false;
  push(chunk:Buffer){
    this.bytes+=chunk.length;if(this.bytes>32*1024*1024){this.overflow=true;this.buffer='';return;}
    this.buffer+=this.decoder.write(chunk);let end:number;
    while((end=this.buffer.indexOf('\n'))>=0){this.line(this.buffer.slice(0,end));this.buffer=this.buffer.slice(end+1);}
    if(this.buffer.length>2*1024*1024){this.overflow=true;this.buffer='';}
  }
  finish(){this.buffer+=this.decoder.end();if(this.buffer)this.line(this.buffer);this.buffer='';}
  private line(line:string){
    const marker=/\b(?:Received message|SSE event:)\s*(\{.*\})\s*$/.exec(line.replace(/\x1b\[[0-9;]*m/g,''));
    if(!marker)return;
    try{
      const event=JSON.parse(marker[1]);
      if(!['response.created','response.completed','response.failed','response.incomplete'].includes(event.type))return;
      const r=event.response;if(!r||typeof r.id!=='string'||!/^[\w.-]{1,200}$/.test(r.id))return;
      if(this.responses.size>=100&&!this.responses.has(r.id)){this.overflow=true;return;}
      const state=this.responses.get(r.id)??{candidates:[],completed:false,answered:false};
      if(typeof r.model==='string'&&/^[\w .:/-]{1,160}$/.test(r.model)&&!state.candidates.some(c=>c.model===r.model))state.candidates.push({field:'response.model',model:r.model,kind:'route'});
      if(event.type==='response.completed'&&r.status==='completed'){
        state.completed=true;
        state.answered=Array.isArray(r.output)&&r.output.some((o:{type?:string;role?:string;content?:unknown[]})=>o.type==='message'&&o.role==='assistant'&&Array.isArray(o.content)&&o.content.length>0);
      }
      if(event.type==='response.failed'||event.type==='response.incomplete')state.completed=false;
      this.responses.set(r.id,state);
    }catch{}
  }
  result(requested:string,connection:string,successful:boolean):Observation[]{
    if(!successful||this.overflow)return [];
    return [...this.responses].filter(([,r])=>r.completed&&r.answered).map(([id,r])=>({id,source:'codex',connection,requestId:id,time:Date.now(),requested,requestEvidence:'probe',candidates:r.candidates,transport:'probe',state:'complete',special:false}));
  }
}

export class ProbeRunner {
  private child?:ChildProcess;
  private running=false;
  private cancelled=false;
  constructor(private receive:(o:Observation)=>void,private health:(s:string)=>void,private networkEnv:()=>Promise<Record<string,string>>=async()=>({})){}
  cancel(){this.cancelled=true;this.child?.kill();}
  async run():Promise<void>{
    if(this.running)throw new Error('抽检正在运行，请等待结束。');
    const binary=findCodex();if(!binary)throw new Error('未找到 Codex CLI，请先安装官方 CLI。');
    const requested='gpt-6-astra',connection=randomUUID(),parser=new ProbeParser();
    const cwd=mkdtempSync(join(tmpdir(),'cmc-probe-'));
    const env={...process.env,RUST_LOG:'error,tungstenite::protocol=trace,tungstenite::protocol::frame=off,codex_api::sse::responses=trace',NO_COLOR:'1'};
    // Uses Codex's own login and transport. Overrides are scoped to this child only.
    const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--color','never','-m',requested,'-c','approval_policy="never"','-c','features.shell_tool=false','-c','features.code_mode=false','-c','notify=[]','Reply with exactly the single word pong. Do not call tools or read any files.'];
    this.health('正在独立抽检 Astra · 只代表本次 CLI 请求');
    this.running=true;
    this.cancelled=false;
    let timeout=false,failure='';
    try{
      const info=await promisify(execFile)(binary,['--version'],{windowsHide:true,timeout:5000,maxBuffer:4096});
      const version=/codex-cli ([\w.+-]+)/.exec(info.stdout)?.[1]??'未知';
      this.health(`正在独立抽检 Astra · CLI ${version}`);
      Object.assign(env,await this.networkEnv());
      if(this.cancelled){this.health('抽检已取消');return;}
      const child=spawn(binary,args,{cwd,env,windowsHide:true,stdio:['ignore','ignore','pipe']});this.child=child;
      child.stderr?.on('data',(chunk:Buffer)=>{parser.push(chunk);const text=chunk.toString();for(const [pattern,label] of [[/401|Unauthorized|not logged in|not signed in/i,'登录未就绪'],[/403|Forbidden/i,'服务器拒绝访问'],[/429|rate.limit|at capacity/i,'额度或容量限制'],[/unexpected argument|unknown variant|unrecognized|unknown field/i,'CLI 参数不兼容'],[/failed to load|error loading|configuration/i,'CLI 配置加载失败'],[/connect error|timed out|dns/i,'网络连接失败'],[/not supported|not found/i,'模型或运行依赖不可用'],[/requires a newer version/i,'CLI 版本过旧，请更新 Codex']] as const)if(pattern.test(text))failure=label;if(parser.overflow)child.kill();});
      const timer=setTimeout(()=>{timeout=true;child.kill();},90000);
      let code:number|null;
      try{code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
      parser.finish();const results=parser.result(requested,connection,code===0&&!timeout&&!this.cancelled);
      for(const record of results)this.receive(record);
      this.health(this.cancelled?'抽检已取消 · 当前 Codex 会话未改动':results.length?`抽检完成 · CLI ${version} · 仅适用于本次独立请求`:timeout?'抽检超时 · 当前 Codex 会话未改动':code!==0?`抽检失败（退出码 ${code}）· ${failure||'CLI 未完成请求'}；不会自动重试`:'抽检完成但没有可核验的响应模型 · 不使用预热结果');
    }catch{this.health('抽检启动失败 · 当前 Codex 会话未改动');}
    finally{this.child=undefined;this.running=false;try{rmdirSync(cwd);}catch{/* Never recursively remove unexpected files. */}}
  }
}

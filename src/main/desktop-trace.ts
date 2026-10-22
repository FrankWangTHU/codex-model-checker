import {readdir,stat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {Observation} from '../core/types';

const safe=(v:unknown):v is string=>typeof v==='string'&&/^[\w .:/-]{1,160}$/.test(v);
export interface MessageContext {threadId:string;turnId:string;requested:string}
interface Response {id:string;time:number;models:Set<string>;messages:Set<string>;complete:boolean}
// Retain only explicit identifiers and model metadata, never response content.
export class DesktopEvidence {
  private responses=new Map<string,Response>();
  private contexts=new Map<string,Map<string,MessageContext>>();
  private emitted=new Map<string,string>();
  constructor(private receive:(entry:Observation)=>void){}
  associate(messageId:string,context:MessageContext){
    if(!safe(messageId)||!Object.values(context).every(safe))return;
    const group=this.contexts.get(messageId)??new Map();group.set(JSON.stringify(context),{...context});this.contexts.set(messageId,group);
    if(this.contexts.size>10000)this.contexts.delete(this.contexts.keys().next().value!);
    for(const response of this.responses.values())if(response.messages.has(messageId))this.publish(response);
  }
  event(log:unknown,time:number){
    const message=(log as {fields?:{message?:unknown}})?.fields?.message;if(typeof message!=='string')return;
    const match=/\b(?:Received message|SSE event:)\s*(\{.*\})\s*$/.exec(message);if(!match)return;
    let e;try{e=JSON.parse(match[1]);}catch{return;}
    if(!['response.created','response.completed','response.failed','response.incomplete'].includes(e.type)||!safe(e.response?.id))return;
    const r=e.response;const entry=this.responses.get(r.id)??{id:r.id,time,models:new Set<string>(),messages:new Set<string>(),complete:false};
    if(safe(r.model))entry.models.add(r.model);
    if(e.type==='response.completed'&&r.status==='completed'){
      entry.complete=true;entry.time=time;
      for(const item of Array.isArray(r.output)?r.output:[])if(item.type==='message'&&item.role==='assistant'&&safe(item.id))entry.messages.add(item.id);
    }
    if(e.type==='response.failed'||e.type==='response.incomplete')entry.complete=false;
    this.responses.set(r.id,entry);this.publish(entry);
    if(this.responses.size>10000){const key=this.responses.keys().next().value!;this.responses.delete(key);this.emitted.delete(key);}
  }
  private publish(r:Response){
    if(!r.complete||!r.messages.size)return;
    const contexts=new Map<string,MessageContext>();for(const id of r.messages)for(const [key,value]of this.contexts.get(id)??[])contexts.set(key,value);
    // No timestamp/order guesses. Wait for a persisted assistant message ID.
    if(!contexts.size)return;
    const context=contexts.size===1?[...contexts.values()][0]:null;
    const observation:Observation={id:createHash('sha256').update('desktop:'+r.id).digest('hex'),source:'codex',connection:'desktop',requestId:r.id,time:r.time,requested:context?.requested??null,requestEvidence:'desktop',transport:'desktop',state:'complete',special:context?.requested==='codex-auto-review',candidates:[...r.models].map(model=>({field:'response.model',model,kind:'route'})),desktop:{responseId:r.id,messageIds:[...r.messages],threadId:context?.threadId??null,turnId:context?.turnId??null,association:contexts.size===1?'exact':'conflict'}};
    const serialized=JSON.stringify(observation);if(this.emitted.get(r.id)!==serialized){this.emitted.set(r.id,serialized);this.receive(observation);}
  }
}

export class StderrDecoder {
  private buffer='';
  private scanned=0;private start=-1;private depth=0;private quoted=false;private escaped=false;
  constructor(private receive:(log:unknown,time:number)=>void){}
  push(chunk:string,time:number){
    this.buffer+=chunk;if(this.buffer.length>8*1024*1024){this.buffer='';this.scanned=0;this.start=-1;this.depth=0;this.quoted=false;this.escaped=false;return;}
    let consumed=0;
    for(let i=this.scanned;i<this.buffer.length;i++){
      const c=this.buffer[i];if(this.start<0){if(c==='{'){this.start=i;this.depth=1;}continue;}
      if(this.quoted){if(this.escaped)this.escaped=false;else if(c==='\\')this.escaped=true;else if(c==='"')this.quoted=false;continue;}
      if(c==='"')this.quoted=true;else if(c==='{')this.depth++;else if(c==='}'&&--this.depth===0){try{this.receive(JSON.parse(this.buffer.slice(this.start,i+1)),time);}catch{}consumed=i+1;this.start=-1;}
    }
    if(this.start<0){this.buffer='';this.scanned=0;}
    else {if(consumed){this.buffer=this.buffer.slice(consumed);this.start-=consumed;}this.scanned=this.buffer.length;}
  }
}

export class DesktopTraceWatcher {
  readonly evidence:DesktopEvidence;
  private cursors=new Map<string,{offset:number;rest:string;identity:string;utf8:TextDecoder;decoder:StderrDecoder}>();
  private timer?:NodeJS.Timeout;private busy=false;private stopped=false;private lastEvent=0;
  constructor(private roots:string[],receive:(entry:Observation)=>void,private health:(text:string)=>void){this.evidence=new DesktopEvidence(receive);}
  start(){this.stopped=false;void this.scan();this.timer=setInterval(()=>void this.scan(),3000);}
  stop(){this.stopped=true;clearInterval(this.timer);}
  async scan(){
    if(this.busy||this.stopped)return;this.busy=true;
    let backlog=0;
    try{
      for(const root of this.roots)for(const days of [0,1]){
        const d=new Date(Date.now()-days*86400000),directory=join(root,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));
        let names:string[];try{names=await readdir(directory);}catch{continue;}
        for(const name of names.filter(n=>/^codex-desktop-.*\.log$/.test(n))){
          if(this.stopped)return;const path=join(directory,name);let handle;
          try{
            const info=await stat(path);const identity=String(info.ino)+':'+info.birthtimeMs;
            let c=this.cursors.get(path);
            if(!c||c.identity!==identity||info.size<c.offset){c={offset:0,rest:'',identity,utf8:new TextDecoder(),decoder:new StderrDecoder((log,time)=>{this.lastEvent=Math.max(this.lastEvent,time);this.evidence.event(log,time);})};this.cursors.set(path,c);}
            if(c.offset===info.size)continue;
            handle=await open(path,'r');let remaining=Math.min(info.size-c.offset,4*1024*1024);
            while(remaining>0&&!this.stopped){const buffer=Buffer.alloc(Math.min(65536,remaining));const {bytesRead}=await handle.read(buffer,0,buffer.length,c.offset);if(!bytesRead)break;c.offset+=bytesRead;remaining-=bytesRead;c.rest+=c.utf8.decode(buffer.subarray(0,bytesRead),{stream:true});
              let end;while((end=c.rest.indexOf('\n'))>=0){const line=c.rest.slice(0,end);c.rest=c.rest.slice(end+1);const marker='[AppServerConnection] Codex CLI stderr message=';const i=line.indexOf(marker);if(i<0)continue;const time=Date.parse(line.slice(0,line.indexOf(' ')));if(!Number.isFinite(time))continue;const raw=line.slice(i+marker.length);try{c.decoder.push(raw.startsWith('"')?JSON.parse(raw):raw,time);}catch{}}
              if(c.rest.length>8*1024*1024)c.rest='';
            }
            backlog+=Math.max(0,info.size-c.offset);
          }catch{/* Rotation and locked files are harmless to the original request. */}finally{await handle?.close();}
        }
      }
      if(this.cursors.size>256)this.cursors.clear();
      this.health(backlog?'历史日志补读中 · 剩余约 '+Math.ceil(backlog/1024/1024)+' MiB':this.lastEvent?'桌面响应旁读中 · 最近诊断 '+new Date(this.lastEvent).toLocaleTimeString('zh-CN',{hour12:false}):'未发现桌面响应诊断 · 普通启动可能没有响应字段');
    }finally{this.busy=false;}
  }
}

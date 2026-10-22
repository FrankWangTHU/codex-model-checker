import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requestModel } from '../core/capture';
import type { Observation } from '../core/types';
import type {MessageContext} from './desktop-trace';
export class SessionWatcher {
  private cursors=new Map<string,{offset:number;rest:string;identity:string}>();
  private timer?:NodeJS.Timeout;private busy=false;private stopped=false;
  private contexts=new Map<string,{threadId?:string;turnId?:string;requested?:string}>();
  constructor(private root:string,private receive:(o:Observation)=>void,private health:(text:string)=>void,private associate?:(messageId:string,context:MessageContext)=>void){}
  async start():Promise<void>{this.stopped=false;await this.scan();if(!this.stopped)this.timer=setInterval(()=>void this.scan(),2000);}
  stop():void{this.stopped=true;clearInterval(this.timer);}
  private async scan():Promise<void>{
    if(this.busy||this.stopped)return;this.busy=true;
    try{
      const now=new Date(); const directories=new Set<string>();
      for(const offset of [0,86400000]){const d=new Date(now.getTime()-offset);directories.add(join(this.root,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')));}
      let readable=false;
      for(const directory of directories){
        let names:string[];try{names=await readdir(directory);readable=true;}catch{continue;}
        for(const name of names.filter(n=>n.endsWith('.jsonl'))){
          if(this.stopped)return; const path=join(directory,name);let handle;
          try{
            const info=await stat(path);const identity=String(info.ino)+':'+info.birthtimeMs;
            let cursor=this.cursors.get(path);
            if(!cursor||cursor.identity!==identity||info.size<cursor.offset){cursor={offset:0,rest:'',identity};this.cursors.set(path,cursor);this.contexts.delete(path);}
            if(info.size===cursor.offset)continue;
            handle=await open(path,'r');
            // Read bounded chunks; carry UTF-8 bytes through TextDecoder across chunks.
            const decoder=new TextDecoder();let remaining=info.size-cursor.offset;
            while(remaining>0){const buffer=Buffer.alloc(Math.min(65536,remaining));const {bytesRead}=await handle.read(buffer,0,buffer.length,cursor.offset);if(!bytesRead)break;cursor.offset+=bytesRead;remaining-=bytesRead;
              cursor.rest+=decoder.decode(buffer.subarray(0,bytesRead),{stream:true});
              let newline:number;while((newline=cursor.rest.indexOf('\n'))>=0){const line=cursor.rest.slice(0,newline);cursor.rest=cursor.rest.slice(newline+1);this.line(path,line);}
              if(cursor.rest.length>4*1024*1024)cursor.rest='';
            }
            cursor.rest+=decoder.decode();
          }catch{/* Files may rotate while scanning. */}finally{await handle?.close();}
        }
      }
      this.health(readable?'只读日志监听中 · 会话记录不含服务器响应模型':'等待本机会话日志');
      if(this.cursors.size>2048)this.cursors.clear();
    }finally{this.busy=false;}
  }
  private line(path:string,line:string):void{
    try{const value=JSON.parse(line);
      const context=this.contexts.get(path)??{};this.contexts.set(path,context);
      if(value.type==='session_meta'&&typeof value.payload?.id==='string')context.threadId=value.payload.id;
      if(value.type==='turn_context'){context.turnId=value.payload?.turn_id;context.requested=requestModel(value.payload)??undefined;}
      if(value.type==='response_item'&&value.payload?.role==='assistant'&&typeof value.payload.id==='string'&&context.threadId&&context.turnId&&context.requested)this.associate?.(value.payload.id,context as MessageContext);
      if(value.type==='event_msg'&&value.payload?.type==='model_reroute'){
        const from=value.payload.from_model,to=value.payload.to_model;
        if(typeof from!=='string'||typeof to!=='string'||!/^[\w .:/-]{1,160}$/.test(from)||!/^[\w .:/-]{1,160}$/.test(to))return;
        const time=Date.parse(value.timestamp);if(!Number.isFinite(time))return;
        const id=createHash('sha256').update(path+'|'+value.timestamp+'|reroute').digest('hex');
        this.receive({id,source:'codex',connection:createHash('sha256').update(path).digest('hex').slice(0,24),requestId:id,time,requested:from,requestEvidence:'diagnostic',candidates:[{field:'model_reroute.to_model',model:to,kind:'route'}],transport:'diagnostic',state:'complete',special:from==='codex-auto-review'});return;
      }
      if(value.type!=='turn_context'||!value.payload)return;const requested=requestModel(value.payload);if(!requested)return;
      const turn=String(value.payload.turn_id??value.timestamp??'');const id=createHash('sha256').update(path+'|'+turn).digest('hex');
      const timestamp=Date.parse(value.timestamp);this.receive({id,source:'codex',connection:createHash('sha256').update(path).digest('hex').slice(0,24),requestId:id,time:Number.isFinite(timestamp)?timestamp:Date.now(),requested,requestEvidence:'session',candidates:[],transport:'log',state:'complete',special:false});
    }catch{}
  }
}

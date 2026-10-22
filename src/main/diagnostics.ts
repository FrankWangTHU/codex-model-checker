import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type {Observation} from '../core/types';

export function diagnosticEntry(row: {id:number;ts:number;target:string;feedback_log_body:string;thread_id:string|null}):Observation|null {
  if(!/^codex_core::session(?:::|$)/.test(row.target))return null;
  const body=row.feedback_log_body;
  const found=/server reported model ([\w.-]+) (?:while requested model was ([\w.-]+)|\(matches requested model\))\s*$/.exec(body);
  if(!found)return null;
  // The explicit equality message itself establishes the requested model.
  const requested=found[2]??found[1];
  const id=createHash('sha256').update(`${row.thread_id}|${row.ts}|${row.id}`).digest('hex');
  return {id,source:'codex',connection:row.thread_id??'diagnostics',requestId:id,time:row.ts*1000,requested,requestEvidence:'diagnostic',candidates:[{field:'diagnostic.server_model',model:found[1],kind:'route'}],transport:'diagnostic',state:'complete',special:requested==='codex-auto-review'};
}

export class DiagnosticWatcher {
  private timer?:NodeJS.Timeout;private cursor=0;private found=false;
  constructor(private file:string,private receive:(o:Observation)=>void,private health:(s:string)=>void){}
  start(){this.scan();this.timer=setInterval(()=>this.scan(),5000);}
  stop(){clearInterval(this.timer);}
  private scan(){
    let db:DatabaseSync|undefined;
    try{
      db=new DatabaseSync(this.file,{readOnly:true});db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON;');
      const max=(db.prepare('SELECT MAX(id) AS id FROM logs').get() as {id:number|null}).id??0;
      if(max<this.cursor)this.cursor=0;
      // Bounded ID scan; release the reader immediately, never checkpoint or write.
      const start=this.cursor||Math.max(0,max-10000);
      const end=Math.min(max,start+1000);
      const rows=db.prepare("SELECT id,ts,target,feedback_log_body,thread_id FROM logs WHERE id>? AND id<=? AND target LIKE 'codex_core::session%' AND feedback_log_body LIKE '%server reported model %'").all(start,end) as unknown as Parameters<typeof diagnosticEntry>[0][];
      for(const row of rows){const entry=diagnosticEntry(row);if(entry){this.found=true;this.receive(entry);}}
      this.cursor=end;
      this.health(this.found?'已取得服务器模型诊断 · 仅核验有该事件的请求':'诊断日志只读监听中 · 暂无服务器模型事件');
    }catch{this.health('诊断日志暂不可读 · 不影响 Codex 请求');}finally{db?.close();}
  }
}

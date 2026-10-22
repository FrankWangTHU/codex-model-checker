import { evidence, mergeEvidence, requestModel, StreamObserver } from '../core/capture';
import type { Observation } from '../core/types';
(() => {
  const marker='__codex_model_checker_hook_v1__';
  if((window as unknown as Record<string,unknown>)[marker])return;
  (window as unknown as Record<string,unknown>)[marker]=true;
  const connection=crypto.randomUUID();
  const publish=(entry:Observation)=>window.postMessage({channel:'codex-model-checker-v1',entry},location.origin);
  const make=(transport:Observation['transport']):Observation=>{const id=crypto.randomUUID();return {id,source:'chatgpt',connection,requestId:id,time:Date.now(),requested:null,requestEvidence:'missing',candidates:[],transport,state:'pending',special:false};};
  const relevant=(raw:string)=>{try{const u=new URL(raw,location.href);return u.origin===location.origin&&/^\/backend-api\/(?:f\/)?conversation(?:\/|$)/.test(u.pathname)&&!u.pathname.includes('/prepare');}catch{return false;}};
  const history=(value:unknown)=>{
    if(!value||typeof value!=='object')return;
    const root=value as Record<string,unknown>;
    const nodes=root.mapping&&typeof root.mapping==='object'?Object.values(root.mapping):Array.isArray(root.messages)?root.messages:[];
    for(const node of nodes.slice(-500)){
      if(!node||typeof node!=='object')continue;
      const message=(node as Record<string,unknown>).message??node;
      if(!message||typeof message!=='object')continue;
      const m=message as Record<string,unknown>;if(!m.author||typeof m.author!=='object'||(m.author as {role?:string}).role!=='assistant')continue;
      const entry=make('history');mergeEvidence(entry,{message});entry.state='complete';
      if(entry.candidates.length)publish(entry);
    }
  };
  const nativeFetch=window.fetch;
  window.fetch=function(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
    const url=input instanceof Request?input.url:String(input);
    if(!relevant(url))return nativeFetch.call(this,input,init);
    const entry=make('fetch');
    const readRequest=async()=>{
      try{
        let text=typeof init?.body==='string'?init.body:null;
        if(text===null&&input instanceof Request&&input.method!=='GET'&&!input.bodyUsed)text=await input.clone().text();
        if(text&&text.length<=1024*1024){entry.requested=requestModel(JSON.parse(text));entry.requestEvidence=entry.requested?'wire':'missing';}
      }catch{}
    };
    const requestReady=readRequest();
    const result=nativeFetch.call(this,input,init);
    void result.then(async response=>{
      try{
        const copy=response.clone();
        await requestReady;
        const type=copy.headers.get('content-type')??'';
        if(!type.includes('event-stream')&&!type.includes('json'))return;
        if(copy.headers.get('content-encoding')==='opaque')return;
        publish(entry);
        const isHistory=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase()==='GET';
        const parser=new StreamObserver(value=>{if(isHistory)history(value);else{mergeEvidence(entry,value);publish(entry);}},type.includes('event-stream')?'sse':'json');
        const reader=copy.body?.getReader();if(!reader)return;
        let count=0;
        for(;;){const next=await reader.read();if(next.done)break;count+=next.value.length;if(count>32*1024*1024){void reader.cancel();break;}parser.push(next.value);}
        parser.finish();entry.state=response.ok?'complete':'error';if(!isHistory)publish(entry);
      }catch{entry.state='error';publish(entry);}
    },()=>{entry.state='error';publish(entry);});
    return result;
  };
  const NativeWebSocket=window.WebSocket;
  window.WebSocket=new Proxy(NativeWebSocket,{
    construct(Target,args){
      const socket=Reflect.construct(Target,args) as WebSocket;
      // Observe only ChatGPT-owned sockets, leaving protocol and event behavior intact.
      let owned=false;try{const url=new URL(String(args[0]),location.href);owned=url.hostname==='chatgpt.com'||url.hostname==='ws.chatgpt.com'||url.hostname.endsWith('.chatgpt.com');}catch{}
      if(!owned)return socket;
      const pending:Observation[]=[];const active=new Map<string,Observation>();let current:Observation|undefined;
      const send=socket.send;
      socket.send=function(data:string|ArrayBufferLike|Blob|ArrayBufferView){
        if(typeof data==='string'&&data.length<=1024*1024){try{const value=JSON.parse(data),requested=requestModel(value);if(requested||value.type==='response.create'){const entry=make('websocket');entry.requested=requested;entry.requestEvidence=requested?'wire':'missing';pending.push(entry);publish(entry);}}catch{}}
        return send.call(this,data);
      };
      let queue=Promise.resolve();
      socket.addEventListener('message',event=>{
        queue=queue.then(async()=>{
          const raw=typeof event.data==='string'?event.data:event.data instanceof Blob?await event.data.text():event.data instanceof ArrayBuffer?new TextDecoder().decode(event.data):'';
          if(raw.length>4*1024*1024)return;
          try{
            const value=JSON.parse(raw),found=evidence(value);
            const responseId=found.responseId??(typeof value.response_id==='string'?value.response_id:undefined);
            if(responseId){current=active.get(responseId);if(!current){current=pending.shift()??make('websocket');active.set(responseId,current);}}
            if(!current&&found.candidates.length&&pending.length===1)current=pending.shift();
            if(current){mergeEvidence(current,value);publish(current);if(found.done){if(responseId)active.delete(responseId);current=undefined;}}
          }catch{}
        }).catch(()=>{});
      });
      socket.addEventListener('close',()=>{for(const entry of new Set([...pending,...active.values(),...(current?[current]:[])])){entry.state='cancelled';publish(entry);}});
      return socket;
    }
  });
})();

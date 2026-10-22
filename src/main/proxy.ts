import http from 'node:http';
import https from 'node:https';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { StreamObserver, requestModel, mergeEvidence, evidence } from '../core/capture';
import type { Observation } from '../core/types';
export const PROXY_PORT=43822;
const stripped = new Set(['host','connection','proxy-connection','keep-alive','transfer-encoding','upgrade','te','trailer','proxy-authorization','proxy-authenticate']);
export class ModelProxy {
  server: http.Server;
  private sockets=new Set<import('node:net').Socket>();
  private wss=new WebSocketServer({noServer:true, perMessageDeflate:false, maxPayload:64*1024*1024});
  constructor(private upstream: string, private token: string, private receive: (o: Observation) => void, private activity: () => void, private allowTestHttp=false) {
    const url=new URL(upstream);
    if (url.protocol !== 'https:' && !(allowTestHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Only HTTPS upstreams are supported');
    this.server=http.createServer((req,res) => this.forward(req,res));
    this.server.on('connection',socket => {this.sockets.add(socket); socket.on('close',()=>this.sockets.delete(socket));});
    this.server.on('upgrade',(req,socket,head) => {
      const target=this.target(req.url ?? '');
      if (!target || req.headers.origin) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      this.wss.handleUpgrade(req,socket,head,client=>this.forwardWebSocket(req,client,target));
    });
  }
  private target(raw: string): URL | null {
    // Exact token-scoped prefix, never an open forward proxy or arbitrary URL resolver.
    const [path, query] = raw.split('?'); const prefix=`/${this.token}/v1`;
    const candidate=path.slice(1).split('/')[0] ?? '';
    const a=Buffer.from(candidate),b=Buffer.from(this.token);
    if (a.length !== b.length || !timingSafeEqual(a,b) || !(path === prefix || path.startsWith(prefix+'/'))) return null;
    const suffix=path.slice(prefix.length);
    if (suffix.includes('..') || /%2e|%2f|%5c|\\/i.test(suffix)) return null;
    const target=new URL(this.upstream.replace(/\/$/,'')+suffix+(query === undefined ? '' : '?'+query));
    return target.origin === new URL(this.upstream).origin ? target : null;
  }
  private entry(transport: Observation['transport'], connection=randomUUID()): Observation {
    const id=randomUUID(); return {id,source:'codex',connection,requestId:id,time:Date.now(),requested:null,requestEvidence:'missing',candidates:[],transport,state:'pending',special:false};
  }
  private forward(req: http.IncomingMessage,res: http.ServerResponse): void {
    const target=this.target(req.url ?? '');
    if (!target || req.headers.origin) {res.writeHead(403).end(); return;}
    this.activity(); const entry=this.entry('proxy');
    const headers: http.OutgoingHttpHeaders={};
    const connectionHeaders=String(req.headers.connection ?? '').toLowerCase().split(',').map(s=>s.trim());
    for (const [key,value] of Object.entries(req.headers)) if (!stripped.has(key) && !connectionHeaders.includes(key)) headers[key]=value;
    // The observer needs plaintext metadata; no response re-encoding is performed.
    headers['accept-encoding']='identity';
    const requestObserver=new StreamObserver(v=>{entry.requested=requestModel(v);entry.requestEvidence=entry.requested?'wire':'missing';this.receive({...entry,candidates:[...entry.candidates]});},'json');
    const upstream=(target.protocol==='https:'?https:http).request(target,{method:req.method,headers},response=>{
      const outgoing: http.OutgoingHttpHeaders={};
      for (const [key,value] of Object.entries(response.headers)) if (!stripped.has(key)) outgoing[key]=value;
      res.writeHead(response.statusCode ?? 502,outgoing);
      const contentType=String(response.headers['content-type']??'');
      const encoded=Boolean(response.headers['content-encoding'] && response.headers['content-encoding']!=='identity');
      const observe=!encoded && (contentType.includes('json')||contentType.includes('event-stream'));
      const parser=new StreamObserver(v=>{mergeEvidence(entry,v);this.receive({...entry,candidates:[...entry.candidates]});},contentType.includes('event-stream')?'sse':'json');
      response.on('data',chunk=>{if(observe)parser.push(chunk);});
      response.on('end',()=>{if(observe)parser.finish();entry.state=(response.statusCode??500)>=400?'error':'complete';this.receive(entry);});
      response.on('error',()=>{entry.state='error';this.receive(entry);res.destroy();});
      response.pipe(res);
    });
    upstream.on('error',()=>{entry.state='error';this.receive(entry);if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end('{"error":"model_checker_upstream_unavailable"}');});
    req.on('data',chunk=>requestObserver.push(chunk)); req.on('end',()=>requestObserver.finish());
    req.on('aborted',()=>{entry.state='cancelled';this.receive(entry);upstream.destroy();});
    res.on('close',()=>{if(!res.writableEnded){entry.state='cancelled';this.receive(entry);upstream.destroy();}});
    req.pipe(upstream);
  }
  private forwardWebSocket(req: http.IncomingMessage, client: WebSocket, target: URL): void {
    this.activity(); target.protocol=target.protocol==='https:'?'wss:':'ws:';
    const headers: Record<string,string>={};
    for(const [key,value]of Object.entries(req.headers)) if(typeof value==='string'&&!stripped.has(key)&&!key.startsWith('sec-websocket-'))headers[key]=value;
    const protocols=String(req.headers['sec-websocket-protocol']??'').split(',').map(s=>s.trim()).filter(Boolean);
    const remote=new WebSocket(target,protocols,{headers,perMessageDeflate:false,maxPayload:64*1024*1024});
    const connection=randomUUID(); const pending: Observation[]=[]; const active=new Map<string,Observation>(); let current: Observation | undefined;
    const parse=(data: RawData): unknown=>{try{return JSON.parse(data.toString());}catch{return null;}};
    const report=(entry:Observation)=>this.receive({...entry,candidates:[...entry.candidates]});
    const buffered: Array<{data:RawData;binary:boolean}>=[];let bufferedBytes=0;
    client.on('message',(data,binary)=>{
      const value=parse(data); const requested=requestModel(value);
      if(requested || (value && typeof value==='object' && 'type' in value && value.type==='response.create')){
        const entry=this.entry('websocket',connection);entry.requested=requested;entry.requestEvidence=requested?'wire':'missing';pending.push(entry);report(entry);
      }
      if(remote.readyState===WebSocket.OPEN)remote.send(data,{binary});
      else if(remote.readyState===WebSocket.CONNECTING){bufferedBytes+=data.toString().length;if(bufferedBytes>64*1024*1024){client.close(1009);remote.terminate();}else buffered.push({data,binary});}
    });
    remote.on('open',()=>{for(const item of buffered)remote.send(item.data,{binary:item.binary});buffered.length=0;});
    remote.on('message',(data,binary)=>{
      const value=parse(data),found=evidence(value);
      const responseId=found.responseId??(value&&typeof value==='object'&&'response_id'in value&&typeof value.response_id==='string'?value.response_id:undefined);
      if(responseId){
        current=active.get(responseId);
        if(!current){current=pending.shift()??this.entry('websocket',connection);active.set(responseId,current);}
      }
      else if(active.size>1)current=undefined;
      if(current){mergeEvidence(current,value);report(current);if(found.done){if(responseId)active.delete(responseId);current=undefined;}}
      if(client.readyState===WebSocket.OPEN)client.send(data,{binary});
    });
    const finish=(state:'error'|'cancelled')=>{for(const entry of new Set([...pending,...active.values()])){entry.state=state;report(entry);}pending.length=0;active.clear();};
    const close=(peer:WebSocket,code:number,reason:Buffer)=>{if(peer.readyState===WebSocket.OPEN)peer.close(code===1005||code===1006?1011:code,reason);else if(peer.readyState===WebSocket.CONNECTING)peer.terminate();};
    client.on('close',(code,reason)=>{finish('cancelled');close(remote,code,reason);});
    remote.on('close',(code,reason)=>{finish('error');close(client,code,reason);});
    client.on('error',()=>{finish('error');remote.terminate();});remote.on('error',()=>{finish('error');client.close(1011);});
  }
  async start(port=PROXY_PORT):Promise<void>{await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});}
  async stop():Promise<void>{for(const c of this.wss.clients)c.terminate();for(const s of this.sockets)s.destroy();await new Promise<void>(resolve=>this.server.close(()=>resolve()));}
}

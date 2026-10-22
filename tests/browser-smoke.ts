import {chromium,expect} from '@playwright/test';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Bridge} from '../src/main/bridge';
import {assess} from '../src/core/assessment';
import type {Observation} from '../src/core/types';
async function main(){
  const dir=mkdtempSync(join(tmpdir(),'cmc-browser-')),observations:Observation[]=[];
  const bridge=new Bridge(dir,o=>observations.push(structuredClone(o)),()=>{},()=>{});await bridge.start();bridge.renew();
  const extension=resolve('dist/extension');
  let context:Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try{context=await chromium.launchPersistentContext(join(dir,'profile'),{
    ...(process.env.CMC_BROWSER_PATH?{executablePath:process.env.CMC_BROWSER_PATH}:{channel:process.env.CMC_BROWSER_CHANNEL??'chromium'}),
    headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
  });}catch(error){await bridge.stop();throw error;}
  try{
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker',{timeout:15000});
    const id=new URL(worker.url()).host;const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.locator('input').fill(bridge.pairing.code);await popup.getByRole('button',{name:'连接桌面窗口'}).click();await expect(popup.locator('#status')).toContainText('配对成功');
    const bodies:string[]=[];
    await context.route('https://chatgpt.com/**',async route=>{
      const req=route.request();
      if(req.url().includes('/backend-api/conversation')&&req.method()==='POST'){
        bodies.push(req.postData()??'');await route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({type:'server_ste_metadata',metadata:{model_slug:'gpt-6-luna'}})+'\n\n'+'data: [DONE]\n\n'});
      }else if(req.url().includes('/backend-api/conversation/')){
        await route.fulfill({contentType:'application/json',body:JSON.stringify({mapping:{node:{message:{author:{role:'assistant'},metadata:{model_slug:'gpt-6-astra'},content:{parts:['private answer']}}}}})});
      }else await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Offline ChatGPT fixture</title><h1>Fixture</h1>'});
    });
    await context.routeWebSocket('wss://ws.chatgpt.com/fixture',socket=>{socket.onMessage(()=>{socket.send(JSON.stringify({type:'response.created',response:{id:'ws-fixture',model:'gpt-6-luna'}}));socket.send(JSON.stringify({type:'response.completed',response:{id:'ws-fixture',model:'gpt-6-luna'}}));});});
    const pages=await Promise.all([context.newPage(),context.newPage()]);
    for(const page of pages){page.on('pageerror',e=>console.log('fixture page error:',e.message));}
    await Promise.all(pages.map(p=>p.goto('https://chatgpt.com/')));
    const response=await pages[0].evaluate(async()=>{const body=JSON.stringify({model:'gpt-6-astra',messages:[{text:'private prompt'}]});const response=await fetch('/backend-api/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body});return response.text();});
    await pages[1].evaluate(async()=>{const request=new Request(location.origin+'/backend-api/conversation',{method:'POST',body:JSON.stringify({model:'gpt-6-astra'})});return(await fetch(request)).text();});
    try{await expect.poll(()=>observations.filter(o=>o.state==='complete'&&o.transport==='fetch').length).toBe(2);}catch(error){console.log('Capture diagnostics:',await pages[0].evaluate(()=>({hook:Boolean((window as unknown as Record<string,unknown>).__codex_model_checker_hook_v1__),fetch:window.fetch.toString().slice(0,100)})),observations.map(o=>({state:o.state,transport:o.transport})),bridge.connected());throw error;}
    const complete=observations.filter(o=>o.state==='complete');assert(complete.every(o=>assess(o).astraAlert),'Astra mismatch must be detected');assert(new Set(complete.map(o=>o.connection)).size===2,'Separate tab identity');assert(response.includes('gpt-6-luna'),'Original response unchanged');assert(bodies.some(b=>b.includes('private prompt')),'Original request unchanged');assert(!JSON.stringify(observations).includes('private prompt'),'Prompt must not be stored');
    await pages[0].evaluate(async()=>{await(await fetch('/backend-api/conversation/fixture')).json();});
    await expect.poll(()=>observations.some(o=>o.transport==='history')).toBe(true);assert(observations.filter(o=>o.transport==='history').every(o=>assess(o).verdict==='unknown'),'History labels cannot prove a model match');
    await pages[0].reload();await pages[0].evaluate(async()=>{await(await fetch('/backend-api/conversation',{method:'POST',body:'{"model":"gpt-6-astra"}'})).text();});
    await expect.poll(()=>observations.filter(o=>o.state==='complete'&&o.transport==='fetch').length).toBe(3);
    await pages[0].evaluate(async()=>{await new Promise<void>(resolve=>{const socket=new WebSocket('wss://ws.chatgpt.com/fixture');socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'response.create',model:'gpt-6-astra'})));let count=0;socket.addEventListener('message',()=>{if(++count===2){socket.close();resolve();}});});});
    await expect.poll(()=>observations.some(o=>o.transport==='websocket'&&assess(o).astraAlert)).toBe(true);
    mkdirSync('test-results',{recursive:true});await popup.screenshot({path:'test-results/browser-pairing.png'});
    console.log('Browser extension pairing, fetch/Request, SSE, two tabs, history reload and privacy passed.');
  }finally{await context.close();await bridge.stop();}
}
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
void main().catch(error=>{console.error(error);process.exitCode=1;});

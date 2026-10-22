import { sanitizeObservation } from '../core/capture';
window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='codex-model-checker-v1')return;
  const entry=sanitizeObservation(event.data.entry,'chatgpt');
  if(entry)void chrome.runtime.sendMessage({type:'observation',entry}).catch(()=>{});
});
void chrome.runtime.sendMessage({type:'opened'}).catch(()=>{});
setInterval(()=>void chrome.runtime.sendMessage({type:'heartbeat'}).catch(()=>{}),15000);

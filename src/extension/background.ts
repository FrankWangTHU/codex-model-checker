import { sanitizeObservation } from '../core/capture';
const base='http://127.0.0.1:43821';
const live=new Map<number,number>();
const valid=(url?:string)=>{try{const u=new URL(url??'');return u.protocol==='https:'&&['chatgpt.com','chat.openai.com'].includes(u.hostname);}catch{return false;}};
async function post(path:string,value:unknown):Promise<boolean>{
  const {token}=await chrome.storage.local.get('token');if(typeof token!=='string')return false;
  try{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(value),signal:AbortSignal.timeout(3000)});if(response.status===401)await chrome.storage.local.remove('token');return response.ok;}catch{return false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.tab&&valid(sender.url)){
    if(message.type==='opened'||message.type==='heartbeat'){
      if(sender.tab.id!==undefined)live.set(sender.tab.id,Date.now());
      void post('/presence',{open:true,opened:message.type==='opened'});reply({ok:true});
    }else if(message.type==='observation'){
      const entry=sanitizeObservation(message.entry,'chatgpt');if(entry)void post('/events',entry);
    }
    return false;
  }
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return false;
  if(message.type==='pair'){
    void(async()=>{
      try{
        if(!/^\d{8}$/.test(message.code))throw new Error('请输入 8 位配对码');
        const response=await fetch(base+'/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:message.code}),signal:AbortSignal.timeout(3000)});
        if(!response.ok)throw new Error(response.status===429?'尝试过多，请稍后重试':'配对失败：请检查配对码是否过期');
        const data=await response.json();await chrome.storage.local.set({token:data.token});reply({ok:true});
      }catch(error){reply({ok:false,error:error instanceof Error?error.message:'请先打开桌面程序'});}
    })();return true;
  }
  if(message.type==='status'){void chrome.storage.local.get('token').then(data=>reply({paired:Boolean(data.token)}));return true;}
  return false;
});
chrome.tabs.onRemoved.addListener(id=>{live.delete(id);if(live.size===0)void post('/presence',{open:false});});
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url&&!valid(change.url)){live.delete(id);if(live.size===0)void post('/presence',{open:false});}});

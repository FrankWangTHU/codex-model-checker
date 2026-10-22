export {};
const form=document.querySelector('form')!;
const status=document.querySelector('#status')!;
void chrome.runtime.sendMessage({type:'status'}).then(data=>{status.textContent=data.paired?'已配对 · 桌面程序开启时自动连接':'请在桌面程序中生成配对码';});
form.addEventListener('submit',event=>{event.preventDefault();const code=(document.querySelector('input')as HTMLInputElement).value;status.textContent='正在连接…';void chrome.runtime.sendMessage({type:'pair',code}).then(data=>{status.textContent=data.ok?'配对成功，请刷新已打开的 ChatGPT 页面':data.error;}).catch(()=>{status.textContent='连接失败，请打开桌面程序';});});

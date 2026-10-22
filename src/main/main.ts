import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, Notification, dialog, screen } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Store } from './store';
import { Bridge } from './bridge';
import { SessionWatcher } from './logs';
import { ModelProxy, PROXY_PORT } from './proxy';
import { ProxyConfig } from './config';
import type { Snapshot, RecordEntry } from '../core/types';
app.setName('Codex Model Checker');
const dataPath=(!app.isPackaged&&process.env.CMC_DATA_DIR)||join(app.getPath('appData'),'Codex Model Checker');app.setPath('userData',dataPath);
const config=new ProxyConfig(join(process.env.CODEX_HOME||join(homedir(),'.codex'),'config.toml'),dataPath);
if(process.argv.includes('--restore-proxy')){
  try{config.restore();app.exit(0);}catch{app.exit(2);}
}else if(!app.requestSingleInstanceLock())app.quit();
else{
  let win:BrowserWindow|undefined,tray:Tray|undefined,proxy:ModelProxy|undefined,watcher:SessionWatcher|undefined,store:Store,bridge:Bridge;
  let quitting=false,processBusy=false,codexRunning=false,expanded=false,previousActive=false;
  let processTimer:NodeJS.Timeout|undefined;
  const status={codex:'等待 Codex',chatgpt:'未连接扩展',proxy:'未启用增强采集'};
  const show=()=>{if(win&&!win.isDestroyed()){win.showInactive();}};
  const snapshot=():Snapshot=>({records:store.records.slice(0,500),settings:store.settings,status:{...status,chatgpt:bridge.connected()?'扩展已连接':'未连接扩展'},pairing:bridge.pairing,proxyEnabled:Boolean(proxy)});
  let publishTimer:NodeJS.Timeout|undefined;
  const publish=()=>{if(!publishTimer)publishTimer=setTimeout(()=>{publishTimer=undefined;if(win&&!win.isDestroyed())win.webContents.send('snapshot',snapshot());},100);};
  const receive=(entry:RecordEntry|Parameters<Store['upsert']>[0])=>store.upsert(entry);
  function menu():void{
    tray?.setContextMenu(Menu.buildFromTemplate([
      {label:'显示小窗',click:()=>{win?.show();}},
      {label:'窗口置顶',type:'checkbox',checked:store.settings.alwaysOnTop,click:item=>{store.settings.alwaysOnTop=item.checked;win?.setAlwaysOnTop(item.checked);store.saveSettings();menu();}},
      {label:'登录时启动',type:'checkbox',checked:store.settings.login,click:item=>{store.settings.login=item.checked;app.setLoginItemSettings({openAtLogin:item.checked,args:['--background']});store.saveSettings();menu();}},
      {label:'恢复 Codex 配置',enabled:Boolean(config.backup()),click:()=>void disableProxy().catch(error=>dialog.showErrorBox('恢复失败',String(error.message)))},
      {type:'separator'}, {label:'彻底退出',click:()=>app.quit()}
    ]));
  }
  async function enableProxy():Promise<void>{
    if(proxy)return;
    let backup=config.backup();
    if(!backup)backup=config.enable(PROXY_PORT);
    const instance=new ModelProxy(backup.upstream,backup.token,entry=>{status.proxy='代理已捕获流量';receive(entry);},()=>{status.proxy='代理已捕获流量';show();publish();});
    try{await instance.start();proxy=instance;status.proxy='代理已就绪 · 请重启 Codex，等待实际流量';}
    catch{config.restore();throw new Error('代理端口 43822 被占用，已恢复 Codex 配置。');}
    menu();publish();
  }
  async function disableProxy():Promise<void>{config.restore();await proxy?.stop();proxy=undefined;status.proxy='已恢复配置 · 请重启 Codex';menu();publish();}
  function resize():void{if(!win)return;const height=expanded?650:store.settings.collapsed?100:260;win.setMinimumSize(360,height);win.setSize(expanded?760:360,height);}
  function checkProcesses():void{
    if(processBusy||process.platform!=='win32')return;processBusy=true;
    execFile('tasklist.exe',['/FI','IMAGENAME eq Codex.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:2500},(error,stdout)=>{
      processBusy=false;const running=!error&&/^"Codex\.exe"/im.test(stdout);
      if(running&&!codexRunning)show();codexRunning=running;
      const active=running||bridge.connected();if(!active&&previousActive)win?.hide();previousActive=active;publish();
    });
  }
  app.on('second-instance',()=>win?.show());
  app.whenReady().then(async()=>{
    app.setAppUserModelId('com.frankwangthu.codex-model-checker');
    store=new Store(dataPath);
    bridge=new Bridge(dataPath,receive,show,publish);
    await bridge.start().catch(()=>{status.chatgpt='桥接端口 43821 被占用';});
    const saved=store.settings.bounds,areas=screen.getAllDisplays().map(d=>d.workArea);
    const visible=saved&&areas.some(a=>saved.x>=a.x&&saved.y>=a.y&&saved.x+360<=a.x+a.width&&saved.y+100<=a.y+a.height);
    const area=screen.getPrimaryDisplay().workArea;
    win=new BrowserWindow({width:360,height:store.settings.collapsed?100:260,x:visible?saved.x:area.x+area.width-384,y:visible?saved.y:area.y+40,minWidth:360,minHeight:100,frame:false,backgroundColor:'#ffffff',show:false,resizable:false,alwaysOnTop:store.settings.alwaysOnTop,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
    win.on('close',event=>{if(!quitting){event.preventDefault();win?.hide();}});
    win.on('move',()=>{if(win&&!expanded){store.settings.bounds=win.getBounds();store.saveSettings();}});
    win.webContents.on('did-finish-load',()=>{publish();if(!process.argv.includes('--background'))win?.show();});
    tray=new Tray(nativeImage.createFromPath(join(__dirname,'icon.png')));
    tray.setToolTip('Codex Model Checker');tray.on('click',()=>win?.show());menu();
    store.on('change',publish);store.on('alert',(entry:RecordEntry)=>{show();if(store.settings.notifications&&Notification.isSupported())new Notification({title:'Astra 模型标识不一致',body:`请求 ${entry.requested}；响应 ${entry.candidates.filter(c=>c.kind==='route').map(c=>c.model).join(' / ')}`,silent:true}).show();});
    watcher=new SessionWatcher(join(process.env.CODEX_HOME||join(homedir(),'.codex'),'sessions'),receive,text=>{status.codex=text;publish();});watcher.start();
    if(app.isPackaged)app.setLoginItemSettings({openAtLogin:store.settings.login,args:['--background']});
    if(config.backup())await enableProxy().catch(error=>{status.proxy=error.message;publish();});
    processTimer=setInterval(checkProcesses,3000);checkProcesses();
    ipcMain.handle('command',async(event,command:string,value:unknown)=>{
      if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('Unauthorized renderer');
      try{
        if(command==='snapshot')return snapshot();
        if(command==='hide')win.hide();
        else if(command==='pair')bridge.renew();
        else if(command==='expand'){expanded=value===true;resize();}
        else if(command==='collapse'){store.settings.collapsed=!store.settings.collapsed;expanded=false;resize();store.saveSettings();}
        else if(command==='top'){store.settings.alwaysOnTop=!store.settings.alwaysOnTop;win.setAlwaysOnTop(store.settings.alwaysOnTop);store.saveSettings();menu();}
        else if(command==='login'){store.settings.login=!store.settings.login;app.setLoginItemSettings({openAtLogin:store.settings.login,args:['--background']});store.saveSettings();menu();}
        else if(command==='notifications'){store.settings.notifications=!store.settings.notifications;store.saveSettings();}
        else if(command==='proxy-on')await enableProxy();
        else if(command==='proxy-off')await disableProxy();
        else if(command==='clear')store.clear();
        else if(command==='export'){
          const target=await dialog.showSaveDialog(win,{defaultPath:'model-evidence.json',filters:[{name:'JSON',extensions:['json']}]});
          if(!target.canceled&&target.filePath)await writeFile(target.filePath,JSON.stringify(store.records,null,2),'utf8');
        }
        publish();return {ok:true};
      }catch(error){return {ok:false,error:error instanceof Error?error.message:'操作失败'};}
    });
    await win.loadFile(join(__dirname,'ui','index.html'));
  }).catch(error=>{dialog.showErrorBox('Model Checker 启动失败',error.message);app.exit(1);});
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{
    if(quitting)return;event.preventDefault();
    try{config.restore();}catch(error){dialog.showErrorBox('请先恢复 Codex 配置',String((error as Error).message));return;}
    quitting=true;clearInterval(processTimer);clearTimeout(publishTimer);watcher?.stop();store?.flush();
    void Promise.allSettled([proxy?.stop(),bridge?.stop()]).finally(()=>app.quit());
  });
}

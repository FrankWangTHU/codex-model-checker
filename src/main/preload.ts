import { contextBridge,ipcRenderer } from 'electron';
import type { Snapshot } from '../core/types';
contextBridge.exposeInMainWorld('checker',{
  command:(command:string,value?:unknown)=>ipcRenderer.invoke('command',command,value),
  subscribe:(callback:(snapshot:Snapshot)=>void)=>{const handler=(_event:Electron.IpcRendererEvent,data:Snapshot)=>callback(data);ipcRenderer.on('snapshot',handler);return()=>ipcRenderer.removeListener('snapshot',handler);}
});

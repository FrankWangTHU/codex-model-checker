import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';

// Task Scheduler runs outside the Codex process job, so closing the desktop
// cannot kill its own restart helper. There is no persistent scheduled task.
export async function scheduleDesktopRestart(directory:string,scripts:string,mode:'Diagnostic'|'Normal'){
  if(process.platform!=='win32')throw new Error('桌面诊断启动仅支持 Windows。');
  await mkdir(directory,{recursive:true});
  for(const name of ['schedule-desktop-diagnostic.ps1','restart-desktop-diagnostic.ps1','start-desktop-diagnostic.ps1'])await copyFile(join(scripts,name),join(directory,name));
  await promisify(execFile)(join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(directory,'schedule-desktop-diagnostic.ps1'),'-ReportRoot',directory,'-Mode',mode],{windowsHide:true,timeout:20000,maxBuffer:65536});
}

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { windowsAppCommand } from './window-launcher.mjs';
import { chimeWav } from './notifications.mjs';

// Drives scripts/notifier.ps1, a small WPF helper that owns the popup, the
// chime and the taskbar flash. It starts on the first notification and exits
// after a quiet spell. Messages are base64 JSON lines, so Chinese text never
// depends on the console code page.
const IDLE_MS=15*60*1000;
export const WINDOW_TITLES=['星港 · Starport','Starport · 星港'];

export class WindowsNotifier{
  constructor({root,dataDir,url,spawnProcess=spawn,platform=process.platform}){
    Object.assign(this,{root,dataDir,url,spawnProcess});
    this.script=join(root,'scripts','notifier.ps1');
    this.available=platform==='win32'&&existsSync(this.script);
    this.child=null;this.idle=null;this.onOpen=null;
  }
  chime(){
    const file=join(this.dataDir,'notify-chime.wav');
    if(!existsSync(file)){mkdirSync(this.dataDir,{recursive:true});writeFileSync(file,chimeWav());}
    return file;
  }
  icon(){return join(this.root,'public','assets','starport-desktop-azure.ico');}
  start(){
    if(this.child)return this.child;
    const child=this.spawnProcess('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-STA','-File',this.script],
      {stdio:['pipe','pipe','ignore'],windowsHide:true});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{if(this.child===child)this.child=null;});
    child.on('exit',()=>{if(this.child===child)this.child=null;});
    createInterface({input:child.stdout}).on('line',line=>{
      try{const message=JSON.parse(line);if(message.type==='open')this.onOpen?.(message);}catch{}
    });
    this.child=child;return child;
  }
  send(message){
    const child=this.start();
    child.stdin.write(Buffer.from(JSON.stringify(message),'utf8').toString('base64')+'\n');
    clearTimeout(this.idle);this.idle=setTimeout(()=>this.stop(),IDLE_MS);this.idle.unref?.();
  }
  show(item){
    let launch=null;
    try{launch=windowsAppCommand(this.url());}catch{}
    this.send({type:'show',...item,titles:WINDOW_TITLES,chime:item.sound?this.chime():'',icon:this.icon(),launch});
  }
  dismiss(){if(this.child)this.send({type:'dismiss'});}
  stop(){
    const child=this.child;this.child=null;clearTimeout(this.idle);
    if(!child)return;
    try{child.stdin.end();}catch{}
    setTimeout(()=>{try{child.kill();}catch{}},2000).unref();
  }
  close(){this.stop();}
}

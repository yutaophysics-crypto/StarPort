import { spawn } from 'node:child_process';
import { mkdirSync,openSync,closeSync,readdirSync,readFileSync,statSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { defaultAccountCenter } from './account-config.mjs';
import { canRestart,readHubSnapshot,stopServer,scheduleIdleRestart } from './restart-when-idle.mjs';
import { findMacApp } from './macos-app.mjs';
import { readLocalServices, localServicesEnvironment } from './local-services.mjs';
import { windowsAppCommand } from '../src/window-launcher.mjs';
const root=resolve(import.meta.dirname,'..'),port=Number(process.env.HARNESS_HUB_PORT||3210),url=`http://127.0.0.1:${port}`,data=process.env.HARNESS_HUB_DATA||join(root,'.data');
const localServices=readLocalServices(root);
Object.assign(process.env,localServicesEnvironment(localServices));
const accountCenter=defaultAccountCenter(root);if(accountCenter)process.env.STARPORT_ACCOUNT_URL=accountCenter;
const desktop=process.platform==='darwin'&&!process.argv.includes('--no-open')?findMacApp(root,{port}):null;
if(desktop){
  const app=spawn('open',['-a',desktop],{stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{app.once('error',reject);app.once('exit',resolve);});
  process.exit(code||0);
}
async function health(){try{const response=await fetch(url+'/health',{signal:AbortSignal.timeout(1200)});const data=await response.json();if(data.app!=='harness-hub'||resolve(data.root)!==root)throw new Error('端口被其他程序占用，请设置 HARNESS_HUB_PORT');return data;}catch(error){if(error.message.includes('端口'))throw error;return null;}}
function codeTime(dir=join(root,'src')){let latest=0;for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);latest=Math.max(latest,entry.isDirectory()?codeTime(path):statSync(path).mtimeMs);}return latest;}
// Older servers report no pid or start time; their server.json is written as soon as they listen.
function identity(running){
  if(Number.isSafeInteger(running.pid)&&running.startedAt)return {pid:running.pid,startedAt:running.startedAt};
  try{const file=join(data,'server.json'),saved=JSON.parse(readFileSync(file,'utf8'));if(saved.port===port&&resolve(saved.root)===root&&Number.isSafeInteger(saved.pid))return {pid:saved.pid,startedAt:statSync(file).mtimeMs};}catch{}
  return null;
}
// Reopening Starport only reconnects to the running server, so a server older than the code on disk is
// restarted here. It is never stopped while a conversation or workflow is running.
async function restartIfStale(running){
  const current=identity(running);if(!current||current.startedAt>=codeTime())return;
  for(let check=0;check<2;check++){
    if(check)await new Promise(resolve=>setTimeout(resolve,1000));
    let snapshot;try{snapshot=await readHubSnapshot(url,root);}catch{return;}
    if(identity(snapshot.health)?.pid!==current.pid)return;
    if(!canRestart(snapshot,root)){scheduleIdleRestart(root,data,port);console.log('星港服务待更新，已安排在所有对话和工作流结束后自动重启；无需反复关闭窗口。');return;}
  }
  await stopServer(current.pid);
  for(let attempt=0;attempt<40&&await health();attempt++)await new Promise(resolve=>setTimeout(resolve,250));
  console.log('已停止旧版本的星港服务。');
}
const running=await health();if(running)await restartIfStale(running);
if(!await health()){
  mkdirSync(data,{recursive:true});
  const output=openSync(join(data,'server.log'),'a');
  const child=spawn(process.execPath,[join(root,'src/server.mjs')],{cwd:root,detached:true,stdio:['ignore',output,output],windowsHide:true});child.unref();closeSync(output);
  let ready=false;for(let attempt=0;attempt<40;attempt++){await new Promise(resolve=>setTimeout(resolve,250));if(await health()){ready=true;break;}}
  if(!ready)throw new Error('工作台未能启动，请查看 .data/server.log');
}
if(!process.argv.includes('--no-open')){
  let command,args;
  if(process.platform==='win32'){
    const window=windowsAppCommand(url);command=window?.command||'rundll32.exe';args=window?.args||['url.dll,FileProtocolHandler',url];
  }else{command=process.platform==='darwin'?'open':'xdg-open';args=[url];}
  const browser=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true});browser.unref();
}
console.log(url);

import { readFile, writeFile, open, unlink, rename } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A one-shot local updater for a server that cannot reload adapters mid-run.
// Reads current activity through the authenticated API. It never sends a chat,
// cancels a turn, or kills a process tree. A changed server identity aborts it.
export function canRestart(snapshot,expectedRoot){
  const workflowsIdle=snapshot?.workflows==null||Array.isArray(snapshot.workflows.running)&&snapshot.workflows.running.length===0;
  const profilesIdle=snapshot?.profiles==null||Array.isArray(snapshot.profiles.profiles)&&!snapshot.profiles.profiles.some(profile=>profile.connection?.jobId);
  return snapshot?.health?.app==='harness-hub'&&typeof snapshot.health.root==='string'&&resolve(snapshot.health.root)===resolve(expectedRoot)&&Array.isArray(snapshot.state?.active)&&snapshot.state.active.length===0&&!snapshot.state.collaboration?.jobId&&workflowsIdle&&profilesIdle;
}
// A server from before the workflow engine answers 404 for its state; it has no workflow runs.
export async function readHubSnapshot(base,root){
  const health=await (await fetch(base+'/health',{signal:AbortSignal.timeout(3000)})).json();
  if(health.app!=='harness-hub'||resolve(health.root)!==resolve(root))throw new Error('Server identity mismatch');
  const html=await (await fetch(base+'/',{signal:AbortSignal.timeout(3000)})).text();
  const token=html.match(/name="hub-token" content="([^"]+)"/)?.[1];if(!token)throw new Error('Missing server token');
  const headers={'X-Hub-Token':token};
  const response=await fetch(base+'/api/state',{headers,signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('Cannot confirm idle state');
  const flows=await fetch(base+'/api/workflows/state',{headers,signal:AbortSignal.timeout(5000)});
  if(!flows.ok&&flows.status!==404)throw new Error('Cannot confirm idle state');
  const profiles=await fetch(base+'/api/collaboration/profiles',{headers,signal:AbortSignal.timeout(5000)});
  if(!profiles.ok&&profiles.status!==404)throw new Error('Cannot confirm account worker state');
  return {health,state:await response.json(),workflows:flows.ok?await flows.json():null,profiles:profiles.ok?await profiles.json():null};
}
export async function stopServer(pid){
  if(process.platform==='win32')await promisify(execFile)('taskkill.exe',['/PID',String(pid),'/F'],{windowsHide:true});
  else process.kill(pid,'SIGTERM');
}
export async function waitForIdle(readSnapshot,{root,wait,checks=3,maxChecks=43200}={}){
  let idle=0;
  for(let count=0;count<maxChecks;count++){
    let snapshot;try{snapshot=await readSnapshot();}catch{idle=0;await wait();continue;}
    if(canRestart(snapshot,root)){if(++idle>=checks)return snapshot;}else idle=0;
    await wait();
  }
  throw new Error('Idle restart expired without stopping any process');
}
// A single watcher per data directory. The lock never grants permission to stop a busy server.
export async function acquireRestartLock(data,{alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}}={}){
  const file=join(data,'idle-restart.lock'),owner={pid:process.pid,id:randomUUID()};
  for(let attempt=0;attempt<2;attempt++){
    let handle;
    try{handle=await open(file,'wx');await handle.writeFile(JSON.stringify(owner));await handle.close();
      return async()=>{try{const current=JSON.parse(await readFile(file,'utf8'));if(current.id===owner.id)await unlink(file);}catch{}};
    }catch(error){await handle?.close().catch(()=>{});if(error.code!=='EEXIST')throw error;
      // A fresh empty lock may belong to a watcher that has not finished writing yet.
      let current;try{current=JSON.parse(await readFile(file,'utf8'));}catch{return null;}
      if(Number.isSafeInteger(current.pid)&&alive(current.pid))return null;
      await unlink(file).catch(()=>{});
    }
  }
  return null;
}
export function scheduleIdleRestart(root,data,port){
  const output=openSync(join(data,'idle-restart.log'),'a');
  try{const child=spawn(process.execPath,[join(root,'scripts','restart-when-idle.mjs')],{cwd:root,env:{...process.env,HARNESS_HUB_PORT:String(port),HARNESS_HUB_DATA:data},detached:true,windowsHide:true,stdio:['ignore',output,output]});child.on('error',()=>{});child.unref();return child.pid;}
  finally{closeSync(output);}
}
async function main(){
  const root=resolve(import.meta.dirname,'..'),data=process.env.HARNESS_HUB_DATA||join(root,'.data');
  const config=JSON.parse(await readFile(join(data,'server.json'),'utf8'));
  const release=await acquireRestartLock(data);if(!release)return;
  const statusFile=join(data,'subagent-update.json'),publicFile=join(root,'public',`runtime-update-${config.port}.json`);
  const record=async(state,snapshot)=>{
    const at=new Date().toISOString();
    await writeFile(statusFile,JSON.stringify({state,at,pid:config.pid,port:config.port,watcherPid:process.pid},null,2));
    const temp=publicFile+'.'+process.pid+'.tmp';
    try{await writeFile(temp,JSON.stringify({state,at,serverPid:config.pid,active:snapshot?.state?.active?.length??null,workflows:snapshot?.workflows?.running?.length??null}));await rename(temp,publicFile);}finally{await unlink(temp).catch(()=>{});}
  };
  if(resolve(config.root)!==root||!Number.isSafeInteger(config.pid)||config.pid<=0)throw new Error('Server identity mismatch');
  const base=`http://127.0.0.1:${config.port}`;
  const readSnapshot=async()=>{
    const identity=JSON.parse(await readFile(join(data,'server.json'),'utf8'));
    if(identity.pid!==config.pid||identity.port!==config.port||resolve(identity.root)!==root)throw Object.assign(new Error('Server already changed'),{changed:true});
    const snapshot=await readHubSnapshot(base,root);await record('waiting-for-idle',snapshot);return snapshot;
  };
  await record('waiting-for-idle');
  try{
    await waitForIdle(async()=>{try{return await readSnapshot();}catch(error){if(error.changed){await record('server-already-changed');process.exit(0);}throw error;}},{root,wait:()=>new Promise(resolve=>setTimeout(resolve,5000))});
    // Recheck immediately before acting, after at least ten seconds idle.
    if(!canRestart(await readSnapshot(),root)){await record('restart-deferred');return;}
    await record('restarting');
    await stopServer(config.pid);
    const launcher=spawn(process.execPath,[join(root,'scripts','launch.mjs'),'--no-open'],{cwd:root,env:{...process.env,HARNESS_HUB_PORT:String(config.port),HARNESS_HUB_DATA:data},windowsHide:true,stdio:'ignore'});
    const code=await new Promise((resolve,reject)=>{launcher.once('error',reject);launcher.once('exit',resolve);});
    if(code!==0)throw new Error('Launcher failed');
    await record('updated');
  }catch(error){await record('error');throw error;}finally{await release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});

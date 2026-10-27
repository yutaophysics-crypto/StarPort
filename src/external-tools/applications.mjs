// Persistent applications (an editor or dev server kept open across turns).
// A detached daemon owns each one through a named Windows Job, so neither the
// model turn nor a Starport restart ends it. Control targets that random job
// name, never a saved PID. Each application has a private record directory:
// request.json, status.json (daemon heartbeat), stdout/stderr logs.
import {mkdir,readFile,writeFile,readdir,open} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {restrictToCurrentUser,writePrivateFile,stopProcess,redact} from '../process.mjs';
import {toolPathKey,canonicalToolPath} from './grants.mjs';
import {externalEnvironment,spawnLauncher} from './processes.mjs';

const DAEMON=fileURLToPath(new URL('../../scripts/external-application-daemon.mjs',import.meta.url));
const ISOLATION='Host Windows user; managed persistent application; survives model turns and Starport restarts; close explicitly by application id';
const MAX_LIVE=8;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENDED=['exited','error','stopped'];
// An application in any of these states may still own processes.
export const isLive=row=>['running','starting','unknown'].includes(row.state);

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const jobName=id=>'Local\\StarportExternal-'+id;
const canceled=()=>Error('本次运行已取消');
const writeStatus=(directory,state)=>{const status={state,updatedAt:Date.now()};return writeFile(join(directory,'status.json'),JSON.stringify(status)).then(()=>status);};
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch{return null;}}
async function tail(file){
  let handle;
  try{handle=await open(file,'r');const stat=await handle.stat(),buffer=Buffer.alloc(Math.min(6000,stat.size));await handle.read(buffer,0,buffer.length,Math.max(0,stat.size-buffer.length));return redact(buffer.toString('utf8'));}catch{return '';}finally{await handle?.close();}
}
const logs=async directory=>({stdout:await tail(join(directory,'stdout.log')),stderr:await tail(join(directory,'stderr.log'))});

export class ExternalApplicationManager {
  constructor(dataDir){this.root=resolve(dataDir,'external-applications');this.queue=Promise.resolve();}
  directory(id){
    if(!UUID.test(id))throw Object.assign(Error('程序记录不存在'),{status:404});
    const path=join(this.root,id);
    if(existsSync(path)&&toolPathKey(realpathSync.native(path))!==toolPathKey(path))throw Error('程序记录路径已变化');
    return path;
  }
  // This project's applications, live ones first, then newest first.
  async list(workspace){
    const key=toolPathKey(canonicalToolPath(workspace));let entries;try{entries=await readdir(this.root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const rows=[];
    for(const entry of entries){
      if(!entry.isDirectory()||!UUID.test(entry.name))continue;
      const path=this.directory(entry.name),saved=await readJson(join(path,'request.json'));
      if(!saved||toolPathKey(saved.workspace)!==key)continue;
      // No status yet means the daemon is still starting; a stale heartbeat means it may have died.
      const status=await readJson(join(path,'status.json'))||{state:Date.now()-saved.createdAt<20000?'starting':'unknown'};
      if(status.state==='running'&&Date.now()-status.updatedAt>15000)status.state='unknown';
      rows.push({id:entry.name,toolId:saved.toolId,tool:saved.tool,executable:saved.executable,args:saved.args,cwd:saved.cwd,createdAt:saved.createdAt,...status});
    }
    return rows.sort((a,b)=>Number(isLive(b))-Number(isLive(a))||b.createdAt-a.createdAt).slice(0,100);
  }
  async stop(workspace,id){
    const row=(await this.list(workspace)).find(item=>item.id===id);if(!row)throw Object.assign(Error('当前项目没有这个常驻程序'),{status:404});
    const directory=this.directory(id);
    // A startup still compiling its launcher must also observe this request;
    // the named Job may not exist yet when the user clicks Close.
    await writePrivateFile(join(directory,'stop.request'),'stop');
    const child=spawnLauncher({action:'stop',jobName:jobName(id)},{stdio:['pipe','ignore','pipe']});let error='';child.stderr.on('data',d=>error=(error+d).slice(-4000));
    const timer=setTimeout(()=>void stopProcess(child).catch(()=>{}),10000);
    try{const code=await new Promise((ok,no)=>{child.once('close',ok);child.once('error',no);});if(code!==0)throw Error('关闭程序失败：'+redact(error));}
    finally{clearTimeout(timer);}
    for(let i=0;i<40;i++){const status=await readJson(join(directory,'status.json'));if(status&&ENDED.includes(status.state))break;await wait(50);}
    return {id,...await writeStatus(directory,'stopped')};
  }
  // Starts the daemon and waits until the application has stayed up for a
  // second. An identical live launch is reused instead of started twice.
  async start(request,{signal,workspace}){
    const perform=async()=>{
      workspace=canonicalToolPath(workspace);
      if(signal?.aborted)throw canceled();
      const active=(await this.list(workspace)).filter(isLive);
      const existing=active.find(row=>row.toolId===request.toolId&&toolPathKey(row.cwd)===toolPathKey(request.cwd)&&JSON.stringify(row.args)===JSON.stringify(request.args));
      if(existing)return {...request,approved:true,ok:existing.state==='running',running:existing.state==='running',reused:true,application:existing,stdout:'',stderr:existing.state==='running'?'':'现有程序状态待确认，请刷新或关闭后重试。'};
      if(active.length>=MAX_LIVE)throw Error(`此项目最多保持 ${MAX_LIVE} 个常驻程序，请先关闭不再使用的程序`);
      await mkdir(this.root,{recursive:true});await restrictToCurrentUser(this.root);
      const id=randomUUID(),directory=this.directory(id);await mkdir(directory);await restrictToCurrentUser(directory);
      await writePrivateFile(join(directory,'request.json'),JSON.stringify({...request,workspace,createdAt:Date.now(),jobName:jobName(id),statusFile:join(directory,'status.json'),stopFile:join(directory,'stop.request')}));
      for(const file of ['stdout.log','stderr.log','status.json'])await writePrivateFile(join(directory,file));
      let error;
      const child=spawn(process.execPath,[DAEMON,join(directory,'request.json')],{cwd:request.cwd,env:externalEnvironment(),windowsHide:true,detached:true,shell:false,stdio:'ignore'});
      child.on('error',e=>error=e);child.unref();
      let handedOff=false,seenAt=0;
      const cancel=()=>void stopProcess(child).catch(()=>{});signal?.addEventListener('abort',cancel,{once:true});
      try{
        for(let i=0;i<240;i++){
          if(signal?.aborted)throw canceled();if(error)throw error;
          const status=await readJson(join(directory,'status.json'));
          if(status?.state==='running'){
            seenAt||=Date.now();
            if(Date.now()-seenAt>=1000){
              const application=(await this.list(workspace)).find(row=>row.id===id);handedOff=true;
              return {...request,approved:true,ok:true,running:true,application,...await logs(directory),isolation:ISOLATION};
            }
          }else if(status&&ENDED.includes(status.state)){
            const {stdout,stderr}=await logs(directory);
            return {...request,approved:true,ok:false,running:false,application:{id,...status},exitCode:status.exitCode,stdout,stderr:status.error||stderr||'程序已退出，没有保持运行。'};
          }
          await wait(50);
        }
        throw Error('未收到常驻程序启动确认');
      }finally{
        signal?.removeEventListener('abort',cancel);
        if(!handedOff){await stopProcess(child);await writeStatus(directory,'exited');}
      }
    };
    const pending=this.queue.then(perform);this.queue=pending.catch(()=>{});return pending;
  }
}
const managers=new Map();
export function externalApplicationManager(dataDir){const key=toolPathKey(dataDir);if(!managers.has(key))managers.set(key,new ExternalApplicationManager(dataDir));return managers.get(key);}

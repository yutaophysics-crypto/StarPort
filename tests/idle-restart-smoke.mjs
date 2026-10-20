import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const data=await mkdtemp(join(tmpdir(),'starport-idle-restart-'));
const env={...process.env,HARNESS_HUB_DATA:data,HARNESS_HUB_PORT:'3213'};
const server=spawn(process.execPath,['src/server.mjs'],{cwd:process.cwd(),env,windowsHide:true,stdio:'ignore'});
let config;
try{
  for(let i=0;i<50;i++){try{config=JSON.parse(await readFile(join(data,'server.json'),'utf8'));break;}catch{await new Promise(r=>setTimeout(r,100));}}
  if(!config||config.pid!==server.pid)throw new Error('Fixture failed to launch');
  const update=spawn(process.execPath,['scripts/restart-when-idle.mjs'],{cwd:process.cwd(),env,windowsHide:true,stdio:'inherit'});
  const code=await new Promise((r,j)=>{update.once('exit',r);update.once('error',j);});
  const result=JSON.parse(await readFile(join(data,'subagent-update.json'),'utf8'));
  const next=JSON.parse(await readFile(join(data,'server.json'),'utf8'));
  if(code!==0||result.state!=='updated'||next.pid===config.pid)throw new Error('Restart not confirmed');
  const health=await (await fetch('http://127.0.0.1:3213/health')).json();
  console.log(JSON.stringify({result:result.state,oldPid:config.pid,newPid:next.pid,port:health.port,app:health.app}));
}finally{
  const current=JSON.parse(await readFile(join(data,'server.json'),'utf8'));
  if(current.port===3213&&current.root===process.cwd())await promisify(execFile)('taskkill.exe',['/PID',String(current.pid),'/F'],{windowsHide:true});
}

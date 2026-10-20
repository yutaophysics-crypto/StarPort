import { spawn } from 'node:child_process';
import { mkdirSync,openSync,closeSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function launchCollaboration({root=resolve(import.meta.dirname,'..'),port=Number(process.env.STARPORT_COLLAB_PORT||3218)}={}){
  const base='http://127.0.0.1:'+port,data=process.env.STARPORT_COLLAB_DATA||join(root,'.data/collaboration');
  const health=async()=>{try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(1500)});if(!response.ok)throw Error('群聊服务端口被其他程序占用');const result=await response.json();if(result.app!=='starport-collaboration')throw Error('群聊服务端口被其他程序占用');if(process.env.STARPORT_PUBLIC_URL&&result.origin!==new URL(process.env.STARPORT_PUBLIC_URL).origin)throw Error('群聊服务公开地址与启动配置不一致，请在任务结束后重启群聊后端');if(process.env.STARPORT_ACCOUNT_URL&&result.accountCenter!==process.env.STARPORT_ACCOUNT_URL)throw Error('群聊服务账号中心配置已变化，请重启群聊后端');return true;}catch(error){if(error.message.includes('端口')||error.message.includes('公开地址')||error.message.includes('账号中心'))throw error;return false;}};
  if(await health())return base;
  mkdirSync(data,{recursive:true});const log=openSync(join(data,'server.log'),'a');const child=spawn(process.execPath,[join(root,'src/collaboration/server.mjs')],{cwd:root,detached:true,stdio:['ignore',log,log],windowsHide:true,env:{...process.env,STARPORT_COLLAB_PORT:String(port),STARPORT_COLLAB_DATA:data}});child.unref();closeSync(log);
  for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,250));if(await health())return base;}
  throw Error('群聊服务未能启动，请查看 '+join(data,'server.log'));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))launchCollaboration().then(console.log).catch(error=>{console.error(error.message);process.exitCode=1;});

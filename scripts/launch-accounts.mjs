import { spawn } from 'node:child_process';
import { mkdirSync,openSync,closeSync } from 'node:fs';
import { resolve,join } from 'node:path';
export async function launchAccounts({root=resolve(import.meta.dirname,'..'),port=Number(process.env.STARPORT_ACCOUNT_PORT||3217)}={}){
 const base='http://127.0.0.1:'+port,data=process.env.STARPORT_ACCOUNT_DATA||join(root,'.data/accounts');
 const health=async()=>{try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(1500)}),result=await response.json();if(result.app!=='starport-accounts')throw Error('账号中心端口被其他程序占用');if(process.env.STARPORT_ACCOUNT_URL&&result.issuer!==process.env.STARPORT_ACCOUNT_URL)throw Error('账号中心公开地址与配置不一致');return true;}catch(e){if(e.message.includes('端口')||e.message.includes('公开地址'))throw e;return false;}};
 if(await health())return base;mkdirSync(data,{recursive:true,mode:0o700});const log=openSync(join(data,'server.log'),'a',0o600),child=spawn(process.execPath,[join(root,'src/accounts/server.mjs')],{cwd:root,detached:true,stdio:['ignore',log,log],windowsHide:true,env:{...process.env,STARPORT_ACCOUNT_PORT:String(port),STARPORT_ACCOUNT_DATA:data}});child.unref();closeSync(log);for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,250));if(await health())return base;}throw Error('账号中心未能启动，请查看账号中心日志');
}

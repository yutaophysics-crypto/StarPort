import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {realpathSync,existsSync,readFileSync,lstatSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const inside=(path,root)=>{path=resolve(path).toLowerCase();root=resolve(root).toLowerCase();return path===root||path.startsWith(root+'\\');};
const normal=path=>path.replace(/^\//,'').replace(/\.git$/i,'').toLowerCase();
export function repositoryConfig(workspace,cwd){
 let dir=realpathSync(cwd);if(!inside(dir,workspace))return null;
 while(true){
  const marker=join(dir,'.git');
  if(existsSync(marker)){
   let gitdir=marker;
   if(lstatSync(marker).isFile()){
    const match=readFileSync(marker,'utf8').match(/^gitdir:\s*(.+)\s*$/m);if(!match)return null;gitdir=resolve(dir,match[1].trim());
   }
   gitdir=realpathSync(gitdir);if(!inside(gitdir,workspace))return null;
   const config=join(gitdir,'config');return existsSync(config)&&inside(realpathSync(config),workspace)?config:null;
  }
  if(resolve(dir).toLowerCase()===resolve(workspace).toLowerCase())return null;dir=dirname(dir);
 }
}
export async function approvedRepository(workspace,input,gitExecutable){
 if(input.protocol!=='https'||input.host!=='github.com'||typeof input.path!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.path))return false;
 const config=repositoryConfig(workspace,input.cwd);if(!config)return false;
 let stdout;try{({stdout}=await exec(gitExecutable,['config','--no-includes','--file',config,'--get-regexp','^remote\\..*\\.url$'],{encoding:'utf8',windowsHide:true,timeout:3000}));}catch{return false;}
 return stdout.split(/\r?\n/).some(line=>{
  const url=line.replace(/^\S+\s+/, '');try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='github.com'&&!u.port&&!u.username&&!u.password&&normal(u.pathname)===normal(input.path);}catch{return false;}
 });
}
export async function gitCredentialBroker(workspace,{gitExecutable,powershell,credentialScript}){
 const key=randomBytes(32).toString('hex'),audit=[];let open=true;
 const state={alias:null};
 const server=createServer(async(req,res)=>{
  const finish=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const supplied=Buffer.from(req.headers['x-git-credential']||''),expected=Buffer.from(key);
  if(!open||req.method!=='POST'||req.url!=='/credential'||req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){finish(403,{});return;}
  try{
   let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw Error('Request too large');parts.push(chunk);}
   const input=JSON.parse(Buffer.concat(parts));
   if(state.alias&&typeof input.cwd==='string'&&input.cwd.toLowerCase().startsWith(state.alias.toLowerCase()))input.cwd=join(workspace,input.cwd.slice(state.alias.length));
   if(!await approvedRepository(workspace,input,gitExecutable)){audit.push('repository-not-approved');finish(403,{});return;}
   // Cached Windows credential only: no interactive login, credential changes,
   // network refresh, arbitrary vault targets, or secrets written to disk.
   const env={...process.env,NODE_OPTIONS:''};delete env.PSModulePath;
   const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-File',credentialScript],{env,encoding:'utf8',windowsHide:true,timeout:5000});
   const value=JSON.parse(stdout);if(!value.username||!value.password||/[\r\n\0]/.test(value.username+value.password)){finish(404,{});return;}
   if(!open)return;audit.push('cached-credential-served');finish(200,{username:value.username,password:value.password});
  }catch{audit.push('credential-request-failed');finish(400,{});}
 });
 await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
 const port=server.address().port;
 return {port,audit,setAlias:alias=>state.alias=alias,environment:{STARPORT_GIT_CREDENTIAL_URL:`http://127.0.0.1:${port}/credential`,STARPORT_GIT_CREDENTIAL_KEY:key},
  close:async()=>{open=false;server.closeAllConnections();await new Promise(ok=>server.close(ok));}};
}

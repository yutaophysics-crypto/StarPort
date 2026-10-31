import {existsSync,readFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {exec} from './process.mjs';

export function readClaudeNetworkPolicy(root,dataDir){
 const file=join(dataDir,'claude-network-policy.json');if(!existsSync(file))return null;
 const value=JSON.parse(readFileSync(file,'utf8'));if(!value.enabled||value.activated===false)return null;
 let proxy;try{proxy=new URL(value.proxyUrl);}catch{throw Error('Claude 网络策略的代理地址无效');}
 if(value.version!==1||value.toolNetwork!=='normal'||proxy.protocol!=='http:'||proxy.hostname!=='127.0.0.1'||!proxy.port||proxy.username||proxy.password||!Array.isArray(value.protectedPrograms)||!value.protectedPrograms.length||value.protectedPrograms.some(p=>typeof p!=='string'||!isAbsolute(p))||typeof value.gitExecutable!=='string'||!isAbsolute(value.gitExecutable))throw Error('Claude 网络策略无效；不会绕过保护启动');
 return {...value,file,root,dataDir,runtimeDir:join(root,'.runtime','claude-network')};
}
export function applyClaudeNetworkPolicy(runtime,id,policy){
 if(!runtime||!policy||id!=='claude')return runtime;
 const env={...runtime.env};for(const key of [...Object.keys(process.env),...Object.keys(env)])if(/^(https?|all|no)_proxy$/i.test(key))env[key]='';
 Object.assign(env,{HTTP_PROXY:policy.proxyUrl,HTTPS_PROXY:policy.proxyUrl,http_proxy:policy.proxyUrl,https_proxy:policy.proxyUrl,ALL_PROXY:'',all_proxy:'',NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1',NODE_USE_ENV_PROXY:'1'});
 return {...runtime,env,...id==='claude'?{normalPolicy:policy}:{},claudeNetwork:{policyPath:policy.file,script:join(policy.root,'scripts','claude-network-firewall.ps1'),program:runtime.command}};
}
export async function requireClaudeNetworkProtection(runtime){
 const guard=runtime?.claudeNetwork;if(!guard)return;
 const env={...process.env};delete env.PSModulePath;
 try{await exec(join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',guard.script,'-Mode','Audit','-PolicyPath',guard.policyPath,'-Program',guard.program,'-Quiet'],{env,timeout:20000,maxBuffer:20000,windowsHide:true});}
 catch{throw Error('Claude 联网保护尚未就绪；已阻止启动，未回退直连。请用管理员 PowerShell 执行 scripts/claude-network-firewall.ps1 -Mode Apply 后重试。');}
}

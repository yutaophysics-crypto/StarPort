import {existsSync,readFileSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {exec,redact} from './process.mjs';

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
const AUDIT_TIMEOUT=60000;
function auditReport(stdout){try{return JSON.parse(String(stdout).replace(/^\uFEFF/,'').trim());}catch{return null;}}
function auditFailure(guard,error,report){
 const stopped='已阻止启动，未回退直连。';
 if(error?.killed||error?.code==='ETIMEDOUT')return Object.assign(new Error(`Claude 防火墙检查超过 ${AUDIT_TIMEOUT/1000} 秒；${stopped}检查超时不代表规则缺失，请检查系统负载后重试。`),{code:'CLAUDE_NETWORK_AUDIT_TIMEOUT',cause:error});
 const missing=Array.isArray(report?.Missing)?report.Missing:[];
 const reason=redact(String(report?.Error||(missing.length?`缺少有效保护规则：${missing.slice(0,3).join('；')}`:error?.stderr||error?.message||'检查未返回有效的成功结果')).replace(/[\r\n]+/g,' ')).slice(0,600);
 const repair=missing.length?` 请用管理员 PowerShell 执行 powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${guard.script}" -Mode Apply 后重试。`:'';
 return Object.assign(new Error(`Claude 联网保护检查失败：${reason}；${stopped}${repair}`),{code:'CLAUDE_NETWORK_AUDIT_FAILED',cause:error});
}
export function createClaudeNetworkGuard(run=exec){
 const pending=new Map();
 return function requireProtection(runtime){
  const guard=runtime?.claudeNetwork;if(!guard)return Promise.resolve();
  const key=JSON.stringify([guard.script,guard.policyPath,guard.program]);
  // Only share an audit while it is running. Every later start checks again.
  if(pending.has(key))return pending.get(key);
  const check=(async()=>{
   const env={...process.env};delete env.PSModulePath;
   let output;
   try{output=await run(join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',guard.script,'-Mode','Audit','-PolicyPath',guard.policyPath,'-Program',guard.program],{env,timeout:AUDIT_TIMEOUT,maxBuffer:256000,windowsHide:true});}
   catch(error){throw auditFailure(guard,error,auditReport(error.stdout));}
   const report=auditReport(output.stdout);
   if(report?.Success!==true)throw auditFailure(guard,null,report);
  })().finally(()=>pending.delete(key));
  pending.set(key,check);return check;
 };
}
export const requireClaudeNetworkProtection=createClaudeNetworkGuard();

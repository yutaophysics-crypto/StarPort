import {stripVTControlCharacters} from 'node:util';
import {connectCodex} from './adapters/codex.mjs';
import {claudeControl} from './claude-control.mjs';
import {deepseekBalance} from './deepseek-usage.mjs';
import {startProcess,stopProcess,redact} from './process.mjs';

export const USAGE_SOURCES={
  codex:{label:'Codex · account/rateLimits/read',url:'https://learn.chatgpt.com/docs/app-server'},
  claude:{label:'Claude Code · /usage',url:'https://code.claude.com/docs/en/costs#using-the-usage-command'},
  antigravity:{label:'Antigravity · /usage + /credits',url:'https://antigravity.google/docs/cli/commands/usage/'},
  deepseek:{label:'DeepSeek · /user/balance',url:'https://api-docs.deepseek.com/api/get-user-balance/'}
};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function usageWindow(label,used,resetAt,extra={}){
  return {label,usedPercent:finite(used)?used:null,remainingPercent:finite(used)?Math.max(0,Math.min(100,100-used)):null,resetAt:resetAt??null,...extra};
}
export function codexUsage(native){
  if(!native||typeof native.rateLimits!=='object')throw new Error('厂商返回了无法识别的用量格式');
  const buckets=Object.entries(native.rateLimitsByLimitId||{}),windows=[];
  for(const [key,bucket] of buckets.length?buckets:[['Codex',native.rateLimits]]){
    if(!bucket)continue;
    for(const slot of ['primary','secondary'])if(bucket[slot]){
      const w=bucket[slot];windows.push(usageWindow(bucket.limitName||bucket.limitId||key,w.usedPercent,w.resetsAt,{durationMinutes:w.windowDurationMins??null,slot}));
    }
    if(bucket.individualLimit){const w=bucket.individualLimit;windows.push(usageWindow('个人支出限额',finite(w.remainingPercent)?100-w.remainingPercent:null,w.resetsAt));}
  }
  const {accountId,...details}=native;
  return {status:'ok',windows,native:details};
}
export function claudeUsage(report){
  if(!report||typeof report.rate_limits_available!=='boolean')throw new Error('厂商返回了无法识别的用量格式');
  const {session,...native}=report,limits=report.rate_limits,windows=[];
  const labels={five_hour:'5 小时限额',seven_day:'每周限额',seven_day_opus:'Opus · 每周限额',seven_day_sonnet:'Sonnet · 每周限额',seven_day_oauth_apps:'OAuth 应用 · 每周限额',session:'5 小时限额',weekly_all:'每周限额'};
  // New CLIs expose the exact visible /usage rows, including model scope and labels.
  if(Array.isArray(limits?.limits))for(const row of limits.limits){
    windows.push(usageWindow(row.display_name||row.label||[labels[row.kind]||row.kind,row.scope?.display_name||row.scope?.model||typeof row.scope==='string'&&row.scope].filter(Boolean).join(' · '),row.percent,row.resets_at,{severity:row.severity,isActive:row.is_active}));
  }else for(const [key,row] of Object.entries(limits||{})){
    if(key==='extra_usage')continue;
    if(key==='model_scoped'&&Array.isArray(row))for(const m of row)windows.push(usageWindow(m.display_name,m.utilization,m.resets_at));
    else if(row&&typeof row==='object'&&'utilization'in row)windows.push(usageWindow(labels[key]||key,row.utilization,row.resets_at));
  }
  return {status:report.rate_limits_available?(limits?'ok':'error'):'unavailable',...report.rate_limits_available&&limits?{}:{reason:report.rate_limits_available?'Claude 已识别订阅，但额度接口暂未返回数据，请检查原工具的网络/代理后重试':'当前登录方式未提供订阅剩余额度'},windows,native,
    notes:['账号限额来自原工具；本机用量归因只覆盖此电脑的历史，不包含其他设备。']};
}

export async function readClaudeUsage(runtime,cwd,control=claudeControl,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
  const read=session=>{
    const method=session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if(typeof method!=='function')throw new Error('当前 Claude Code 版本未提供用量查询，请更新原工具');
    return method.call(session,{skipBehaviors:false});
  };
  let report=await control(runtime,cwd,read);
  // A missing report for an eligible subscription is a failed native fetch,
  // not an unsupported login. Reopen once so a transient failure is not memoized.
  if(report?.rate_limits_available===true&&report.rate_limits===null){await wait(400);report=await control(runtime,cwd,read);}
  return claudeUsage(report);
}

// Only built-in reporting commands are accepted. Abort on login rather than
// completing OAuth or letting a background report wait for interactive input.
export async function nativeUsageText(runtime,cwd,command,spawn=startProcess,timeoutMs=25000){
  if(!['/usage','/credits'].includes(command))throw new Error('无效的用量查询命令');
  // Keep the native authentication environment. Injecting SSH markers makes agy
  // switch from the OS keyring to file-based credentials, hiding a valid login.
  const child=spawn(runtime.command,[...runtime.prefixArgs,'--print',command,'--output-format','text'],{cwd});
  let timer,out='',diagnostic='';
  try{return await new Promise((resolve,reject)=>{
    const inspect=()=>{if(/authentication required|starting OAuth|sign in to continue|(?:not logged|not authenticated)(?![^\n]*trying silent auth)/i.test(out+'\n'+diagnostic))reject(Object.assign(new Error('Antigravity CLI 未能读取有效登录，请在原工具中检查账号后重试'),{status:'login_required'}));};
    timer=setTimeout(()=>reject(new Error('原生查询超时，请稍后重试')),timeoutMs);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdin.on('error',()=>{});child.stdin.end();
    child.stdout.on('data',text=>{out+=text;if(out.length>512000)reject(new Error('用量报告过大'));inspect();});
    child.stderr.on('data',text=>{diagnostic=(diagnostic+text).slice(-16000);inspect();});
    child.on('error',reject);child.on('close',code=>{if(code!==0)reject(new Error('Antigravity 原生用量查询失败，请在原工具检查登录和网络'));else if(!out.trim())reject(new Error('厂商暂未返回用量数据'));else resolve(redact(stripVTControlCharacters(out).trim()));});
  });}finally{clearTimeout(timer);await stopProcess(child);}
}

export async function loadUsage(id,runtime,cwd,root,options={}){
  if(!runtime)return {status:'unavailable',reason:'未找到原工具，请先在连接与数据中配置'};
  if(id==='codex'){
    const rpc=await connectCodex(runtime,cwd);
    try{return codexUsage(await rpc.request('account/rateLimits/read',{},25000));}finally{await rpc.close();}
  }
  if(id==='claude')return readClaudeUsage(runtime,cwd);
  if(id==='deepseek'){
    try{return await deepseekBalance(runtime,cwd,root,options);}
    catch{throw new Error('DeepSeek 用量查询失败，请在原工具检查服务配置、凭据和网络');}
  }
  if(id==='antigravity'){
    const reports=[{label:'模型配额',text:await nativeUsageText(runtime,cwd,'/usage')}],notes=[];
    try{reports.push({label:'AI Credits',text:await nativeUsageText(runtime,cwd,'/credits')});}
    catch{notes.push('模型配额已读取，但 AI Credits 报告暂不可用。');}
    return {status:notes.length?'partial':'ok',reports,notes};
  }
  throw new Error('未知工具');
}

export class UsageReader{
  constructor(root,loader=loadUsage){this.root=root;this.loader=loader;this.pending=new Map();}
  async get(id,runtime,cwd,options={}){
    if(!USAGE_SOURCES[id])throw new Error('未知工具');
    const key=JSON.stringify([id,runtime,cwd,options.provider||'']);
    if(this.pending.has(key))return this.pending.get(key);
    const promise=Promise.resolve().then(()=>this.loader(id,runtime,cwd,this.root,options)).catch(error=>({status:error.status==='login_required'?'login_required':'error',reason:redact(error.message).slice(0,700)}))
      .then(result=>({...result,provider:id,source:USAGE_SOURCES[id],queriedAt:new Date().toISOString()})).finally(()=>this.pending.delete(key));
    this.pending.set(key,promise);return promise;
  }
}

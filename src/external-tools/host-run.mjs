// Host execution of a registered program, for software the sandbox terminal
// cannot run (Electron apps, browsers, game engines). The program runs with the
// current Windows user's rights, so every launch is validated and approved.
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { insideToolPath, validateToolSnapshot, hostRunnable } from './grants.mjs';
import { spawnLauncher, collectOutput } from './processes.mjs';

export const EXTERNAL_APPLICATION_WARNING='本机兼容运行：程序及其子进程使用当前 Windows 用户权限，可访问项目外文件及网络；这不是项目沙箱。仅批准你信任的程序和参数。';
const ISOLATION='Host Windows user; no project filesystem or network sandbox; owned process job is closed on completion/cancel/timeout';
const canceled=()=>Error('本次运行已取消');

export function externalApplicationRequest({workspace,snapshot,toolId,args=[],directory='.',timeoutMs=120000,successExitCodes=[0],persistent=false}){
  if(process.platform!=='win32')throw Error('本机兼容运行目前支持 Windows');
  validateToolSnapshot(snapshot,workspace);
  const tool=snapshot.tools.find(tool=>tool.id===toolId);
  if(!hostRunnable(tool))throw Error('请先为当前项目的工具配置 .exe 程序路径');
  if(!Array.isArray(args)||args.length>128||args.some(arg=>typeof arg!=='string'||arg.includes('\0'))||JSON.stringify(args).length>24000)throw Error('程序参数必须是 JSON 字符串数组，总长度不超过 24000');
  if(typeof directory!=='string'||directory.includes('\0')||directory.length>2000)throw Error('工作目录无效');
  const requested=resolve(workspace,directory);
  if(!insideToolPath(requested,workspace))throw Error('程序工作目录必须位于当前项目内');
  let cwd;try{cwd=realpathSync.native(requested);if(!statSync(cwd).isDirectory())throw Error();}catch{throw Error('程序工作目录不存在');}
  if(!insideToolPath(cwd,workspace))throw Error('程序工作目录必须位于当前项目内');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>900000)throw Error('运行时限必须在 1 秒到 15 分钟之间');
  if(!Array.isArray(successExitCodes)||!successExitCodes.length||successExitCodes.length>16||successExitCodes.some(code=>!Number.isInteger(code)||code<0||code>0xffffffff))throw Error('成功退出码必须是非负整数数组');
  if(typeof persistent!=='boolean')throw Error('常驻运行选项无效');
  return {toolId:tool.id,tool:tool.name,executable:tool.canonicalExecutable,args:[...args],cwd,timeoutMs,successExitCodes:[...successExitCodes],persistent,hostApproval:tool.hostApproval==='always'?'always':'ask',warning:EXTERNAL_APPLICATION_WARNING};
}

// Approval lives here, inside the host-side MCP handler. Native Claude permission
// modes/allow rules cannot skip it. No shell command or automatic fallback exists.
export async function runExternalApplication({approve,signal,manager,...input}){
  const request=externalApplicationRequest(input);
  if(signal?.aborted)throw canceled();
  if(request.hostApproval!=='always'&&(typeof approve!=='function'||!await approve(request)))return {...request,approved:false,ok:false,exitCode:null,stdout:'',stderr:'用户未批准本机兼容运行；程序没有启动。'};
  if(signal?.aborted)throw canceled();
  // Paths can be retargeted while the user decides; launch only what was approved.
  const checked=externalApplicationRequest(input);
  if(JSON.stringify(request)!==JSON.stringify(checked))throw Error('程序配置已变化，请重新批准');
  if(checked.persistent){if(!manager)throw Error('常驻程序管理器不可用');return manager.start(checked,{signal,workspace:input.snapshot.workspace});}
  const output=await collectOutput(spawnLauncher(checked,{cwd:checked.cwd,stdio:['pipe','pipe','pipe']}),{timeoutMs:checked.timeoutMs,signal});
  const ok=!output.timedOut&&!output.canceled&&!output.stopError&&checked.successExitCodes.includes(output.exitCode);
  return {...checked,approved:true,ok,...output,isolation:ISOLATION};
}

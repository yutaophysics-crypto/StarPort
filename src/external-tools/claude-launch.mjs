// Launch arguments for a Claude Code session that has external tools. The
// owner's settings and MCP servers (proxies, browsers) are copied into private
// per-run files with the extra restrictions added; the originals never change.
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { writePrivateFile } from '../process.mjs';
import { validateToolSnapshot, insideToolPath } from './grants.mjs';

// Native tools only; shell access goes through the sandboxed terminal instead.
const NATIVE_TOOLS='Read,Glob,Grep,Edit,Write,AskUserQuestion';

async function configuration(value,cwd){return JSON.parse(value.trim().startsWith('{')?value:await readFile(resolve(cwd,value),'utf8'));}
function splitArgs(args,flag,multiple=false){
  const values=[],rest=[];
  for(let i=0;i<args.length;i++){
    if(args[i]===flag){if(!args[i+1]||args[i+1].startsWith('-'))throw Error('Claude 工具配置无效');values.push(args[++i]);if(multiple)while(args[i+1]&&!args[i+1].startsWith('-'))values.push(args[++i]);}
    else if(args[i].startsWith(flag+'='))values.push(args[i].slice(flag.length+1));else rest.push(args[i]);
  }
  return {values,rest};
}
// Claude permission rules write an absolute Windows path as //c/dir.
const editDenyRule=path=>'Edit(/'+path.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase())+'/**)';

// The sandbox comes from an owner-configured workspace terminal (legacy
// --mcp-config entry) or else the registered native codex.exe.
export async function externalToolCapability(runtime,cwd=process.cwd(),sandboxFallback){
  if(process.platform!=='win32')return {supported:false,reason:'外部工具隔离目前支持 Windows 上的 Claude Code'};
  if(runtime?.normalPolicy){
    if(!sandboxFallback||!existsSync(sandboxFallback))return {supported:false,reason:'普通开发终端需要已注册的 Windows 文件沙箱运行时'};
    return {supported:true,sandboxExecutable:sandboxFallback,normalPolicy:runtime.normalPolicy,hostExecution:true};
  }
  const {values}=splitArgs(runtime?.prefixArgs||[],'--mcp-config',true);
  for(const value of values){
    const config=await configuration(value,cwd),terminal=config.mcpServers?.starport_workspace;
    const runner=terminal?.env?.STARPORT_ISOLATED_RUNNER;
    if(runner!==undefined){
      if(typeof runner!=='string'||!isAbsolute(runner)||!existsSync(runner)||typeof terminal.command!=='string'||!isAbsolute(terminal.command)||!existsSync(terminal.command))throw Error('本机隔离运行器配置无效；不会改用其他终端');
      return {supported:true,runner:{command:terminal.command,args:[runner],env:{NODE_OPTIONS:''}},hostExecution:terminal.env?.STARPORT_ALLOW_HOST_TOOLS!=='0'};
    }
    const sandbox=terminal?.env?.STARPORT_CODEX_SANDBOX;
    if(sandbox&&existsSync(sandbox))return {supported:true,sandboxExecutable:sandbox};
  }
  if(sandboxFallback&&/[\\/]codex\.exe$/i.test(sandboxFallback)&&existsSync(sandboxFallback))return {supported:true,sandboxExecutable:sandboxFallback};
  return {supported:false,reason:'请先为 Claude 配置星港的 Windows 隔离终端'};
}
// The caller supplies a stable policy in runtime.externalTools; temporary paths
// never enter the session fingerprint. Owner proxies/browser MCPs are preserved.
export async function prepareExternalClaude(runtime,cwd){
  const policy=runtime.externalTools;
  if(!policy||!policy.tools.length&&!policy.normalPolicy)return {runtime,cleanup:async()=>{}};
  validateToolSnapshot(policy,cwd);
  const capability=await externalToolCapability(runtime,cwd,policy.sandboxExecutable);if(!capability.supported)throw Error(capability.reason);
  const settingsArgs=splitArgs(runtime.prefixArgs||[],'--settings'),mcpArgs=splitArgs(settingsArgs.rest,'--mcp-config',true);
  const settings=settingsArgs.values.length?await configuration(settingsArgs.values.at(-1),cwd):{};
  const config={mcpServers:{}};for(const value of mcpArgs.values)Object.assign(config.mcpServers,(await configuration(value,cwd)).mcpServers||{});
  const launchRoot=resolve(policy.dataDir,'external-tools-runs');await mkdir(launchRoot,{recursive:true});
  const directory=await mkdtemp(join(launchRoot,'run-'));
  const cleanup=async()=>{if(!existsSync(directory))return;if(!insideToolPath(realpathSync.native(directory),realpathSync.native(launchRoot))||directory===launchRoot)throw Error('工具临时配置清理路径无效');await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});};
  const save=async(name,value)=>{const file=join(directory,name);await writePrivateFile(file,JSON.stringify(value));return file;};
  try{
    // Host the workspace terminal in the SDK too: a resumed native session must
    // never reconnect a stdio server using a previous turn's deleted manifest.
    delete config.mcpServers.starport_workspace;
    const preparedSettings={...settings,permissions:{...settings.permissions,
      blockReadsOutsideWorkingDirectories:true,deny:[...new Set([...(settings.permissions?.deny||[]),...policy.tools.map(tool=>editDenyRule(tool.canonical))])]}};
    const settingsFile=await save('settings.json',preparedSettings),mcpFile=await save('mcp.json',config);
    const safeArgs=splitArgs(mcpArgs.rest,'--tools',true).rest.filter(arg=>!['--restricted','--strict-mcp-config'].includes(arg));
    return {runtime:{...runtime,workspaceTerminal:{sandboxExecutable:capability.sandboxExecutable,runner:capability.runner,normalPolicy:capability.normalPolicy,hostExecution:capability.hostExecution},prefixArgs:[...safeArgs,'--restricted','--strict-mcp-config','--tools',NATIVE_TOOLS,'--settings',settingsFile,'--mcp-config',mcpFile,
      ...policy.tools.flatMap(tool=>['--add-dir',tool.canonical])]},cleanup,directory};
  }catch(error){await cleanup();throw error;}
}

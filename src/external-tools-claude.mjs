import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restrictToCurrentUser } from './process.mjs';
import { validateToolSnapshot, insideToolPath } from './external-tools.mjs';

const terminal=fileURLToPath(new URL('../scripts/claude-workspace-terminal.mjs',import.meta.url));
async function configuration(value,cwd){return JSON.parse(value.trim().startsWith('{')?value:await readFile(resolve(cwd,value),'utf8'));}
function splitArgs(args,flag,multiple=false){
  const values=[],rest=[];
  for(let i=0;i<args.length;i++){
    if(args[i]===flag){if(!args[i+1]||args[i+1].startsWith('-'))throw Error('Claude 工具配置无效');values.push(args[++i]);if(multiple)while(args[i+1]&&!args[i+1].startsWith('-'))values.push(args[++i]);}
    else if(args[i].startsWith(flag+'='))values.push(args[i].slice(flag.length+1));else rest.push(args[i]);
  }
  return {values,rest};
}
export async function externalToolCapability(runtime,cwd=process.cwd(),sandboxFallback){
  if(process.platform!=='win32')return {supported:false,reason:'外部工具隔离目前支持 Windows 上的 Claude Code'};
  const {values}=splitArgs(runtime?.prefixArgs||[],'--mcp-config',true);
  for(const value of values){
    const config=await configuration(value,cwd),sandbox=config.mcpServers?.starport_workspace?.env?.STARPORT_CODEX_SANDBOX;
    if(sandbox&&existsSync(sandbox))return {supported:true,sandboxExecutable:sandbox};
  }
  if(sandboxFallback&&/[\\/]codex\.exe$/i.test(sandboxFallback)&&existsSync(sandboxFallback))return {supported:true,sandboxExecutable:sandboxFallback};
  return {supported:false,reason:'请先为 Claude 配置星港的 Windows 隔离终端'};
}
// The caller supplies a stable policy in runtime.externalTools; temporary paths
// never enter the session fingerprint. Owner proxies/browser MCPs are preserved.
export async function prepareExternalClaude(runtime,cwd){
  const policy=runtime.externalTools;
  if(!policy?.tools?.length)return {runtime,cleanup:async()=>{}};
  validateToolSnapshot(policy,cwd);
  const capability=await externalToolCapability(runtime,cwd,policy.sandboxExecutable);if(!capability.supported)throw Error(capability.reason);
  const settingsArgs=splitArgs(runtime.prefixArgs||[],'--settings'),mcpArgs=splitArgs(settingsArgs.rest,'--mcp-config',true);
  const settings=settingsArgs.values.length?await configuration(settingsArgs.values.at(-1),cwd):{};
  const config={mcpServers:{}};for(const value of mcpArgs.values)Object.assign(config.mcpServers,(await configuration(value,cwd)).mcpServers||{});
  const launchRoot=resolve(policy.dataDir,'external-tools-runs');await mkdir(launchRoot,{recursive:true});
  const directory=await mkdtemp(join(launchRoot,'run-'));
  const cleanup=async()=>{if(!existsSync(directory))return;if(!insideToolPath(realpathSync.native(directory),realpathSync.native(launchRoot))||directory===launchRoot)throw Error('工具临时配置清理路径无效');await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});};
  const save=async(name,value)=>{const file=join(directory,name);await writeFile(file,'',{mode:0o600});await restrictToCurrentUser(file);await writeFile(file,JSON.stringify(value),{mode:0o600});return file;};
  try{
    const manifest=await save('policy.json',{workspace:policy.workspace,tools:policy.tools});
    config.mcpServers.starport_workspace={...config.mcpServers.starport_workspace,command:process.execPath,args:[terminal],
      env:{...config.mcpServers.starport_workspace?.env,STARPORT_CODEX_SANDBOX:capability.sandboxExecutable,STARPORT_EXTERNAL_TOOLS_MANIFEST:manifest}};
    const deny=policy.tools.map(tool=>'Edit(/'+tool.canonical.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase())+'/**)');
    const preparedSettings={...settings,permissions:{...settings.permissions,
      blockReadsOutsideWorkingDirectories:true,deny:[...new Set([...(settings.permissions?.deny||[]),...deny])]}};
    const settingsFile=await save('settings.json',preparedSettings),mcpFile=await save('mcp.json',config);
    const safeArgs=splitArgs(mcpArgs.rest,'--tools',true).rest.filter(arg=>!['--restricted','--strict-mcp-config'].includes(arg));
    return {runtime:{...runtime,prefixArgs:[...safeArgs,'--restricted','--strict-mcp-config','--tools','Read,Glob,Grep,Edit,Write,AskUserQuestion','--settings',settingsFile,'--mcp-config',mcpFile,
      ...policy.tools.flatMap(tool=>['--add-dir',tool.canonical])]},cleanup,directory};
  }catch(error){await cleanup();throw error;}
}

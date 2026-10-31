// PowerShell inside the Codex Windows MXC sandbox: the project is writable,
// granted tool folders are read-only, and network is off. Caches and temp
// files are redirected into the project.
import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { validateToolSnapshot } from './grants.mjs';
import { externalEnvironment, collectOutput, windowsPowerShell } from './processes.mjs';
import { runNormalWorkspaceCommand } from './normal-terminal.mjs';

const POWERSHELL_7='C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const ISOLATION='Windows MXC; project writable; approved tool installations read-only; command network disabled';

export const quotePowerShell=value=>"'"+value.replaceAll("'","''")+"'";
export function workspaceFilesystem(workspace,snapshot={workspace,tools:[]}){
  validateToolSnapshot(snapshot,workspace);
  return Object.fromEntries([[":root","deny"],[":minimal","read"],[workspace,"write"],[dirname(process.execPath),"read"],...snapshot.tools.map(tool=>[tool.canonical,'read'])]);
}
export async function runWorkspaceCommand({workspace,sandboxExecutable,runner,normalPolicy,snapshot={workspace,tools:[]},command,timeoutMs=120000,signal}){
  if(normalPolicy)return runNormalWorkspaceCommand({workspace,sandboxExecutable,command,timeoutMs,signal,normalPolicy,filesystem:workspaceFilesystem(workspace,snapshot)});
  if(runner){
    workspace=realpathSync.native(workspace);validateToolSnapshot(snapshot,workspace);
    if(signal?.aborted)throw Error('隔离命令已取消');
    // Only owner configuration supplies the runner. Model input supplies command
    // data, never a binary, policy, environment, or shell argument string.
    const child=spawn(runner.command,runner.args,{cwd:workspace,env:{...externalEnvironment(),...runner.env},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({workspace,command,timeoutMs,readonlyPaths:snapshot.tools.map(item=>item.canonical)}));
    const result=await collectOutput(child,{timeoutMs:timeoutMs+5000,signal});
    if(result.timedOut||result.canceled)return {workspace,...result,isolation:'Owner-configured isolated runner; no unrestricted fallback'};
    if(result.exitCode!==0||result.outputTruncated)throw Error('本机隔离运行器失败；不会放宽权限：'+result.stderr);
    let value;try{value=JSON.parse(result.stdout);}catch{throw Error('本机隔离运行器未返回有效结果；不会改用其他终端');}
    if(value.workspace!==workspace||typeof value.stdout!=='string'||typeof value.stderr!=='string'||typeof value.isolation!=='string'||!(value.exitCode===null||Number.isInteger(value.exitCode)))throw Error('本机隔离运行器结果无效');
    return value;
  }
  if(process.platform!=='win32'||!sandboxExecutable||!existsSync(sandboxExecutable))throw Error('需要可用的 Windows 隔离终端');
  workspace=realpathSync.native(workspace);const filesystem=workspaceFilesystem(workspace,snapshot);
  const cache=join(workspace,'.starport-claude-runtime'),temp=join(cache,'tmp');
  const encodedFs='{ '+Object.entries(filesystem).map(([path,access])=>JSON.stringify(path)+' = '+JSON.stringify(access)).join(', ')+' }';
  const policy=`permissions.starport_claude_workspace={ filesystem=${encodedFs}, network={ enabled=false }, workspace_roots={} }`;
  const shell=existsSync(POWERSHELL_7)?POWERSHELL_7:windowsPowerShell();
  const dirs={TEMP:temp,TMP:temp,APPDATA:join(cache,'appdata'),LOCALAPPDATA:join(cache,'localappdata'),USERPROFILE:join(cache,'home'),HOME:join(cache,'home'),NPM_CONFIG_CACHE:join(cache,'npm-cache')};
  const script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "+
    `New-PSDrive -Name StarPort -PSProvider FileSystem -Root ${quotePowerShell(workspace)} | Out-Null; Set-Location -LiteralPath 'StarPort:\\'; [Environment]::CurrentDirectory=${quotePowerShell(workspace)}; `+
    Object.entries(dirs).map(([key,value])=>`New-Item -ItemType Directory -Force -Path ${quotePowerShell(value)} | Out-Null; $env:${key}=${quotePowerShell(value)}; `).join('')+
    `$env:NPM_CONFIG_USERCONFIG=${quotePowerShell(join(cache,'npmrc'))}; `+command;
  const args=['sandbox','-c','windows.sandbox="mxc"','-c',policy,'-c','features.network_proxy=false','-P','starport_claude_workspace','-C',workspace,'--',shell,'-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  const child=spawn(sandboxExecutable,args,{cwd:workspace,env:externalEnvironment(),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  return {workspace,...await collectOutput(child,{timeoutMs,signal}),isolation:ISOLATION};
}

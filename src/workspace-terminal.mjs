import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { stopProcess, redact } from './process.mjs';
import { validateToolSnapshot } from './external-tools.mjs';

export const quotePowerShell=value=>"'"+value.replaceAll("'","''")+"'";
export function workspaceFilesystem(workspace,snapshot={workspace,tools:[]}){
  validateToolSnapshot(snapshot,workspace);
  return Object.fromEntries([[":root","deny"],[":minimal","read"],[workspace,"write"],[dirname(process.execPath),"read"],...snapshot.tools.map(tool=>[tool.canonical,'read'])]);
}
export async function runWorkspaceCommand({workspace,sandboxExecutable,snapshot={workspace,tools:[]},command,timeoutMs=120000,signal}){
  if(process.platform!=='win32'||!sandboxExecutable||!existsSync(sandboxExecutable))throw Error('需要可用的 Windows 隔离终端');
  workspace=realpathSync.native(workspace);const filesystem=workspaceFilesystem(workspace,snapshot);
  const cache=join(workspace,'.starport-claude-runtime'),temp=join(cache,'tmp');
  const encodedFs='{ '+Object.entries(filesystem).map(([path,access])=>JSON.stringify(path)+' = '+JSON.stringify(access)).join(', ')+' }';
  const policy=`permissions.starport_claude_workspace={ filesystem=${encodedFs}, network={ enabled=false }, workspace_roots={} }`;
  const shell=existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')?'C:\\Program Files\\PowerShell\\7\\pwsh.exe':join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const dirs={TEMP:temp,TMP:temp,APPDATA:join(cache,'appdata'),LOCALAPPDATA:join(cache,'localappdata'),USERPROFILE:join(cache,'home'),HOME:join(cache,'home'),NPM_CONFIG_CACHE:join(cache,'npm-cache')};
  const script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "+
    `New-PSDrive -Name StarPort -PSProvider FileSystem -Root ${quotePowerShell(workspace)} | Out-Null; Set-Location -LiteralPath 'StarPort:\\'; [Environment]::CurrentDirectory=${quotePowerShell(workspace)}; `+
    Object.entries(dirs).map(([key,value])=>`New-Item -ItemType Directory -Force -Path ${quotePowerShell(value)} | Out-Null; $env:${key}=${quotePowerShell(value)}; `).join('')+
    `$env:NPM_CONFIG_USERCONFIG=${quotePowerShell(join(cache,'npmrc'))}; `+command;
  const args=['sandbox','-c','windows.sandbox="mxc"','-c',policy,'-c','features.network_proxy=false','-P','starport_claude_workspace','-C',workspace,'--',shell,'-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  const env={...process.env};for(const key of Object.keys(env))if(/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(key))delete env[key];
  const child=spawn(sandboxExecutable,args,{cwd:workspace,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stopped;const stopDone=new Promise(resolve=>stopped=resolve);
  let stdout='',stderr='',timedOut=false,canceled=false,outputTruncated=false,stopError='';
  const stop=()=>stopProcess(child).catch(error=>{stopError=error.message;}).finally(()=>stopped(null));
  const cancel=()=>{canceled=true;void stop();};signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{timedOut=true;void stop();},timeoutMs);
  const append=(text,chunk)=>{if(text.length+chunk.length>128*1024)outputTruncated=true;return(text+chunk).slice(0,128*1024);};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>stdout=append(stdout,chunk));child.stderr.on('data',chunk=>stderr=append(stderr,chunk));
  try{
    const exitCode=await Promise.race([stopDone,new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);if(signal?.aborted)cancel();})]);
    return {workspace,exitCode,stdout:redact(stdout),stderr:redact(stderr),timedOut,canceled,outputTruncated,...stopError?{stopError}:{},isolation:'Windows MXC; project writable; approved tool installations read-only; command network disabled'};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

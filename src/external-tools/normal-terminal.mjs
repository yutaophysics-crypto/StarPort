import {spawn} from 'node:child_process';
import {existsSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {projectDrive} from './drive-alias.mjs';
import {gitCredentialBroker} from './git-credentials.mjs';
import {externalEnvironment,collectOutput,windowsPowerShell} from './processes.mjs';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const inside=(path,root)=>{path=resolve(path).toLowerCase();root=resolve(root).toLowerCase();return path===root||path.startsWith(root+'\\');};

export async function runNormalWorkspaceCommand({workspace,command,timeoutMs=120000,signal,sandboxExecutable,filesystem,normalPolicy}){
 if(signal?.aborted)throw Error('终端命令已取消');
 if(!sandboxExecutable||!existsSync(sandboxExecutable))throw Error('需要可用的 Windows 文件隔离终端');
 workspace=realpathSync.native(workspace);
 const {runtimeDir,dataDir,root,gitExecutable}=normalPolicy,client=join(runtimeDir,'git-client');
 if(!existsSync(join(client,'git-askpass.exe')))throw Error('普通终端尚未安装：请先运行 scripts/setup-claude-network.mjs');
 const shell=existsSync(join(process.env.ProgramFiles||'C:\\Program Files','PowerShell','7','pwsh.exe'))?join(process.env.ProgramFiles||'C:\\Program Files','PowerShell','7','pwsh.exe'):windowsPowerShell();
 const broker=await gitCredentialBroker(workspace,{gitExecutable,powershell:shell,credentialScript:join(root,'scripts','read-cached-git-credential.ps1')});
 let drive;
 try{
  drive=projectDrive(workspace,join(dataDir,'terminal-drives'));broker.setAlias(drive.root);
  const cache=join(workspace,'.starport-claude-runtime'),temp=join(cache,'tmp');
  const env=externalEnvironment();for(const key of Object.keys(env))if(/^(https?|all|no)_proxy$/i.test(key))delete env[key];
  const dirs={TEMP:temp,TMP:temp,APPDATA:join(cache,'appdata'),LOCALAPPDATA:join(cache,'localappdata'),USERPROFILE:join(cache,'home'),HOME:join(cache,'home'),NPM_CONFIG_CACHE:join(cache,'npm-cache')};
  Object.assign(env,dirs,broker.environment,{NPM_CONFIG_USERCONFIG:join(cache,'npmrc'),GIT_CONFIG_GLOBAL:join(client,'gitconfig'),GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:join(client,'git-askpass.exe'),LC_ALL:'C',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'',GIT_CONFIG_KEY_1:'credential.useHttpPath',GIT_CONFIG_VALUE_1:'true',NODE_OPTIONS:'--preserve-symlinks --preserve-symlinks-main'});
  delete env.NODE_PATH;
  const script="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "+
   `New-PSDrive -Name StarPort -PSProvider FileSystem -Root ${quote(drive.root)} | Out-Null; Set-Location -LiteralPath 'StarPort:\\'; [Environment]::CurrentDirectory=${quote(drive.root)}; `+
   [...new Set(Object.values(dirs))].map(path=>`New-Item -ItemType Directory -Force -Path ${quote(path)} | Out-Null; `).join('')+
   `$script:StarPortPhysical=${quote(workspace)}; $script:StarPortDrive=${quote(drive.root)}; `+
   `function global:Convert-StarPortGitPath([string]$p) { $p=$p.Replace('/','\\'); if($p.Equals($script:StarPortPhysical,[StringComparison]::OrdinalIgnoreCase)){return $script:StarPortDrive}; if($p.StartsWith($script:StarPortPhysical+'\\',[StringComparison]::OrdinalIgnoreCase)){return $script:StarPortDrive+$p.Substring($script:StarPortPhysical.Length+1)}; return $p }; `+
   `function global:git { $ga=@($args); for($i=0;$i -lt $ga.Count;$i++){if($ga[$i] -eq '-C' -and $i+1 -lt $ga.Count){$ga[$i+1]=Convert-StarPortGitPath $ga[$i+1];$i++}}; $old=(Get-Location).Path; $physical=(Get-Location).ProviderPath; try {$mapped=Convert-StarPortGitPath $physical;if($mapped -ne $physical){Set-Location -LiteralPath $mapped}; & ${quote(gitExecutable)} @ga;$code=$LASTEXITCODE} finally {Set-Location -LiteralPath $old};$global:LASTEXITCODE=$code }; `+command;
  const fs={...filesystem,[client]:'read'},gitDirectory=join(workspace,'.git');
  // Writable project roots otherwise retain Codex's implicit read-only .git rule.
  if(!lstatSync(gitDirectory,{throwIfNoEntry:false})?.isSymbolicLink())fs[gitDirectory]='write';
  for(const path of [dataDir])if(inside(path,workspace))fs[path]='deny';
  const encodedFs='{ '+Object.entries(fs).map(([path,access])=>JSON.stringify(path)+' = '+JSON.stringify(access)).join(', ')+' }';
  const policy=`permissions.starport_claude_workspace={ filesystem=${encodedFs}, network={ enabled=true }, workspace_roots={} }`;
  const args=['sandbox','-c','windows.sandbox="mxc"','-c',policy,'-c','features.network_proxy=false','-P','starport_claude_workspace','-C',workspace,'--',shell,'-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];
  const child=spawn(sandboxExecutable,args,{cwd:workspace,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const result=await collectOutput(child,{timeoutMs,signal});
  const physical=text=>text.replaceAll(drive.root.replaceAll('\\','/'),workspace.replaceAll('\\','/')+'/').replaceAll(drive.root,workspace+'\\');
  return {workspace,...result,stdout:physical(result.stdout),stderr:physical(result.stderr),networkMode:'normal-development',isolation:'Windows MXC project filesystem sandbox; ordinary command networking enabled; Claude clients retain independent executable firewall rules'};
 }finally{drive?.release();await broker.close();}
}

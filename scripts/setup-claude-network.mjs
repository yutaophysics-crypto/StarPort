import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,renameSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {ProviderRegistry} from '../src/providers.mjs';

const root=resolve(import.meta.dirname,'..'),dataDir=process.env.HARNESS_HUB_DATA||join(root,'.data');
const runtime=join(root,'.runtime','claude-network'),client=join(runtime,'git-client');
const windows=process.env.SystemRoot||'C:\\Windows',ps=join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe');
const env={...process.env};delete env.PSModulePath;
const run=(command,args)=>execFileSync(command,args,{cwd:root,env,encoding:'utf8',windowsHide:true});
const atomic=(path,value)=>{const temp=path+'.network.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n');renameSync(temp,path);};
if(process.platform!=='win32')throw Error('This setup is for Windows');
mkdirSync(client,{recursive:true});mkdirSync(dataDir,{recursive:true});
const policyPath=join(dataDir,'claude-network-policy.json');
if(process.argv.includes('--activate')){
 run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts','claude-network-firewall.ps1'),'-Mode','Audit','-PolicyPath',policyPath,'-Quiet']);
 const mcp=join(dataDir,'claude-workspace-mcp.json');
 if(existsSync(mcp)){const value=JSON.parse(readFileSync(mcp,'utf8'));if(value.mcpServers?.starport_workspace){copyFileSync(mcp,mcp+'.before-client-network.json');delete value.mcpServers.starport_workspace;atomic(mcp,value);}}
 const value=JSON.parse(readFileSync(policyPath,'utf8'));atomic(policyPath,{...value,activated:true});
 console.log('Claude-only policy ready. Reload Starport when all tasks are idle.');
 process.exit(0);
}
const gitExecutable=join(process.env.ProgramFiles||'C:\\Program Files','Git','cmd','git.exe');
if(!existsSync(gitExecutable))throw Error('Install Git for Windows first');
run(join(windows,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:exe','/reference:System.Web.Extensions.dll','/out:'+join(client,'git-askpass.exe'),join(root,'scripts','git-askpass.cs')]);
const escape=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';let identity='[user]\n';
for(const name of ['name','email']){try{const value=run(gitExecutable,['config','--global','--get','user.'+name]).trim();if(value&&!/[\r\n\0]/.test(value))identity+='\t'+name+' = '+escape(value)+'\n';}catch{}}
writeFileSync(join(client,'gitconfig'),identity);
const programs=new Set(),normalPrograms=[],discoveryRoots=[join(homedir(),'.local','share','claude','versions'),join(root,'node_modules','@anthropic-ai'),join(homedir(),'.dsh','dsh-runtimes')];
let rules=[];try{rules=JSON.parse(run(ps,['-NoProfile','-NonInteractive','-Command',"@(Get-NetFirewallRule | Where-Object {$_.Group -like 'Claude*' -or $_.Group -eq 'Starport-Claude-Clients'} | Get-NetFirewallApplicationFilter | Select-Object -ExpandProperty Program) | ConvertTo-Json -Compress"]));if(!Array.isArray(rules))rules=[rules];}catch{}
for(const path of rules)if(typeof path==='string'&&existsSync(path))programs.add(path);
const native=join(homedir(),'.local','bin','claude.exe');if(existsSync(native))programs.add(native);
const sdk=join(root,'node_modules','@anthropic-ai','claude-agent-sdk-win32-x64','claude.exe');if(existsSync(sdk))programs.add(sdk);
const db=new DatabaseSync(join(dataDir,'hub.sqlite'),{readOnly:true});
try{
 const store={setting:(key,fallback)=>{const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}};
 const registry=new ProviderRegistry(root,dataDir,store),dsh=registry.resolve('deepseek');
 if(dsh){
  // DSH itself uses normal networking. Discover any separate Claude payload
  // under its installation, without blocking its shared interpreter or host.
  for(const path of programs)if(resolve(path).toLowerCase()===resolve(dsh.command).toLowerCase())programs.delete(path);
  normalPrograms.push(dsh.command);discoveryRoots.push(dirname(dsh.command));
 }
}finally{db.close();}
const old=existsSync(policyPath)?JSON.parse(readFileSync(policyPath,'utf8')):{};
if(existsSync(policyPath))copyFileSync(policyPath,policyPath+'.before-setup.json');
const proxyIndex=process.argv.indexOf('--proxy'),proxyUrl=proxyIndex>=0?process.argv[proxyIndex+1]:old.proxyUrl;
if(!proxyUrl)throw Error('Pass the local HTTP proxy Claude clients must use: --proxy http://127.0.0.1:<port>');
atomic(policyPath,{version:1,enabled:true,activated:old.activated===true,toolNetwork:'normal',proxyUrl,gitExecutable,protectedPrograms:[...programs].sort(),normalPrograms,discoveryRoots:[...new Set(discoveryRoots)]});
console.log(JSON.stringify({policyPath,gitHelper:join(client,'git-askpass.exe'),protectedPrograms:programs.size,next:'Run administrator PowerShell: scripts/claude-network-firewall.ps1 -Mode Apply, then node scripts/setup-claude-network.mjs --activate'},null,2));

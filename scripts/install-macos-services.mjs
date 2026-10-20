import { existsSync,mkdirSync,cpSync,writeFileSync,chmodSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync,backup } from 'node:sqlite';
import { readLocalServices } from './local-services.mjs';
import { migrateAccounts } from './migrate-accounts.mjs';

if(process.platform!=='darwin')throw Error('此安装器仅适用于 macOS');
const root=resolve(import.meta.dirname,'..'),profile=readLocalServices(root);
if(!profile?.accountServer||!profile.server)throw Error('请先在本机配置中启用账号中心和群聊服务器');
const support=join(homedir(),'Library/Application Support/StarPort/services'),release=join(support,'releases',new Date().toISOString().replaceAll(':','-')),groupData=profile.groupData||join(support,'data/collaboration'),accountData=profile.accountData||join(support,'data/accounts');
const liveDatabase=existsSync(join(groupData,'collaboration.sqlite'))?join(groupData,'collaboration.sqlite'):join(root,'.data/collaboration/collaboration.sqlite');
if(existsSync(liveDatabase)){const db=new DatabaseSync(liveDatabase,{readOnly:true});db.exec('PRAGMA busy_timeout=8000');try{if(db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','claimed','running')").get().n)throw Error('群聊仍有等待或执行中的任务，请等待任务结束后再更新服务');}finally{db.close();}}
for(const label of ['local.tao.starport.groups','local.tao.starport.accounts']){let loaded=false;try{execFileSync('launchctl',['print','gui/'+process.getuid()+'/'+label],{stdio:'ignore'});loaded=true;}catch{}if(loaded)execFileSync('launchctl',['bootout','gui/'+process.getuid()+'/'+label]);}
for(const folder of [support,release,groupData,accountData]){mkdirSync(folder,{recursive:true,mode:0o700});chmodSync(folder,0o700);}
// Public services have a small self-contained release outside protected Documents.
// No desktop databases, workspaces, SDKs or model credentials enter this release.
for(const file of ['src/accounts/server.mjs','src/accounts/store.mjs','src/accounts/protocol.mjs','src/collaboration/server.mjs','src/collaboration/store.mjs']){const destination=join(release,file);mkdirSync(resolve(destination,'..'),{recursive:true});cpSync(join(root,file),destination);}
for(const folder of ['public/mobile','public/account','node_modules/dompurify']){mkdirSync(resolve(join(release,folder),'..'),{recursive:true});cpSync(join(root,folder),join(release,folder),{recursive:true});}
mkdirSync(join(release,'public/vendor'),{recursive:true});cpSync(join(root,'public/vendor/marked.min.js'),join(release,'public/vendor/marked.min.js'));
const groupFile=join(groupData,'collaboration.sqlite'),oldGroup=join(root,'.data/collaboration/collaboration.sqlite');
if(!existsSync(groupFile)&&existsSync(oldGroup)){const source=new DatabaseSync(oldGroup,{readOnly:true});try{await backup(source,groupFile);}finally{source.close();}chmodSync(groupFile,0o600);}
const migration=migrateAccounts({groupFile,accountFile:join(accountData,'accounts.sqlite'),issuer:profile.accountCenter});
const agents=join(homedir(),'Library/LaunchAgents');mkdirSync(agents,{recursive:true});const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const jobs=[{label:'local.tao.starport.accounts',script:'src/accounts/server.mjs',data:accountData,environment:{STARPORT_ACCOUNT_URL:profile.accountCenter,STARPORT_ACCOUNT_PORT:'3217',STARPORT_ACCOUNT_DATA:accountData}},
 {label:'local.tao.starport.groups',script:'src/collaboration/server.mjs',data:groupData,environment:{STARPORT_PUBLIC_URL:profile.collaborationUrl,STARPORT_COLLAB_PORT:'3218',STARPORT_COLLAB_DATA:groupData,STARPORT_COLLAB_EVENTS:profile.events,STARPORT_ACCOUNT_URL:profile.accountCenter,STARPORT_ACCOUNT_BACKEND:'http://127.0.0.1:3217',STARPORT_ACCOUNT_PUBLIC_KEY:join(accountData,'public-key.pem')}}];
for(const job of jobs){const file=join(agents,job.label+'.plist');if(existsSync(file)){const backups=join(root,'.data/source-backups','services-'+new Date().toISOString().replaceAll(':','-'));mkdirSync(backups,{recursive:true});cpSync(file,join(backups,job.label+'.plist'));}
 const env=Object.entries(job.environment).map(([k,v])=>'<key>'+escape(k)+'</key><string>'+escape(v)+'</string>').join('');const plist='<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>'+job.label+'</string><key>ProgramArguments</key><array><string>'+escape(process.execPath)+'</string><string>'+escape(join(release,job.script))+'</string></array><key>WorkingDirectory</key><string>'+escape(release)+'</string><key>EnvironmentVariables</key><dict>'+env+'</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>'+escape(join(job.data,'server.log'))+'</string><key>StandardErrorPath</key><string>'+escape(join(job.data,'server.log'))+'</string></dict></plist>';
 writeFileSync(file,plist,{mode:0o600});execFileSync('plutil',['-lint',file]);let started=false,lastError;for(let attempt=0;attempt<20;attempt++){try{execFileSync('launchctl',['bootstrap','gui/'+process.getuid(),file],{stdio:'ignore'});started=true;break;}catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,Math.min(1000,250*(attempt+1))));}}if(!started)throw lastError;}
console.log(JSON.stringify({release,accountData,groupData,migration,accountCenter:profile.accountCenter}));

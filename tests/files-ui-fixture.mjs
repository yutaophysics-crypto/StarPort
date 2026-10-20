// Isolated manual browser fixture: synthetic files and a simulated Shell launcher.
import {createHub} from '../src/server.mjs';
import {FileActions} from '../src/files.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const workspace=realpathSync.native(mkdtempSync(join(tmpdir(),'starport-file-ui-')));
for(const relative of ['地下城自走棋/莉芙攻击预览-离线-v07.html','地下城自走棋/打开莉芙攻击预览-v07.cmd','一号/重复说明.md','二号/重复说明.md']){
  const file=join(workspace,relative);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'Synthetic browser fixture; never executed.');
}
const calls=[],fileActions=new FileActions({launch:async(action,path)=>{calls.push({action,path});return {ok:true,simulated:true,launchCount:calls.length};}});
const registry={list:async()=>Object.values(PROVIDERS).map(provider=>({...provider,installed:true,statusLabel:'隔离模拟测试'})),resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]})};
const hub=createHub({port:Number(process.env.STARPORT_FILES_FIXTURE_PORT||3223),dataDir:join(workspace,'data'),registry,fileActions});
const chat=hub.store.newChat({provider:'claude',title:'文件路径验证（模拟）',workspace});
hub.store.message(chat.id,'assistant','claude','子目录文件：`莉芙攻击预览-离线-v07.html`\n\n同名文件：`重复说明.md`\n\n脚本文件：`打开莉芙攻击预览-v07.cmd`','complete');
console.log('Files UI fixture http://127.0.0.1:'+await hub.listen()+' (no native applications launched)');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await hub.close();process.exit(0);});

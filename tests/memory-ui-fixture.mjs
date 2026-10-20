// Isolated fake harnesses: no native login/model calls or production writes.
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'隔离模拟测试'}))};
const hub=createHub({port:3219,dataDir:mkdtempSync(join(tmpdir(),'starport-memory-ui-')),registry,implementations:Object.fromEntries(Object.keys(PROVIDERS).map(provider=>[provider,async({prompt,emit})=>{
  const evidence='我希望长期用中文交流';
  emit({type:'session',id:'fixture-'+provider});emit({type:'replace',text:prompt.includes('共同记忆（用户已确认')?'已读取你确认过的共同记忆。':'目前没有确认过的共同记忆。'});
  if(prompt.includes(evidence))emit({type:'delta',text:'\n```starport-memory\n'+JSON.stringify([{kind:'preference',title:'交流语言',content:'用户希望长期用中文交流。',evidence}])+'\n```'});
}]))});
const group=hub.store.group('共同记忆验证（模拟）');
for(const provider of Object.keys(PROVIDERS))hub.store.newChat({provider,title:PROVIDERS[provider].name+' 记忆测试',workspace:process.cwd(),group_id:group.id});
const chat=hub.store.list().chats[0],user=hub.store.message(chat.id,'user',chat.provider,'我想建立所有助手共享长期记忆的星港，也希望以友善的方式与所有模型协作。');
hub.store.memory.create({kind:'goal',title:'懂我的智能体集群',content:'用户希望星港提供跨助手长期记忆，让不同助手持续了解自己。'},{origin:'assistant',source:{chat,message:user,provider:chat.provider,evidence:user.content}});
hub.store.memory.create({kind:'value',title:'友善地对待模型',content:'用户希望以友善的方式与所有模型协作。'},{origin:'assistant',source:{chat,message:user,provider:chat.provider,evidence:'希望以友善的方式与所有模型协作'}});
console.log('Memory fixture http://127.0.0.1:'+await hub.listen());
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await hub.close();process.exit(0);});

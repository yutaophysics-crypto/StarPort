// Isolated simulated providers only. No native credentials, histories or model calls.
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'隔离模拟测试'}))};
const implementations=Object.fromEntries(Object.keys(PROVIDERS).map(provider=>[provider,async({prompt,contextTools,emit})=>{
  emit({type:'session',id:'fixture-'+provider});
  if(prompt.includes('检索采购')){const result=await contextTools.call('starport_history_search',{query:'采购预算'});const item=result.items[0];if(item){const source=await contextTools.call('starport_history_read',{chatId:item.chat_id,messageId:item.id});emit({type:'replace',text:'以前确定的采购预算是 123 元。\n\n[查看原对话]('+source.citation+')'});}else emit({type:'replace',text:'没有找到对应历史。'});}
  else emit({type:'replace',text:'已收到。'});
  if(prompt.includes('以后请详细作答')){await contextTools.call('starport_memory_propose',{kind:'preference',title:'交流方式',content:'用户以后希望详细作答。',evidence:'以后请详细作答',supersedes:memory.id});}
} ]));
const hub=createHub({port:3220,dataDir:mkdtempSync(join(tmpdir(),'starport-context-ui-')),registry,implementations});
const group=hub.store.group('共同记忆验证（模拟）'),project=hub.store.addProject('星港研发',process.cwd()),other=hub.store.addProject('独立项目',tmpdir());
hub.store.instructions.update(null,{revision:0,content:'请使用中文，清晰地区分事实和推测。'});hub.store.instructions.update(project.id,{revision:0,content:'星港开发：保留已有会话，优先验证实际界面。'});
const memory=hub.store.memory.create({kind:'preference',title:'交流方式',content:'用户希望简洁作答。'},{confirmed:true});
hub.store.memory.create({kind:'knowledge',title:'当前项目背景',content:'星港研发需要跨助手长期记忆。',project_id:project.id},{confirmed:true});
const source=hub.store.newChat({title:'采购决定',group_id:group.id,workspace:process.cwd()});hub.store.message(source.id,'user','codex','上次我们把采购预算定为123元。');hub.store.message(source.id,'assistant','codex','采购预算123元，下次继续比较具体方案。');
const outside=hub.store.newChat({title:'另一个项目的采购',project_id:other.id,group_id:group.id,workspace:tmpdir()});hub.store.message(outside.id,'user','claude','另一个项目采购预算是999元。');
for(const provider of Object.keys(PROVIDERS))hub.store.newChat({title:PROVIDERS[provider].name+' 检索验证',provider,group_id:group.id,workspace:process.cwd()});
console.log('Context fixture http://127.0.0.1:'+await hub.listen());
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await hub.close();process.exit(0);});

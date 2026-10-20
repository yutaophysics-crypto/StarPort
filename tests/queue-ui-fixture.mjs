// Isolated browser fixture: temporary database and fake providers only.
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'隔离模拟测试'}))};
const fake=provider=>async({emit,setControl,signal,prompt})=>{
  const text=prompt.trim().split('\n').at(-1),waiting=text==='开始测试';
  emit({type:'session',id:'fake-'+provider});
  if(!waiting){emit({type:'replace',text:'模拟任务已完成，收到消息：'+text});return;}
  let finish;const done=new Promise(resolve=>finish=resolve);
  setControl({inputMode:provider==='codex'?'steer':'queue',canSend:()=>true,stop:finish,steer:async(text)=>{
    emit({type:'notice',text:'当前模拟任务收到引导：'+text});if(text.includes('结束测试'))finish();return {delivery:'accepted'};
  }});
  emit({type:'replace',text:'隔离模拟任务正在执行。普通消息只进入等待队列，点击“引导”才加入当前 Codex 任务。'});
  emit({type:'tool',id:'read',name:'模拟任务',status:'running'});
  const pulse=setInterval(()=>emit({type:'activity',item:{id:'pulse',kind:'reasoning',status:'running',text:'模拟任务仍在工作'}}),2000);
  try{await done;if(signal.aborted)throw Object.assign(Error('模拟任务已停止'),{canceled:true});emit({type:'tool',id:'read',status:'complete'});emit({type:'replace',text:'模拟任务已完成，接下来处理等待队列。'});}
  finally{clearInterval(pulse);}
};
const hub=createHub({port:3218,dataDir:mkdtempSync(join(tmpdir(),'starport-queue-ui-')),registry,implementations:Object.fromEntries(Object.keys(PROVIDERS).map(id=>[id,fake(id)]))});
const group=hub.store.group('队列验证（模拟）');
for(const provider of Object.keys(PROVIDERS))hub.store.newChat({provider,title:PROVIDERS[provider].name+' 队列测试',workspace:process.cwd(),group_id:group.id});
console.log('Queue UI fixture http://127.0.0.1:'+await hub.listen()+' (all providers simulated)');
let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await hub.close();process.exit(0);});

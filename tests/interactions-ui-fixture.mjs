// Isolated browser fixture. All tools are simulated; no production data/models.
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const question='你说的“示例项目”是项目A吗？若编号不同，请告诉我。\n\n- 是项目A\n- 不确定编号\n\n“主目录一半、子目录一半”是新增文件各一半，还是整个项目最终各一半？\n\n- 新增文件各一半\n- 整个项目最终各一半\n- 还没想清楚';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'隔离测试 · 交互'}))};
const fake=provider=>async({emit,setControl,signal,prompt})=>{
  let finish,accepted=false;const done=new Promise(resolve=>finish=resolve),queued=[];
  const native=prompt.endsWith('原生问答测试');
  setControl({inputMode:provider==='codex'?'steer':'queue',canSend:()=>true,stop:finish,steer:async(text,{id})=>{
    if(provider!=='codex')queued.push({id,text});
    emit({type:'notice',text:'隔离测试收到消息：'+text});if(text.includes('结束测试'))finish();
    return {delivery:provider==='codex'?'accepted':'queued'};
  },answer:async(id,response)=>{if(id!=='fixture-question')throw Error('问题已失效');accepted=true;emit({type:'approval-resolved',id});emit({type:'notice',text:'原生回答：'+JSON.stringify(response.answers)});finish();}});
  if(native)emit({type:'approval',request:{id:'fixture-question',provider,kind:'question',params:{title:'原生问答测试',questions:[{id:'native-q',question:'要验证哪些功能？',multiSelect:true,options:[{label:'问题选择'},{label:'运行中补充消息'}]}]}}});
  else {emit({type:'replace',text:question+'\n\n我会继续检查资料，你可以在下方回答。'});emit({type:'activity',item:{id:'question-text',kind:'text',status:'complete',text:question}});}
  emit({type:'tool',id:'read',name:'模拟查看资料',status:'running'});
  const timer=setTimeout(finish,600000);
  try{await done;if(signal.aborted)throw Object.assign(Error('已停止'),{canceled:true});
    for(const row of queued)emit({type:'input-consumed',id:row.id});
    emit({type:'tool',id:'read',status:'complete'});emit({type:'replace',text:native&&accepted?'原生回答已收到，模拟任务已完成。':'补充消息已收到，模拟任务已完成。'});
  }finally{clearTimeout(timer);}
};
const hub=createHub({port:3217,dataDir:mkdtempSync(join(tmpdir(),'starport-interactions-ui-')),registry,implementations:Object.fromEntries(Object.keys(PROVIDERS).map(id=>[id,fake(id)]))});
const group=hub.store.group('交互验证（模拟）');
for(const provider of Object.keys(PROVIDERS)){
  const chat=hub.store.newChat({provider,title:PROVIDERS[provider].name+' 交互测试',workspace:process.cwd(),group_id:group.id});
  const answer=hub.store.message(chat.id,'assistant',provider,question,'complete',{});
  if(provider==='claude')hub.store.chatStatus.read(chat.id,answer.id);
}
const working=hub.store.newChat({provider:'codex',title:'运行中 · 模拟任务',workspace:process.cwd(),group_id:group.id});
await hub.runner.start(working.id,'工作测试');
const native=hub.store.newChat({provider:'claude',title:'原生提问 · 模拟任务',workspace:process.cwd(),group_id:group.id});
await hub.runner.start(native.id,'原生问答测试');
console.log('Interactions UI fixture http://127.0.0.1:'+await hub.listen()+' (all providers simulated)');

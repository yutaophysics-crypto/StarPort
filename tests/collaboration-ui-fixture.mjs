// Isolated demo for browser QA. Fake accounts and tools; no real CLI credentials.
import { createCollaborationHub } from '../src/collaboration/server.mjs';
import { DesktopWorker } from '../src/collaboration/desktop.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp=()=>mkdtemp(join(tmpdir(),'starport-group-ui-'));
const hub=createCollaborationHub({dataDir:await temp(),port:Number(process.env.STARPORT_GROUP_UI_PORT||3219)});await hub.listen();
const alice=await hub.store.register({username:'demo-alice',name:'Alice',password:'demo-password-alice'}),bob=await hub.store.register({username:'demo-bob',name:'Bob',password:'demo-password-bob'});
const room=hub.store.createRoom(alice.user.id,{name:'移动端验证 · 模拟工具'});hub.store.join(bob.user.id,{token:hub.store.invite(alice.user.id,room.id).token});
hub.store.send(alice.user.id,room.id,{content:'这个群聊用于隔离界面验证。两位成员分别绑定各自的电脑；这里的 Agent 回复是模拟数据。',clientId:'welcome'});
const workers=[];
const fake=async({prompt,emit,setControl,signal})=>{
  const input=prompt.split('本次调用请求：\n').at(-1);let release;const stopped=new Promise(resolve=>release=resolve);setControl({stop:release,answer:async(id,value)=>{emit({type:'approval-resolved',id});release();}});
  emit({type:'tool',id:'file',name:'检查工作目录',status:'running'});await Promise.race([new Promise(resolve=>setTimeout(resolve,900)),stopped]);
  if(input.includes('APPROVE')){emit({type:'approval',request:{id:'approve',kind:'permission',title:'允许运行测试命令？',params:{command:'echo fixture'}}});await stopped;}
  if(input.includes('QUESTION')){emit({type:'approval',request:{id:'question',kind:'question',title:'选择检查范围',params:{questions:[{id:'scope',question:'要检查哪些内容？',multiSelect:true,options:[{label:'界面'},{label:'调用流程'}]}]}}});await stopped;}
  if(input.includes('WAIT'))await stopped;
  if(signal.aborted)throw Object.assign(Error('已停止'),{canceled:true});
  emit({type:'tool',id:'file',name:'检查工作目录',status:'complete'});
  if(input.includes('FAIL'))throw Error('模拟工具失败');
  emit({type:'replace',text:'## 模拟任务已完成\n\n已在调用者绑定的电脑上处理请求：'+input+'\n\n- 群聊成员共享这条回复\n- 模型登录由调用者提供\n\n```text\n这是隔离界面测试，没有调用真实模型。\n```'});
};
for(const owner of [alice,bob]){
  const registration=hub.store.registerDevice(owner.user.id,{name:owner.user.name+' 的电脑'});hub.store.bind(owner.user.id,{deviceId:registration.id});const folder=await temp();
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({installed:true,loggedIn:true}),models:async()=>({models:[{id:'fixture-model',label:'模拟模型'}]}),record:()=>{}};
  const worker=new DesktopWorker({link:{hubUrl:hub.origin(),user:owner.user,deviceId:registration.id,token:registration.token,execution:'edit',workspaces:[{id:'demo-workspace',name:'自己的工作目录',path:folder}]},registry,dataDir:await temp(),interval:500,implementations:Object.fromEntries(['codex','claude','antigravity','deepseek'].map(id=>[id,fake]))});await worker.start();workers.push(worker);
}
console.log(hub.origin()+' — isolated UI demo; demo-alice / demo-password-alice, demo-bob / demo-password-bob');
let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;for(const worker of workers)await worker.close();await hub.close();process.exit(0);});

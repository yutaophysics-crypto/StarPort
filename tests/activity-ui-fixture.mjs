import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true,nativeGoal:true,nativePlan:true}),record:()=>{},
  models:async()=>({source:'native',models:[]}),list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'隔离测试环境',nativePlan:true}))};
let turn=0;
async function fake({emit,setControl,signal,prompt,provider}){
  let resolve;const wait=new Promise(r=>resolve=r),id='approval-'+(++turn);
  setControl({stop:()=>resolve('stop'),answer:async(requestId,answer)=>{if(requestId!==id)throw new Error('请求已失效');emit({type:'approval-resolved',id});resolve(answer.decision);}});
  emit({type:'activity',item:{id:'thinking-'+id,kind:'thinking',nativeType:provider==='codex'?'reasoning':'thinking',text:'Checking the project structure before running the tests.\n\nOnly the native exposed summary is shown.',status:'complete'}});
  const commandId='cmd-'+id;emit({type:'activity',item:{id:'intro-'+id,kind:'text',text:'我会先检查运行环境，再验证界面。',status:'complete'}});
  emit({type:'tool',id:commandId,name:provider==='claude'?'PowerShell':'commandExecution',nativeType:provider==='codex'?'commandExecution':'tool_use',status:'pending',input:{command:'node --version'},cwd:process.cwd()});
  const childId='child-'+id,childScope=provider==='claude'?'delegate-'+id:childId,startedAt=Date.now();
  emit({type:'subagent',id:childId,scope:childScope,name:'Layout reviewer',task:'检查原生事件、布局和子任务结果回传',status:'running',startedAt,updatedAt:startedAt});
  emit({type:'activity',item:{id:'child-think-'+id,scope:childScope,kind:'thinking',text:'Read the native public event contract. Child exposed summary.',status:'running'}});
  emit({type:'tool',id:'child-read-'+id,scope:childScope,name:'read_file',status:'running',input:{path:'public/activity.js'},output:'Child working output'});
  const questions=prompt.includes('QUESTION');
  emit({type:'approval',request:{id,provider,kind:questions?'question':'permission',params:questions?{questions:[{id:'0',question:'选择要执行的验证',header:'验证',multiSelect:true,options:[{label:'单元测试',description:'验证原生事件和审批流程'},{label:'浏览器测试',description:'验证界面与实时更新'}]}]}:{toolName:'PowerShell',input:{command:'node --version'},cwd:process.cwd(),reason:'原工具要求批准这次命令。'}}});
  // A background update must not replace a partially filled approval form.
  const timer=setInterval(()=>emit({type:'activity',item:{id:'background-'+id,kind:'status',name:'Waiting for user',status:'pending'}}),600);timer.unref();
  const decision=await wait;clearInterval(timer);
  if(decision==='stop'||signal.aborted)throw Object.assign(new Error('已停止'),{canceled:true});
  emit({type:'activity',item:{id:'child-think-'+id,status:'complete'}});
  emit({type:'tool',id:'child-read-'+id,status:'complete',output:'Child result: native events checked.\nEND_OF_CHILD_OUTPUT'});
  emit({type:'subagent',id:childId,status:'complete',activity:'检查完成，已回传结果',updatedAt:Date.now()});
  emit({type:'tool',id:commandId,status:decision==='decline'?'denied':'complete',output:decision==='decline'?'User denied this operation':'v24.14.0\n'+'Full output line\n'.repeat(400)+'END_OF_FULL_OUTPUT',exitCode:decision==='decline'?undefined:0});
  emit({type:'activity',item:{id:'final-'+id,kind:'text',text:decision==='decline'?'这次操作已拒绝。':'验证完成。公式 $E=mc^2$。',status:'complete'}});
  emit({type:'replace',text:decision==='decline'?'这次操作已拒绝。':'验证完成。公式 $E=mc^2$。'});
  emit({type:'final-answer',text:decision==='decline'?'这次操作已拒绝。':'验证完成。公式 $E=mc^2$。'});
}
const hub=createHub({port:Number(process.env.STARPORT_ACTIVITY_TEST_PORT||3212),dataDir:mkdtempSync(join(tmpdir(),'starport-activity-ui-')),registry,implementations:Object.fromEntries(Object.keys(PROVIDERS).map(id=>[id,fake]))});
const group=hub.store.group('原生过程验证');
for(const id of ['codex','claude','antigravity','deepseek']){
  const chat=hub.store.newChat({title:PROVIDERS[id].name+' 过程',provider:id,workspace:process.cwd(),group_id:group.id});
  hub.store.message(chat.id,'user',id,'检查原生过程','complete');
  hub.store.message(chat.id,'assistant',id,'已检查。','complete',{activity:[
    {id:'thinking',kind:'thinking',nativeType:id==='codex'?'reasoning':'thinking',text:'Inspect the native event stream.\n\nKeep reasoning separate from the answer.',status:'complete'},
    {id:'intro',kind:'text',text:'先检查项目，再运行验证。',status:'complete'},
    {id:'tool',kind:'tool',name:id==='claude'?'Read':id==='antigravity'?'view_file':id==='deepseek'?'read_file':'commandExecution',nativeType:id==='codex'?'commandExecution':'tool',input:id==='codex'?'node --version':{path:'src/runner.mjs'},output:'Native output\nEND_OF_FULL_OUTPUT',status:'complete',exitCode:id==='codex'?0:undefined},
    {id:'fail',kind:'tool',name:'validation',status:'error',output:'Example failure'},
    {id:'denied',kind:'tool',name:'permission',status:'denied',input:{command:'pending command'}},
    {id:'unknown',kind:'tool',name:'unconfirmed',status:'unknown'},
    {id:'final',kind:'text',text:'已检查。',status:'complete'}]});
}
const actualPort=await hub.listen();console.log('Activity UI fixture http://127.0.0.1:'+actualPort);

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { JsonRpc } from '../process.mjs';
import { nativeSubagentStatus } from '../subagents.mjs';
import { DeepseekLifecycle } from './deepseek-lifecycle.mjs';
import { isDeepseekDesktop, deepseekDesktopMetadata } from '../deepseek-desktop.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export async function deepseekSelection(options,runtime,cwd) {
  if(isDeepseekDesktop(runtime))return resolveDeepseekSelection(options,(await deepseekDesktopMetadata(runtime,cwd)).selection);
  let saved={};
  try {
    const yaml=await import(pathToFileURL(join(root,'.runtime/deepseek/node_modules/js-yaml/dist/js-yaml.mjs')).href);
    const settings=yaml.load(await readFile(join(process.env.DSH_HOME||join(homedir(),'.dsh'),'settings.yaml'),'utf8'));
    saved=settings?.['agent-default-model']||{};
  }catch{}
  return resolveDeepseekSelection(options,saved);
}

export function resolveDeepseekSelection(options,saved={}) {
  const provider=options.provider||saved.provider||'deepseek-official',model=options.model||saved.model||'deepseek-flash';
  // A saved effort belongs to its saved model, never to a different selection.
  const effort=options.effort||(provider===saved.provider&&model===saved.model?saved.reasoningEffort:undefined);
  return {provider,model,...effort?{reasoningEffort:effort}:{}};
}

export function parseDeepseekEvent(event,state={}) {
  const data=event.data||{},out=[];
  if(event.type==='assistant/message'){
    const text=(data.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    if(text)state.lastAssistantText=text;
    if(text)out.push({type:'delta',text:text+'\n\n'});
    state.messageIndex=(state.messageIndex||0)+1;
    const id=data.message?.id||`ds:${data.turn??state.turn??1}:${data.step??state.step??1}:${event.seq??state.messageIndex}`;
    for(const [index,block] of (data.message?.content||[]).entries()){
      if(['text','reasoning'].includes(block.type))out.push({type:'activity',item:{id:id+':'+index,kind:block.type==='reasoning'?'thinking':'text',nativeType:block.type,text:block.text||'',status:data.interrupted?'interrupted':'complete',stepIndex:data.step}});
    }
    if(data.usage)out.push({type:'usage',usage:data.usage});
  }
  if(event.type==='step/start'){
    state.turn=data.turn;state.step=data.step;state.messageIndex=0;
    const step={type:'tool',id:`step-${data.turn}-${data.step}`,kind:'step',name:`步骤 ${data.step}`,status:'running'};
    if(data.turn>1)step.note=`第 ${data.turn} 轮`;
    out.push(step);
  }
  if(event.type==='step/end')out.push({type:'tool',id:`step-${data.turn}-${data.step}`,kind:'step',name:`步骤 ${data.step}`,status:'complete'});
  if(event.type==='tool/call')out.push({type:'tool',id:data.callId,kind:'tool',name:data.name,input:data.arguments,status:'running'});
  if(event.type==='tool/result'){
    // Real SDK shape (captured from live sessions): the call id lives on the
    // nested tool-result block (and on message.source.callId), and the text is
    // nested one level deeper; isError sits on the block, not on message.
    const msg=data.message||{};
    const block=msg.content?.find(b=>b.type==='tool-result');
    const id=block?.toolCallId||msg.toolCallId||msg.source?.callId;
    const text=((block?.content||msg.content)||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    if(id)out.push({type:'tool',id,status:block?.isError||msg.isError?'error':'complete',
      output:text||(data.meta?JSON.stringify(data.meta,null,2):''),...(data.meta?{meta:data.meta}:{})});
  }
  if(event.type==='turn/end')out.push({type:'end',reason:typeof data.reason==='string'?{kind:data.reason}:data.reason});
  return out;
}
const promptBlocks=(text,images=[])=>[{type:'text',text},...images.map(image=>({type:'image',data:image.data,mimeType:image.mime}))];

export async function runDeepseek({runtime,options,prompt,contextEnv={},images=[],cwd,signal,emit,setControl}) {
  const sessionId='hub-'+randomUUID(),lifecycle=new DeepseekLifecycle(sessionId);
  let rpc,canceled=false,accepting=false,finished=false,dispatching=false,resolveEnd,completionCheck,closing;const eventState={},children=lifecycle.children,queued=[];
  const complete=new Promise(resolve=>{resolveEnd=resolve;});
  const finish=reason=>{finished=true;accepting=false;resolveEnd(reason);};
  const close=()=>closing??=(rpc?rpc.close():Promise.resolve());
  const stop=async()=>{canceled=true;await close();};
  const onAbort=()=>{stop().catch(()=>{});};
  const checkCompletion=()=>{
    clearImmediate(completionCheck);
    // Fold the current notification batch first. Completion still requires
    // native idle, settled children and their parent result handoff, never a
    // silence timeout or an assistant's promise to return later.
    completionCheck=setImmediate(async()=>{
      const reason=lifecycle.completion();if(!reason||canceled||finished||dispatching)return;
      if(reason.kind==='completed'&&queued.length){
        const next=queued.shift();dispatching=true;
        lifecycle.parent.requiredTurn=Math.max(lifecycle.parent.requiredTurn,lifecycle.parent.turn+1);
        try{
          await rpc.request('session/prompt',{sessionId,contentBlocks:promptBlocks(next.text,next.images)});
          emit({type:'input-consumed',id:next.id});
        }catch(error){finish({kind:'error',error:{message:error.message}});}
        finally{dispatching=false;checkCompletion();}return;
      }
      finish(reason);
    });
  };
  try{
    rpc=new JsonRpc(runtime.command,[...runtime.prefixArgs,'--profile','sdk'],{cwd,env:{...contextEnv,...runtime.env,DSH_MAX_TOKENS_AS_SUCCESS:'false'},
      onEvent(method,params){
        lifecycle.observe(method,params);checkCompletion();
        if(method==='subagent.started'&&(params.parentSessionId===sessionId||children.has(params.parentSessionId))){
          emit({type:'subagent',id:params.childSessionId,parentId:params.parentSessionId,name:'Subagent',depth:children.get(params.childSessionId).depth,status:'running',updatedAt:Date.now(),source:'deepseek-sdk'});return;
        }
        if(method==='subagent.finished'&&children.has(params.childSessionId)){
          emit({type:'subagent',id:params.childSessionId,status:params.stopReason==='aborted'?'interrupted':params.status==='ok'?'complete':'error',activity:params.stopReason||'',updatedAt:Date.now(),source:'deepseek-sdk'});return;
        }
        const child=children.get(params.sessionId);
        if(params.sessionId!==sessionId&&!child)return;
        if(method==='session.status'&&child){emit({type:'subagent',id:params.sessionId,...params.status==='running'?{status:nativeSubagentStatus(params.status)}:{activity:params.status},updatedAt:Date.now(),source:'deepseek-sdk'});return;}
        if(method==='session.event'){
          if(!child&&params.event.type==='turn/start')eventState.lastAssistantText='';
          if(!child&&params.event.type==='turn/end'&&eventState.lastAssistantText)
            emit({type:'final-answer',text:eventState.lastAssistantText});
          if(params.event.type==='subagent/catalog'){
            const known=children.get(params.event.data?.childId);
            if(known?.name)emit({type:'subagent',id:params.event.data.childId,name:known.name,task:known.name,updatedAt:Date.now(),source:'deepseek-sdk'});
          }
          for(const event of parseDeepseekEvent(params.event,child?.state||eventState)){
            if(child){
              if(event.type==='tool')emit({...event,id:params.sessionId+':'+event.id,scope:params.sessionId});
              if(event.type==='activity')emit({...event,item:{...event.item,id:params.sessionId+':'+event.item.id,scope:params.sessionId}});
              continue;
            }
            if(event.type!=='end')emit(event);
          }
        }
      },onRequest(request){rpc.respondError(request.id,'此 SDK 接口尚未提供交互审批支持');}
    });
    setControl({stop,inputMode:'queue',canSend:()=>accepting&&!canceled,steer:async(text,{id,images=[]})=>{
      if(!accepting||canceled)throw new Error('当前任务已结束；输入已保留，请重新发送。');
      queued.push({text,id,images});return {delivery:'queued'};
    }});signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted){await stop();throw Object.assign(new Error('已停止'),{canceled:true});}
    const selection=await deepseekSelection(options,runtime,cwd);
    await rpc.request('initialize',{cwd,...selection},120000);
    emit({type:'session',id:sessionId,model:selection.model});
    await rpc.request('session/prompt',{sessionId,contentBlocks:promptBlocks(prompt,images)});
    accepting=!finished;emit({type:'input-state'});
    const reason=await Promise.race([complete,rpc.closed.then(error=>{throw error;})]);
    if(reason?.kind!=='completed')throw new Error(reason?.error?.message||`DeepSeek 执行未完成：${reason?.kind||'unknown'}`);
    await rpc.request('shutdown',{},15000);
  }catch(error){if(canceled)error.canceled=true;throw error;}
  finally{accepting=false;clearImmediate(completionCheck);signal?.removeEventListener('abort',onAbort);await close();}
}

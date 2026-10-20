import { nativeStatus, blockText } from '../activity.mjs';

export function parseCodexActivity(method,p,state={}) {
  const out=[],activity=item=>out.push({type:'activity',item});
  if(method==='item/agentMessage/delta'||method==='item/plan/delta')out.push({type:'activity',item:{id:p.itemId,turnId:p.turnId,kind:method==='item/plan/delta'?'plan':'text',nativeType:method==='item/plan/delta'?'plan':'agentMessage',status:'running'},delta:p.delta||''});
  if(method==='item/reasoning/summaryTextDelta'){
    state.summaries??={};const row=state.summaries[p.itemId]??=[];
    row[p.summaryIndex??0]=(row[p.summaryIndex??0]||'')+(p.delta||'');
    activity({id:p.itemId,kind:'thinking',nativeType:'reasoning',text:row.filter(Boolean).join('\n\n'),status:'running'});
  }
  // item/reasoning/textDelta and item.reasoning.content are raw protocol blocks.
  // Codex's public UI uses only the exposed summary.
  if(method==='item/commandExecution/outputDelta')out.push({type:'activity',item:{id:p.itemId,kind:'tool',nativeType:'commandExecution',status:'running'},field:'output',delta:p.delta||''});
  if(method==='turn/plan/updated')activity({id:'plan:'+p.turnId,kind:'plan',nativeType:'turnPlan',plan:p.plan||[],text:p.explanation||'',status:'complete'});
  if(method==='turn/diff/updated')activity({id:'diff:'+p.turnId,kind:'diff',nativeType:'turnDiff',text:p.diff||'',status:'complete'});
  if(method==='item/started'||method==='item/completed'){
    const item=p.item||{},done=method==='item/completed',status=nativeStatus(item.status,done,item.success===false||done&&Number(item.exitCode)!==0&&item.exitCode!=null);
    if(['agentMessage','plan'].includes(item.type))activity({id:item.id,turnId:p.turnId,kind:item.type==='plan'?'plan':'text',nativeType:item.type,text:item.text,phase:item.phase,status});
    else if(item.type==='reasoning'){
      const summaries=(item.summary||[]).map(part=>typeof part==='string'?part:part.text||'').filter(Boolean);
      if(summaries.length){state.summaries??={};state.summaries[item.id]=summaries;}
      activity({id:item.id,kind:'thinking',nativeType:'reasoning',...(summaries.length?{text:summaries.join('\n\n')}:{}) ,status});
    }else if(item.type!=='userMessage'){
      const name=typeof item.tool==='string'?item.tool:item.tool?.name||item.name||item.agentPath||item.type;
      out.push({type:'tool',id:item.id,name,kind:['subAgentActivity','enteredReviewMode','exitedReviewMode','contextCompaction'].includes(item.type)?'step':'tool',nativeType:item.type,status,
        input:item.arguments??item.command??item.query??item.changes??item.prompt??item.file??item.input,
        output:item.aggregatedOutput??item.error?.message??(typeof item.result==='string'?item.result:item.result?.output)??(item.contentItems?.length?blockText(item.contentItems):undefined)??item.output,
        cwd:item.cwd,exitCode:item.exitCode,durationMs:item.durationMs,changes:item.changes,action:item.action,server:item.server,
        note:item.type==='subAgentActivity'?item.kind:undefined,scope:item.parentId||item.parentToolCallId});
      if(item.type==='collabAgentToolCall'||item.type==='subAgentActivity'){
        state.children??={};
        const ids=item.type==='collabAgentToolCall'?item.receiverThreadIds||[]:[item.agentThreadId];
        for(const id of ids.filter(Boolean)){
          const previous=state.children[id]||{},native=item.agentsStates?.[id],value=native?.status;
          const status=value==='completed'?'complete':value==='errored'?'error':value==='interrupted'?'interrupted':value==='shutdown'||value==='notFound'?(['complete','error','interrupted'].includes(previous.status)?previous.status:'unknown'):value==='running'||value==='pendingInit'?'running':item.kind==='completed'?'complete':item.kind==='interrupted'?'interrupted':previous.status||'running';
          const update={id,parentId:item.senderThreadId||p.threadId,status,...item.agentPath?{name:item.agentPath}:{},...item.tool==='spawnAgent'?{scope:item.id,task:item.prompt||''}:{},...native?.message?{activity:native.message}:{},updatedAt:Date.now(),source:'codex-app-server'};
          state.children[id]={...previous,...update};out.push({type:'subagent',...update});
        }
      }
    }
  }
  return out;
}

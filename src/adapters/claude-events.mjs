import { claudeContext, contextSample } from '../context.mjs';
import { blockText, nativeStatus } from '../activity.mjs';

export function isPreviousSessionTaskNotice(e,state={}) {
  return e.type==='system'&&e.subtype==='task_notification'&&!state.tasks?.[e.task_id]&&
    (e.reason==='worker_restart'||
      // Older producers did not include the machine-readable restart reason.
      e.summary==="Background shell command didn't finish before the previous session ended"||
      e.summary==='Orphaned by a previous Claude Code process exit and reported in an aggregate summary.');
}

export function parseClaudeEvent(e,state={}) {
  const events=[],emit=(type,data)=>events.push({type,...data});
  const scope=e.parent_tool_use_id||null;
  state.streams??={};const stream=state.streams[scope||'root']??={};
  const activity=(id,kind,fields={},delta)=>emit('activity',{item:{id,kind,scope,...fields},...(delta!==undefined?{delta}:{})});
  if(e.type==='system'&&e.subtype==='init'){
    if(state.model!==e.model)state.windowTokens=null;state.model=e.model;emit('session',{id:e.session_id,model:e.model});
  }
  const message=e.type==='assistant'?e.message:e.type==='stream_event'&&e.event?.type==='message_start'?e.event.message:null;
  if(!scope&&message?.model&&message.model!==state.model){state.model=message.model;state.windowTokens=null;state.requestUsage=null;}
  if(!scope&&message?.usage){state.requestUsage=message.usage;emit('context',{context:claudeContext(state.requestUsage,state.windowTokens,state.model)});}
  if(e.type==='system'&&(e.subtype==='compact_boundary'||e.subtype==='status'&&e.status==='compacting')){
    state.requestUsage=null;emit('context',{context:contextSample({windowTokens:state.windowTokens,model:state.model,basis:'claude-input',status:e.subtype==='compact_boundary'?'waiting':'compacting'})});
    activity('compact-'+(e.uuid||e.session_id),'status',{name:'contextCompaction',status:e.subtype==='compact_boundary'?'complete':'running'});
  }
  if(e.type==='system'&&e.subtype==='api_retry')emit('notice',{text:`服务重试 ${e.attempt}/${e.max_retries}: ${e.error||''}`});
  if(e.type==='stream_event'){
    const event=e.event||{},index=event.index??0;
    if(event.type==='message_start'){stream.id=event.message?.id||e.uuid;stream.blocks={};stream.hasDelta=false;}
    stream.blocks??={};
    if(event.type==='content_block_start'){
      const block=event.content_block||{};stream.blocks[index]={...block,id:block.id||`${stream.id||e.uuid||'claude'}:${index}:${block.type}`};
      const id=stream.blocks[index].id;
      if(block.type==='tool_use')emit('tool',{id,name:block.name,input:block.input,status:'running',nativeType:'tool_use',scope});
      if(block.type==='text')activity(id,'text',{text:block.text||'',status:'running',nativeType:'text'});
      if(block.type==='thinking')activity(id,'thinking',{text:block.thinking||'',status:'running',nativeType:'thinking'});
    }
    if(event.type==='content_block_delta'||event.delta){
      const block=stream.blocks[index]??={id:`${stream.id||e.uuid||'claude'}:${index}`},delta=event.delta||{};
      if(delta.type==='text_delta'){
        stream.hasDelta=true;block.hasDelta=true;block.type='text';block.text=(block.text||'')+(delta.text||'');if(!scope)emit('delta',{text:delta.text});
        activity(block.id,'text',{status:'running',nativeType:'text'},delta.text||'');
      }
      if(delta.type==='thinking_delta'){block.type='thinking';block.thinking=(block.thinking||'')+(delta.thinking||'');activity(block.id,'thinking',{status:'running',nativeType:'thinking'},delta.thinking||'');}
      if(delta.type==='input_json_delta'){
        block.json=(block.json||'')+(delta.partial_json||'');
        emit('tool',{id:block.id,status:'running',inputPartial:block.json,scope,nativeType:'tool_use'});
      }
      // Signatures and redacted thinking are protocol data, never display text.
    }
    if(event.type==='content_block_stop'){
      const block=stream.blocks[index];
      if(block?.type==='tool_use'&&block.json){try{emit('tool',{id:block.id,input:JSON.parse(block.json),inputPartial:'',scope});}catch{}}
      else if(block)activity(block.id,block.type==='thinking'?'thinking':'text',{status:'complete'});
    }
  }
  if(e.type==='assistant'){
    const messageId=e.message?.id||stream.id||e.uuid||'claude';
    const content=e.message?.content,blocks=typeof content==='string'?[{type:'text',text:content}]:Array.isArray(content)?content:[];
    for(const [index,block] of blocks.entries()){
      // CLI publishes one completed block at a time, often reusing the same
      // message id. Its content array index is not the original stream index.
      const match=Object.values(stream.blocks||{}).find(value=>value.type===block.type&&
        (block.type==='tool_use'?value.id===block.id:block.type==='text'?value.text===block.text:value.thinking===block.thinking));
      const id=block.id||match?.id||`${e.uuid||messageId}:${index}:${block.type}`;
      if(block.type==='text'){
        stream.fullTexts??={};
        if(!scope&&!match?.hasDelta&&!stream.hasDelta&&stream.fullTexts[id]!==block.text)emit('delta',{text:block.text});
        stream.fullTexts[id]=block.text;
        activity(id,'text',{text:block.text||'',status:'complete',nativeType:'text'});
      }
      if(block.type==='thinking')activity(id,'thinking',{text:block.thinking||'',status:'complete',nativeType:'thinking'});
      if(block.type==='tool_use')emit('tool',{id,name:block.name,status:'running',input:block.input,inputPartial:'',nativeType:'tool_use',scope});
    }
    stream.hasDelta=false;
  }
  if(e.type==='user'&&Array.isArray(e.message?.content))for(const block of e.message.content)if(block.type==='tool_result'){
    emit('tool',{id:block.tool_use_id,status:block.is_error?'error':'complete',output:blockText(block.content),nativeType:'tool_use',scope});
  }
  if(e.type==='tool_progress')emit('tool',{id:e.tool_use_id,name:e.tool_name,status:'running',durationMs:e.elapsed_time_seconds*1000,scope,nativeType:'tool_use'});
  if(e.type==='system'&&['task_started','task_progress','task_updated','task_notification'].includes(e.subtype)){
    if(isPreviousSessionTaskNotice(e,state)){
      emit('notice',{text:'上一轮有后台命令未完成。这是旧任务的通知，不表示本次请求已停止；旧命令是否留下结果需查看原日志。'});
      return events;
    }
    state.tasks??={};const task=state.tasks[e.task_id]??={};Object.assign(task,e.patch||{},e.subtype==='task_started'?{taskType:e.task_type,name:e.subagent_type||e.workflow_name||e.task_type,task:e.description,scope:e.tool_use_id,depth:e.spawn_depth}:{});
    if(e.ambient||e.skip_transcript)task.hidden=true;
    if(e.status||e.patch?.status)task.status=e.status||e.patch.status;
    const status=nativeStatus(task.status,e.subtype==='task_notification');
    if(!task.hidden){
    activity('claude-task:'+e.task_id,'task',{name:task.name||e.subagent_type||'Task',status,text:e.summary||e.description||task.description||task.task,output:e.subtype==='task_notification'?e.summary:undefined,durationMs:e.usage?.duration_ms,scope:task.scope,nativeType:task.taskType||e.subtype});
    if(task.taskType==='local_agent'||e.subagent_type)emit('subagent',{id:e.task_id,scope:task.scope,name:task.name||e.subagent_type,task:task.task||e.description,status,activity:e.summary||e.description||'',tool:e.last_tool_name,depth:(task.depth||1)-1,updatedAt:Date.now(),source:'claude-sdk'});
    }
  }
  if(e.type==='permission_denied'||e.type==='system'&&e.subtype==='permission_denied')emit('tool',{id:e.tool_use_id||e.toolUseID,name:e.tool_name,status:'denied',input:e.tool_input||e.input,output:e.message,scope:e.agent_id||scope});
  if(e.type==='result'&&!scope){
    state.terminal=true;if(e.session_id)emit('session',{id:e.session_id});
    if(e.result){emit('replace',{text:e.result});emit('final-answer',{text:e.result});}
    if(e.usage)emit('usage',{usage:e.usage});
    const modelUsage=e.modelUsage?.[state.model]||Object.values(e.modelUsage||{}).find(item=>state.model&&item.canonicalModel===state.model);
    if(modelUsage?.contextWindow){state.windowTokens=modelUsage.contextWindow;emit('context',{context:claudeContext(state.requestUsage,state.windowTokens,state.model)});}
    for(const denied of e.permission_denials||[])emit('tool',{id:denied.tool_use_id,name:denied.tool_name,input:denied.tool_input,status:'denied'});
    if(e.permission_denials?.length)emit('notice',{text:`${e.permission_denials.length} 个操作未获权限，未执行。`});
    if(e.is_error||(e.subtype&&e.subtype!=='success'))emit('error',{message:(e.errors||[]).join('\n')||e.result||e.subtype});
  }
  return events;
}

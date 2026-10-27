import { randomUUID } from 'node:crypto';
import { query,createSdkMcpServer,tool } from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import { childEnvironment, startProcess, stopProcess, redact } from '../process.mjs';
import { parseEvent } from './cli.mjs';
import { isPreviousSessionTaskNotice } from './claude-events.mjs';
import { prepareExternalClaude } from '../external-tools/claude-launch.mjs';
import { externalToolServers } from '../external-tools/claude-tools.mjs';

// Claude Code reports a background agent or workflow in a later native turn of
// the same session; `claude -p` holds its result for exactly these task types.
// Background shells end with the process there too, so they never hold a turn.
const HOLDING_TASKS=new Set(['local_agent','local_workflow']);

export async function runClaude({runtime,options,session,initialContext,prompt,contextTools,contextEnv={},images=[],cwd,signal,emit,setControl,makeQuery=query,sdkOptions={},backgroundSettleMs=30000}) {
  let stream,child,finishInput,wakeInput,externalCleanup,externalTools,canceled=false,accepting=true,failure='';
  const queued=[],inFlight=new Map();
  const abortController=new AbortController(),pending=new Map();
  const inputDone=new Promise(resolve=>finishInput=resolve);
  const state={model:initialContext?.model,windowTokens:initialContext&&Object.hasOwn(initialContext,'modelWindowTokens')?initialContext.modelWindowTokens:initialContext?.windowTokens};
  const initialId=randomUUID();
  let initialPending=true,modelActivity=false,previousTaskNotice=false,unrelatedResults=0;
  // After this request's own result, `waiting` keeps the native process for
  // background agents that report back in follow-up native turns.
  const background=new Map();
  let backgroundLevel=false,waiting=false,turnActive=true,settled=false,settleTimer=null,phase='answering',separate=false,lost='';
  const userContent=(text,images)=>{
    const content=images.length?[{type:'text',text},...images.map(image=>({type:'image',source:{type:'base64',media_type:image.mime,data:image.data}}))]:text;
    if(Buffer.byteLength(JSON.stringify(content))>10*1024*1024)throw new Error('Claude 图片输入超过 10 MB，请减少附件');
    return content;
  };
  const content=userContent(prompt,images);
  async function* input(){
    yield {type:'user',uuid:initialId,message:{role:'user',content},parent_tool_use_id:null,session_id:session||''};
    while(accepting&&!canceled){
      if(!queued.length){await Promise.race([new Promise(resolve=>wakeInput=resolve),inputDone]);wakeInput=null;}
      if(!accepting||canceled)break;
      const item=queued.shift();if(!item)continue;
      // `next` folds into the running turn at a tool boundary; `now` can abort it.
      yield {type:'user',message:{role:'user',content:item.content},uuid:item.id,parent_tool_use_id:null,session_id:state.sessionId||session||'',priority:'next'};
    }
  }
  function confirmInput(id){
    const item=inFlight.get(id);if(!item||item.delivered)return;
    item.delivered=true;emit({type:'input-consumed',id});
  }
  function trackBackground(message){
    if(message.type!=='system'||message.parent_tool_use_id)return;
    if(message.subtype==='background_tasks_changed'&&Array.isArray(message.tasks)){
      // Level signal with replace semantics; a missed edge cannot wedge it.
      backgroundLevel=true;background.clear();
      for(const task of message.tasks)if(!task.ambient)background.set(task.task_id,{type:task.task_type,description:task.description});
      return;
    }
    if(backgroundLevel)return;
    // Older CLIs only send the task edges.
    const task=state.tasks?.[message.task_id];
    if(message.subtype==='task_started'&&message.is_backgrounded&&!message.owned_by_subagent&&!message.ambient&&!message.skip_transcript)
      background.set(message.task_id,{type:message.task_type,description:message.description});
    if(message.subtype==='task_updated'&&message.patch?.is_backgrounded&&task&&!task.hidden)background.set(message.task_id,{type:task.taskType,description:task.task});
    if(message.subtype==='task_notification'||message.subtype==='task_updated'&&['completed','failed','killed'].includes(message.patch?.status))background.delete(message.task_id);
  }
  const holding=()=>[...background.values()].some(task=>HOLDING_TASKS.has(task.type));
  function watch(){
    const idle=waiting&&!turnActive&&!inFlight.size&&!holding();
    // The CLI starts its follow-up turn as the task settles. Without one, the
    // request is complete: finish rather than wait on a turn that never comes.
    if(idle&&!settleTimer){settleTimer=setTimeout(()=>{settled=true;accepting=false;finishInput();stream?.close();},backgroundSettleMs);settleTimer.unref?.();}
    if(!idle&&settleTimer){clearTimeout(settleTimer);settleTimer=null;}
    const next=waiting&&!turnActive?'background':'answering';
    if(next!==phase){phase=next;emit({type:'phase',phase});}
  }
  function releaseBackground(){
    const exit=lost?`Claude Code 在等待后台任务时提前退出（${redact(lost).slice(0,300)}）。`:'';
    if(!background.size){if(exit)emit({type:'notice',text:exit});return;}
    const now=Date.now(),names=[];
    for(const [id,item] of background){
      names.push(String(item.description||item.type||id).replace(/\s+/g,' ').slice(0,80));
      const task=state.tasks?.[id];if(!task||task.hidden)continue;
      emit({type:'activity',item:{id:'claude-task:'+id,kind:'task',status:'interrupted',scope:task.scope}});
      if(task.taskType==='local_agent')emit({type:'subagent',id,status:'interrupted',updatedAt:now,source:'claude-sdk'});
    }
    const list=names.slice(0,5).join('、')+(names.length>5?` 等 ${names.length} 个`:'');
    const shells=[...background.values()].every(item=>item.type==='local_bash');
    emit({type:'notice',text:canceled
      ?`已停止等待后台任务；这些任务随本轮一起停止，结果不会再返回：${list}。`
      :`${exit}本轮结束时仍在运行的后台${shells?'命令':'任务'}已随本轮停止：${list}。`+
        (shells?'星港在每轮结束时关闭 Claude Code（与 claude -p 相同），需要持续运行的服务请在终端里单独启动。':'')});
    background.clear();
  }
  function resolveRequest(id,result){
    const request=pending.get(id);if(!request)return;
    pending.delete(id);request.signal?.removeEventListener('abort',request.abort);
    request.resolve(result);emit({type:'approval-resolved',id});
  }
  const canUseTool=(toolName,toolInput,metadata)=>new Promise(resolve=>{
    const id=randomUUID(),toolUseID=metadata.toolUseID;
    const deny=message=>({behavior:'deny',message,toolUseID,decisionClassification:'user_reject'});
    if(canceled||metadata.signal?.aborted){resolve(deny('用户已停止本次执行。'));return;}
    const questions=toolName==='AskUserQuestion'?(toolInput.questions||[]).map((q,index)=>({...q,id:String(index)})):null;
    const request={id,resolve,input:toolInput,questions,toolUseID,signal:metadata.signal,deny};
    request.abort=()=>resolveRequest(id,deny('该权限请求已由原工具取消。'));
    pending.set(id,request);metadata.signal?.addEventListener('abort',request.abort,{once:true});
    emit({type:'tool',id:toolUseID||id,name:toolName,status:'pending',input:toolInput,nativeType:'tool_use',scope:metadata.agentID});
    emit({type:'approval',request:{id,provider:'claude',kind:questions?'question':'permission',method:'canUseTool',params:{toolName,input:toolInput,toolUseID,
      questions,title:metadata.title,description:metadata.description,reason:metadata.decisionReason,blockedPath:metadata.blockedPath,defaultToNo:metadata.defaultToNo,scope:metadata.agentID}}});
  });
  const stop=async()=>{
    if(canceled)return;
    canceled=true;accepting=false;
    for(const [id,request] of pending)resolveRequest(id,request.deny('用户已停止本次执行。'));
    finishInput();abortController.abort();stream?.close();if(child)await stopProcess(child);
  };
  setControl({stop,inputMode:'steer',canSend:()=>accepting&&!canceled,steer:async(text,{id,images=[]})=>{
    if(!accepting||canceled)throw new Error('当前任务已结束；输入已保留，请重新发送。');
    const item={id,text,content:userContent(text,images),delivered:false};inFlight.set(id,item);queued.push(item);wakeInput?.();return {delivery:'queued'};
  },answer:async(id,answer)=>{
    const request=pending.get(String(id));if(!request)throw new Error('该请求已失效');
    if(!['accept','decline','skip'].includes(answer.decision)||answer.decision==='skip'&&!request.questions)throw new Error('无效的审批选项');
    if(answer.decision==='decline'){
      emit({type:'tool',id:request.toolUseID||id,status:'denied'});
      resolveRequest(id,request.deny('用户在星港中拒绝了这次操作。'));return;
    }
    let updatedInput=request.input;
    if(request.questions&&answer.decision==='skip'){
      updatedInput={...request.input,answers:{},response:'用户跳过了这些问题，没有选择任何选项。请根据已有信息继续；涉及必须确认的操作时不要把跳过视为授权。'};
    }else if(request.questions){
      const answers={};
      for(const q of request.questions){
        const value=answer.answers?.[q.id];
        if(!(typeof value==='string'||q.multiSelect&&Array.isArray(value)&&value.every(v=>typeof v==='string'))||!value.length||JSON.stringify(value).length>10000)throw new Error('请输入问题的回答');
        // The SDK matches questions by their original question text.
        answers[q.question]=Array.isArray(value)?value.join(', '):value;
      }
      updatedInput={...request.input,answers};
    }
    emit({type:'tool',id:request.toolUseID||id,status:'running'});
    resolveRequest(id,{behavior:'allow',updatedInput,toolUseID:request.toolUseID,decisionClassification:'user_temporary'});
  }});
  signal?.addEventListener('abort',stop,{once:true});
  try{
    if(signal?.aborted){await stop();throw Object.assign(new Error('已停止'),{canceled:true});}
    const external=await prepareExternalClaude(runtime,cwd);runtime=external.runtime;externalCleanup=external.cleanup;
    const contextMcp=contextTools?createSdkMcpServer({name:'starport_context',version:'1.0.0',tools:contextTools.definitions.map(def=>{
      const shape={};for(const [key,schema]of Object.entries(def.inputSchema.properties)){let value=schema.enum?z.enum(schema.enum):schema.type==='array'?z.array(z.string()).min(schema.minItems||0).max(schema.maxItems||100):schema.type==='integer'?z.number().int():z.string();if(!(def.inputSchema.required||[]).includes(key))value=value.optional();shape[key]=value;}
      return tool(def.name,def.description,shape,async args=>{try{return {content:[{type:'text',text:JSON.stringify(await contextTools.call(def.name,args))}]};}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}});
    })}):null;
    externalTools=externalToolServers({runtime,cwd,signal:abortController.signal,canUseTool,emit});
    const hostServers={...sdkOptions.mcpServers,...contextMcp?{starport_context:contextMcp}:{},...externalTools.servers};
    const hostAllowed=[...(sdkOptions.allowedTools||[]),...contextMcp?contextTools.definitions.map(def=>'mcp__starport_context__'+def.name):[],...externalTools.allowed];
    stream=makeQuery({prompt:input(),options:{pathToClaudeCodeExecutable:runtime.command,cwd,abortController,
      settingSources:['user','project','local'],systemPrompt:{type:'preset',preset:'claude_code'},env:childEnvironment(),
      includePartialMessages:true,forwardSubagentText:true,permissionMode:options.permissionMode,permissionPrompts:'host',canUseTool,
      allowDangerouslySkipPermissions:options.permissionMode==='bypassPermissions',
      ...(options.model?{model:options.model}:{}),...(options.effort?{effort:options.effort}:{}),...(session?{resume:session}:{}),
      ...sdkOptions,env:childEnvironment({...sdkOptions.env,...contextEnv}),
      extraArgs:{...(!session&&options.worktree?{worktree:null}:{}),...sdkOptions.extraArgs,'replay-user-messages':null},
      ...(contextMcp||externalTools.allowed.length?{mcpServers:hostServers,allowedTools:hostAllowed}:{}),
      spawnClaudeCodeProcess:({args,cwd,env,signal})=>(child=sdkOptions.spawnClaudeCodeProcess?sdkOptions.spawnClaudeCodeProcess({args,cwd,env,signal}):startProcess(runtime.command,[...(runtime.prefixArgs||[]),...args],{cwd,env,signal}))}});
    try{for await(const message of stream){
      // Native echoes acknowledge delivery; a result identifies which inputs it
      // actually handled. Keep the process alive for a send racing the last result.
      if(message.type==='user'&&message.isReplay)confirmInput(message.uuid);
      if(isPreviousSessionTaskNotice(message,state))previousTaskNotice=true;
      const result=message.type==='result'&&!message.parent_tool_use_id;
      if(!message.parent_tool_use_id&&(result||['assistant','stream_event'].includes(message.type)||message.type==='system'&&message.subtype==='init'))turnActive=!result;
      const receiptIds=Array.isArray(message.user_message_uuids)&&message.user_message_uuids.length
        ?message.user_message_uuids:message.user_message_uuid?[message.user_message_uuid]:[];
      const ownsResult=receiptIds.some(id=>id===initialId||inFlight.has(id));
      const failed=result&&(message.is_error||message.subtype!=='success');
      // Resuming can finish a synthetic task-notification turn before the user's
      // queued prompt. A native result ends THAT turn, not necessarily this send.
      // Old CLIs have no UUID receipt: recognize only the observed no-model result,
      // with evidence of a previous task or a user prompt still in the native queue.
      const zeroWorkResult=result&&message.num_turns===0&&!message.local_command&&
        message.usage&&['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].every(key=>!message.usage[key]);
      // Current-turn output may already be interleaved with the old result.
      // Its presence does not make a previous worker's empty result our own.
      // While waiting, a result with model work is the background follow-up turn.
      if(result&&!failed&&!ownsResult&&(waiting?zeroWorkResult:receiptIds.length||zeroWorkResult&&(previousTaskNotice||message.queued_turn_count>0))){
        unrelatedResults++;
        if(message.session_id){state.sessionId=message.session_id;emit({type:'session',id:message.session_id});}
        emit({type:'diagnostic',code:'claude-unrelated-result',message:'忽略非本次请求的结束事件，继续等待用户请求。',resultIndex:message.result_index});
        watch();continue;
      }
      if(zeroWorkResult&&!modelActivity&&!failed)throw new Error('Claude Code 未对本次请求产生回答（零轮次、零用量）。请重试；任务没有被标记为完成。');
      if(!message.parent_tool_use_id&&(message.type==='assistant'||message.type==='stream_event'&&
        ['content_block_start','content_block_delta'].includes(message.event?.type)))modelActivity=true;
      if(message.type==='system'&&message.subtype==='init'&&message.permissionMode&&message.permissionMode!==options.permissionMode){
        if(options.permissionMode==='auto')throw new Error('Claude Code 未启用自动审核，请检查原工具的账号、模型和权限设置。');
        if(options.permissionMode==='bypassPermissions')throw new Error('Claude Code 未启用跳过权限审批，请检查原工具的权限设置。');
      }
      for(const event of parseEvent('claude',message,state)){
        if(event.type==='session')state.sessionId=event.id;
        // A continuation turn streams after the previous result's text.
        if(event.type==='delta'&&separate){separate=false;emit({type:'delta',text:'\n\n'});}
        if(event.type==='error')failure=event.message;else emit(event);
      }
      // Task state is read after parsing so edge events can use its names.
      trackBackground(message);
      if(state.terminal){
        initialPending=false;
        if(Array.isArray(message.user_message_uuids)){
          for(const id of message.user_message_uuids){confirmInput(id);inFlight.delete(id);}
          // The native UUID list is capped at 64; folded-input echoes remain
          // authoritative for acknowledged messages omitted from a full list.
          if(message.user_message_uuids.length>=64)for(const [id,item]of inFlight)if(item.delivered)inFlight.delete(id);
        }else{
          // Older CLIs echo folded messages but omit the full result UUID list.
          for(const [id,item]of inFlight)if(item.delivered||id===message.user_message_uuid){confirmInput(id);inFlight.delete(id);}
        }
        if(failure||!inFlight.size&&!holding()){accepting=false;finishInput();break;}
        if(!inFlight.size)waiting=true;
        state.terminal=false;
        modelActivity=false;separate=true;
      }
      watch();
    }}catch(error){
      // The answer is in: Stop, the settle timer or an exit only end the wait.
      if(!waiting||failure)throw error;
      if(!canceled&&!settled)lost=error.message||String(error);
    }
    if(canceled&&!waiting)throw Object.assign(new Error('已停止'),{canceled:true});
    if(failure)throw new Error(redact(failure));
    if(initialPending&&unrelatedResults)throw new Error('Claude Code 只返回了其他轮次的通知，本次请求尚未完成。请重试；星港没有自动重复执行任务。');
    if(!state.terminal&&!waiting)throw new Error('工具未返回完整的结束事件，结果已保留。');
    releaseBackground();
  }catch(error){if(canceled)error.canceled=true;throw error;}
  finally{
    clearTimeout(settleTimer);
    abortController.abort();
    accepting=false;signal?.removeEventListener('abort',stop);finishInput();
    for(const [id,request] of pending)resolveRequest(id,request.deny('本次执行已结束，权限请求失效。'));
    try{stream?.close();if(child)await stopProcess(child);await externalTools?.settled();}finally{await externalCleanup?.();}
  }
}

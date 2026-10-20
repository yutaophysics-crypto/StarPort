import { nativeStatus } from '../activity.mjs';

function recoveredConnectionError(result,turn) {
  const last=turn?.lastStep;
  // agy can retain an earlier API error in its result even after recovering.
  // Text alone is insufficient: require a completed final native response
  // after an error step, with no later tool/error, matching the result text.
  return /^API error\b[\s\S]*\brequest failed:/i.test(result.error||'')
    && /\bEOF\b|connection reset|forcibly closed|broken pipe|i\/o timeout|TLS handshake timeout/i.test(result.error)
    && !/cancel|interrupt|abort|stop/i.test(result.status||'')
    && turn?.sawErrorStep && last?.nativeType==='agent_response' && last.status==='complete'
    && typeof result.response==='string' && !!result.response.trim()
    && last.text?.trim()===result.response.trim();
}

export function parseAntigravityEvent(e,state={}) {
  const events=[],emit=(type,data)=>events.push({type,...data});
  if(e.conversation_id)emit('session',{id:e.conversation_id});
  if(e.event==='step_update'){
    const step=e.step_update||{},info=step.tool_info||step.tool_call||(typeof step.tool==='object'?step.tool:null)||{};
    if(step.conversation_id)emit('session',{id:step.conversation_id});
    const nativeType=step.step_type||'tool',id='agy:'+String(step.step_index??step.id??info.id??step.tool_name??nativeType);
    const status=nativeStatus(step.state||step.status),durationMs=step.duration_seconds==null?undefined:step.duration_seconds*1000;
    if(nativeType==='user_input'){delete state.antigravityTurn;return events;}
    const turn=state.antigravityTurn??={};
    if(nativeType==='error_message')turn.sawErrorStep=true;
    if(turn.lastStep?.id!==id)turn.lastStep={id,text:''};
    Object.assign(turn.lastStep,{nativeType,status});
    if(typeof step.text==='string')turn.lastStep.text=step.text;
    else if(typeof step.text_delta==='string')turn.lastStep.text+=step.text_delta;
    if(nativeType==='agent_response'||['thinking','reasoning','agent_thought'].includes(nativeType)){
      const thinking=nativeType!=='agent_response';
      if(step.text_delta){if(!thinking)emit('delta',{text:step.text_delta});emit('activity',{item:{id,kind:thinking?'thinking':'text',nativeType,status,durationMs},delta:step.text_delta});}
      else emit('activity',{item:{id,kind:thinking?'thinking':'text',nativeType,status,durationMs,...typeof step.text==='string'?{text:step.text}:{}}});
    }else if(nativeType==='tool'||step.tool_name||info.name||step.tool){
      emit('tool',{id,name:step.tool_name||info.name||(typeof step.tool==='string'?step.tool:'')||nativeType,status,nativeType,
        input:info.parameters??info.arguments??step.input,output:info.output??step.output??step.text_delta,durationMs,stepIndex:step.step_index});
    }else emit('activity',{item:{id,kind:'step',name:nativeType,nativeType,status,durationMs,stepIndex:step.step_index,text:step.text}});
  }
  if(e.event==='assistant')for(const block of (e.assistant?.message||e.message)?.content||[]){
    if(block.type==='text'&&block.text){emit('delta',{text:block.text});emit('activity',{item:{id:'agy:message:'+String(state.messageIndex=(state.messageIndex||0)+1),kind:'text',text:block.text,status:'complete'}});}
  }
  if(e.event==='result'||(!e.event&&e.status&&'response' in e)){
    const r=e.result||e;state.terminal=true;
    if(r.conversation_id)emit('session',{id:r.conversation_id});
    if(typeof r.response==='string'){emit('replace',{text:r.response});emit('final-answer',{text:r.response});}
    if(r.usage)emit('usage',{usage:r.usage});
    if(r.status!=='SUCCESS'){
      if(recoveredConnectionError(r,state.antigravityTurn))emit('diagnostic',{kind:'antigravity-connection-recovered',message:r.error});
      else emit('error',{message:r.error||`Antigravity 状态：${r.status}`});
    }
    delete state.antigravityTurn;
  }
  return events;
}

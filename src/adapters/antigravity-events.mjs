import { nativeStatus } from '../activity.mjs';

const TRANSPORT=/\bEOF\b|connection reset|forcibly closed|broken pipe|i\/o timeout|TLS handshake timeout|use of closed network connection|stream idle timeout|context deadline exceeded/i;
// agy's own prompts to itself when it retries within a turn: after an interrupted stream,
// or after a reply cut off at the model's output limit ("Retries remaining: N").
const SELF_RETRY=/^The stream was interrupted\b|^Your previous response was cut off because it exceeded the output token limit\b/i;

// A turn that stopped on one of these may be carried on in the same conversation.
export function transientAntigravityError(message) {
  const text=String(message||'');
  return (/^API error\b[\s\S]*\brequest failed:/i.test(text)&&TRANSPORT.test(text))
    || SELF_RETRY.test(text) || /^There was a network issue connecting to the server\b/i.test(text);
}
export const antigravityCutOff=message=>/exceeded the output token limit/i.test(String(message||''));

function recoveredError(result,turn) {
  const last=turn?.lastStep,answer=last?.text?.trim();
  // agy can retain an earlier error in its result even after retrying and recovering.
  // Text alone is insufficient: require a completed final native response
  // after an error step, with no later tool/error, ending the result text.
  // agy 1.4 joins every response of the turn into the result, so the final one is its end.
  return transientAntigravityError(result.error)
    && !/cancel|interrupt|abort|stop/i.test(result.status||'')
    && turn?.sawErrorStep && last?.nativeType==='agent_response' && last.status==='complete'
    && !!answer && typeof result.response==='string' && result.response.trim().endsWith(answer);
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
      if(recoveredError(r,state.antigravityTurn))emit('diagnostic',{kind:'antigravity-recovered',message:r.error});
      else emit('error',{message:r.error||`Antigravity 状态：${r.status}`});
    }
    delete state.antigravityTurn;
  }
  return events;
}

import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { startProcess, stopProcess, redact } from '../process.mjs';
import { parseClaudeEvent } from './claude-events.mjs';
import { parseAntigravityEvent } from './antigravity-events.mjs';
import { temporaryAntigravityStartup, withAntigravityStartupRetry } from './antigravity-startup.mjs';

// Headless agy soft-denies any tool that needs approval and ends the turn with
// an empty answer. Unattended desks ask it, in the same session, to carry on
// without that tool; nothing is approved on its behalf.
const DENIED_FOLLOW_UP='（星港）刚才那个操作没有获得批准：你在无人值守的工位里运行，需要审批的命令会被自动拒绝。不要再调用需要审批的工具，用已有的信息和不需要审批的工具完成你的部分，给出完整的文字回复；如果确实缺少只能靠命令拿到的结果，在回复里写明。';
const DENIED_FOLLOW_UPS=2;
const CHAT_DENIED='Antigravity 想调用命令等工具，但无交互模式无法弹出审批，操作被自动拒绝，这一轮没有产生回复。请把「工具权限」设为「允许所有工具」后重发；若使用「遵循原工具权限」，需在 Antigravity CLI 的 settings.json（permissions.allow）里为工作目录添加允许规则。';
const DESK_DENIED='Antigravity 想调用的命令在无人值守的工位里被自动拒绝，请它不用该命令继续后仍没有产生回复。如果这位伙伴的任务确实需要运行命令，可以把它的「无人值守时的权限」调成「完全权限」，或在 Antigravity CLI 的权限设置里为这类命令添加允许规则。';

export function cliArguments(provider, options, session) {
  if (provider==='claude') {
    const args=['-p','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode',options.permissionMode];
    if(options.nativeNoPrompts)args.push('--permission-prompts','none');
    if (options.model) args.push('--model',options.model);
    if (options.effort) args.push('--effort',options.effort);
    if (session) args.push('--resume',session);
    else if (options.worktree) args.push('--worktree');
    return args;
  }
  if (provider==='antigravity') {
    const args=['--input-format','stream-json','--output-format','stream-json','--mode',options.mode];
    if(options.permissionMode==='allow-all')args.push('--dangerously-skip-permissions');
    if (options.model) args.push('--model',options.model);
    if (options.effort) args.push('--effort',options.effort);
    if (options.agent) args.push('--agent',options.agent);
    if (options.sandbox) args.push('--sandbox');
    if (session) args.push('--conversation',session);
    return args;
  }
  throw new Error('未知 CLI 适配器');
}

export function parseEvent(provider,event,state={}) {
  return provider==='claude'?parseClaudeEvent(event,state):provider==='antigravity'?parseAntigravityEvent(event,state):[];
}

export function cliInput(provider,prompt,images=[]){
  if(provider==='claude'&&images.length)return JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:prompt},...images.map(image=>({type:'image',source:{type:'base64',media_type:image.mime,data:image.data}}))]},parent_tool_use_id:null,session_id:''})+'\n';
  return provider==='antigravity'?JSON.stringify({event:'user',message:{content:prompt}})+'\n':prompt;
}
export async function runCli(input) {
  if(input.provider!=='antigravity')return runCliAttempt(input);
  const controller=new AbortController(),signal=input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal;
  // Inputs accepted during a failed startup remain queued for the same run.
  // They are never re-enqueued as duplicate Starport user messages.
  const startupQueue=[];
  return withAntigravityStartupRetry(()=>runCliAttempt({...input,signal,startupQueue,setControl:control=>input.setControl({...control,stop:async()=>{controller.abort();await control.stop();}})}),{signal,emit:input.emit});
}
async function runCliAttempt({provider, runtime, options, session, initialContext, prompt,contextEnv={}, images=[], cwd, signal, emit, setControl,startupQueue,unattended=false}) {
  const payload=cliInput(provider,prompt,images);
  if(provider==='claude'&&Buffer.byteLength(payload)>10*1024*1024)throw new Error('Claude 图片输入超过 10 MB，请减少附件');
  const child=startProcess(runtime.command,[...runtime.prefixArgs,...cliArguments(provider,options,session),...(provider==='claude'&&images.length?['--input-format','stream-json']:[])],{cwd,env:contextEnv});
  const state={model:initialContext?.model,windowTokens:initialContext?.windowTokens}; let stderr='', failure='', gotOutput=false, sawStdout=false, canceled=false, finishTimer=null,accepting=provider==='antigravity',currentInput=null;
  let startupRefusal=false,nativeWork=false,turnAnswer='',turnBlocked=false,followUps=0;
  const queued=startupQueue||[];let rejectCompleted;
  const stop=async()=>{canceled=true;try{await stopProcess(child);}catch(error){rejectCompleted?.(error);throw error;}};
  const onAbort=()=>{stop().catch(()=>{});};
  setControl({stop,...provider==='antigravity'?{inputMode:'queue',canSend:()=>accepting&&!canceled,steer:async(text,{id})=>{
    if(!accepting||canceled)throw new Error('当前任务已结束；输入已保留，请重新发送。');
    queued.push({text,id});return {delivery:'queued'};
  }}:{}});
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted) await stop();
  child.stdin.on('error',()=>{});
  const decoder=new StringDecoder('utf8');
  child.stderr.on('data',chunk=>{stderr=(stderr+redact(decoder.write(chunk))).slice(-20000);});
  child.stdout.on('data',chunk=>{if(/\S/.test(chunk.toString('utf8')))sawStdout=true;});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let e;try{e=JSON.parse(line);}catch{if(line.trim())nativeWork=true;return;}
    gotOutput=true;
    // In stream-json mode agy reports a failed eligibility check as a result
    // with zero turns. Nothing ran, so only that lone event allows a replay.
    if(provider==='antigravity'){
      if(e.event==='result'&&e.result?.status!=='SUCCESS'&&!Number(e.result?.num_turns)&&!e.result?.response)startupRefusal=true;
      else nativeWork=true;
    }
    if(provider==='antigravity'&&currentInput&&e.event==='result'){
      emit({type:'input-consumed',id:currentInput.id});currentInput=null;
    }
    if(provider==='antigravity'&&currentInput&&e.event==='step_update'&&e.step_update?.step_type==='user_input'){
      emit({type:'input-consumed',id:currentInput.id});currentInput=null;
    }
    for(const event of parseEvent(provider,e,state)) {
      if(event.type==='error') failure=event.message;
      else emit(event);
      if(event.type==='tool'&&['error','denied'].includes(event.status))turnBlocked=true;
      if(event.type==='final-answer')turnAnswer=event.text||'';
    }
    // Some Antigravity releases deliver the final result but keep the process
    // alive (stream-json mode included). Finish the turn ourselves after a
    // short grace period so the CLI can exit on its own when it wants to.
    if(state.terminal){
      if(provider==='antigravity'&&unattended&&!failure&&!canceled&&turnBlocked&&!turnAnswer.trim()&&followUps<DENIED_FOLLOW_UPS){
        followUps++;turnBlocked=false;state.terminal=false;
        emit({type:'notice',text:`Antigravity 想调用的命令在无人值守的工位里被自动拒绝，已请它不用该命令继续（${followUps}/${DENIED_FOLLOW_UPS}）。`});
        child.stdin.write(cliInput(provider,DENIED_FOLLOW_UP));return;
      }
      if(provider==='antigravity'&&!failure&&queued.length&&!canceled){
        const next=queued.shift();currentInput=next;state.terminal=false;turnBlocked=false;
        // A native result boundary starts the next queued prompt. Never send
        // control/interrupt messages or stop a live turn to inject text.
        child.stdin.write(cliInput(provider,next.text));return;
      }
      accepting=false;
      if(provider==='antigravity')child.stdin.end();
      clearTimeout(finishTimer);
      finishTimer=setTimeout(()=>{stopProcess(child).catch(error=>rejectCompleted?.(error));},3000);
      finishTimer.unref?.();
    }
  });
  const completed=new Promise((resolve,reject)=>{
    rejectCompleted=reject;
    child.once('error',reject);
    child.once('close',(code)=>{
      clearTimeout(finishTimer);
      if(canceled) return reject(Object.assign(new Error('已停止'),{canceled:true}));
      if(failure) return reject(Object.assign(new Error(redact(failure)),
        provider==='antigravity'&&startupRefusal&&!nativeWork&&temporaryAntigravityStartup(failure)?{antigravityStartupFailure:true}:{}));
      // A complete result event is authoritative: the text is already saved,
      // so a nonzero exit code right after it (our forced stop) is expected.
      if(state.terminal){
        if(provider==='antigravity'&&followUps&&turnAnswer.trim())return resolve();
        const denied=/no output produced|headless mode cannot prompt|auto-denied/i.test(stderr);
        if(provider==='antigravity'&&(unattended?!turnAnswer.trim()&&(turnBlocked||denied):denied))
          emit({type:'notice',text:unattended?DESK_DENIED:CHAT_DENIED});
        else if(/denied|permission|not authorized|拒绝/i.test(stderr)) emit({type:'notice',text:stderr.slice(-1500)});
        return resolve();
      }
      if(code!==0) return reject(Object.assign(new Error(redact(stderr.slice(-4000)||`工具退出代码 ${code}`)),
        provider==='antigravity'&&!sawStdout&&temporaryAntigravityStartup(stderr)?{antigravityStartupFailure:true}:{}));
      if(!gotOutput) return reject(new Error(`未收到有效事件。${stderr.slice(-1500)}`));
      return reject(new Error('工具未返回完整的结束事件，结果已保留。'));
    });
  });
  if(provider==='antigravity')child.stdin.write(payload);else child.stdin.end(payload);
  try { await completed; } finally { signal?.removeEventListener('abort',onAbort); }
}

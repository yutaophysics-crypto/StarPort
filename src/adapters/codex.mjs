import { JsonRpc } from '../process.mjs';
import { codexPermissions } from '../codex-permissions.mjs';
import { codexContext, contextSample } from '../context.mjs';
import { parseCodexActivity } from './codex-events.mjs';

export async function connectCodex(runtime, cwd, handlers={}) {
  const {initializeTimeoutMs=60000,...callbacks}=handlers;
  const rpc=new JsonRpc(runtime.command,[...runtime.prefixArgs,'app-server','--stdio'],{cwd,...callbacks});
  try {
    await rpc.request('initialize',{clientInfo:{name:'harness_hub',title:'Harness Hub',version:'0.1.0'},capabilities:{experimentalApi:true}},initializeTimeoutMs);
    rpc.notify('initialized');return rpc;
  } catch(e) {await rpc.close();throw e;}
}

export async function runCodex({runtime,options,session,prompt,contextTools,contextEnv={},images=[],goalObjective,cwd,signal,emit,setControl,reconcileIntervalMs=15000,reconcileAfterMs=45000}) {
  const permissions=codexPermissions(options,cwd);
  let rpc,threadId,turnId,canceled=false,pendingTurn=null,goal=null,paused=false,model=null;
  // Turns that already ended. Their late deltas must not append to the answer.
  const parts=new Map(), approvals=new Map(), activityState={}, doneTurns=new Set();
  let lastNativeEventAt=Date.now(),reconcileTimer=null,checking=null,probeError=null,probeDisabled=false;
  const text=()=>[...parts.values()].filter(Boolean).join('\n\n');
  const endTurn=(turn)=>{if(pendingTurn){const resolve=pendingTurn;pendingTurn=null;resolve(turn);}};
  const stop=async()=>{
    canceled=true;
    if(rpc && threadId && options.mode==='goal') {
      try { const r=await rpc.request('thread/goal/set',{threadId,status:'paused'},5000);emit({type:'goal',goal:r.goal}); }catch{}
    }
    if(rpc && threadId && turnId) try {await rpc.request('turn/interrupt',{threadId,turnId},5000);}catch{}
    if(rpc) await rpc.close();
  };
  const onAbort=()=>{stop().catch(()=>{});};
  const onEvent=(method,p)=>{
    const spawn=p.thread?.source?.subAgent?.thread_spawn;
    if(method==='thread/started'&&spawn&&(spawn.parent_thread_id===threadId||activityState.children?.[spawn.parent_thread_id])){
      activityState.children??={};const id=p.thread.id;
      const row={id,parentId:spawn.parent_thread_id,name:spawn.agent_nickname||spawn.agent_role||p.thread.agentNickname||p.thread.agentRole||'Subagent',depth:Math.max(0,spawn.depth-1),status:'running',updatedAt:Date.now(),source:'codex-app-server'};
      activityState.children[id]={...activityState.children[id],...row};emit({type:'subagent',...row});return;
    }
    if(p.threadId && threadId && p.threadId!==threadId){
      if(!activityState.children?.[p.threadId])return;
      for(const event of parseCodexActivity(method,p,activityState)){
        if(event.type==='tool')emit({...event,id:p.threadId+':'+event.id,scope:p.threadId});
        if(event.type==='activity')emit({...event,item:{...event.item,id:p.threadId+':'+event.item.id,scope:p.threadId}});
        if(event.type==='subagent')emit(event);
      }
      if(method==='turn/started'||method==='turn/completed'){
        const status=method==='turn/started'?'running':p.turn?.status==='completed'?'complete':p.turn?.status==='interrupted'?'interrupted':'error';
        activityState.children[p.threadId].status=status;emit({type:'subagent',id:p.threadId,status,updatedAt:Date.now(),source:'codex-app-server'});
      }
      return;
    }
    if(p.turnId&&turnId&&p.turnId!==turnId)return;
    if(method==='turn/completed'&&p.turn?.id&&turnId&&p.turn.id!==turnId)return;
    if(doneTurns.has(p.turnId)||method==='turn/completed'&&doneTurns.has(p.turn?.id))return;
    lastNativeEventAt=Date.now();
    if(method==='turn/started'){turnId=p.turn?.id;emit({type:'input-state'});}
    for(const event of parseCodexActivity(method,p,activityState))emit(event);
    if(method==='serverRequest/resolved'){
      const id=String(p.requestId);if(approvals.delete(id))emit({type:'approval-resolved',id});
    }
    if(method==='item/agentMessage/delta'||method==='item/plan/delta') {
      const id=p.itemId || 'message';parts.set(id,(parts.get(id)||'')+(p.delta||''));emit({type:'replace',text:text()});
    }
    if(method==='item/started' || method==='item/completed') {
      const item=p.item || {};
      if(item.type==='contextCompaction')emit({type:'context',context:contextSample({model,basis:'codex-last',status:method==='item/started'?'compacting':'waiting'})});
      if(['agentMessage','plan'].includes(item.type) && typeof item.text==='string') {parts.set(item.id,item.text);emit({type:'replace',text:text()});}
    }
    if(method==='thread/tokenUsage/updated') {emit({type:'usage',usage:p.tokenUsage});emit({type:'context',context:codexContext(p.tokenUsage,model)});}
    if(method==='model/rerouted'){model=p.toModel;emit({type:'context',context:contextSample({model,basis:'codex-last',status:'waiting'})});}
    if(method==='thread/goal/updated') {goal=p.goal;emit({type:'goal',goal});}
    if(method==='thread/goal/cleared') {goal=null;emit({type:'goal',goal:null});}
    if(method==='error') {
      emit({type:'notice',text:p.error?.message || 'Codex 报告执行错误'});
      emit({type:'diagnostic',kind:'native-error',turnId:p.turnId||turnId,willRetry:p.willRetry,error:p.error?.message||'',code:p.error?.codexErrorInfo});
      if(p.willRetry===false&&pendingTurn)endTurn({id:p.turnId||turnId,status:'failed',error:p.error});
    }
    if(method==='turn/completed'){if(p.turn?.id)doneTurns.add(p.turn.id);turnId=null;emit({type:'input-state'});endTurn(p.turn);}
  };
  const onRequest=async(request)=>{
    const {id,method,params={}}=request;
    if(method==='item/tool/call'&&contextTools){
      try{const output=await contextTools.call(params.tool,params.arguments);rpc.respond(id,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(output)}]});}
      catch(error){rpc.respond(id,{success:false,contentItems:[{type:'inputText',text:error.message}]});}
    }else if(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput','tool/requestUserInput'].includes(method)) {
      approvals.set(String(id),request);
      emit({type:'approval',request:{id:String(id),provider:'codex',kind:method.endsWith('requestUserInput')?'question':'permission',method,params}});
    } else if(method==='item/permissions/requestApproval') {
      rpc.respond(id,{permissions:{},scope:'turn'});
      emit({type:'notice',text:'工具请求额外权限，当前界面尚未支持此类授权，已保持原权限。'});
    } else if(method==='mcpServer/elicitation/request') {
      rpc.respond(id,{action:'cancel'});emit({type:'notice',text:'MCP 请求交互认证，请在原工具完成配置后重试。'});
    } else rpc.respondError(id,`Harness Hub 尚不支持 ${method}`);
  };
  try {
    rpc=await connectCodex(runtime,cwd,{env:contextEnv,onEvent,onRequest});
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted){await stop();throw Object.assign(new Error('已停止'),{canceled:true});}
    const config={cwd,approvalPolicy:permissions.approvalPolicy,approvalsReviewer:permissions.approvalsReviewer,sandbox:permissions.sandbox};
    if(contextTools&&!session)config.dynamicTools=contextTools.definitions.map(def=>({type:'function',...def}));
    if(options.model)config.model=options.model;
    const result=await rpc.request(session?'thread/resume':'thread/start',session?{...config,threadId:session}:{...config,experimentalRawEvents:false});
    threadId=result.thread.id;model=result.model;emit({type:'session',id:threadId,model});
    const reconcileTurn=()=>{
      if(checking||probeDisabled||rpc.ended||canceled||!pendingTurn||!turnId||approvals.size||Date.now()-lastNativeEventAt<reconcileAfterMs)return;
      const expectedTurnId=turnId;
      checking=(async()=>{
        try{
          const snapshot=await rpc.request('thread/read',{threadId,includeTurns:true},10000);
          if(canceled||!pendingTurn||turnId!==expectedTurnId||snapshot.thread?.id!==threadId)return;
          const turn=snapshot.thread.turns?.find(row=>row.id===expectedTurnId);
          if(!turn||!['completed','failed','interrupted'].includes(turn.status))return;
          // Trust only the terminal status of this exact turn. Silence or an
          // idle process alone is not a reason to stop thinking or tools.
          for(const item of turn.items||[])onEvent('item/completed',{threadId,turnId:expectedTurnId,item});
          emit({type:'diagnostic',kind:'recovered-terminal',turnId:expectedTurnId,status:turn.status});
          onEvent('turn/completed',{threadId,turn});
        }catch(error){
          if(canceled||!pendingTurn||turnId!==expectedTurnId||rpc.ended)return;
          if(probeError!==error.message){probeError=error.message;emit({type:'diagnostic',kind:'status-check-failed',turnId:expectedTurnId,error:error.message});}
          if(/unknown method|method not found|not supported|unsupported/i.test(error.message))probeDisabled=true;
        }finally{checking=null;}
      })();
    };
    reconcileTimer=setInterval(reconcileTurn,reconcileIntervalMs);reconcileTimer.unref();
    setControl({stop,inputMode:'steer',canSend:()=>!!turnId&&!canceled,
      steer:async(text,{images=[]}={})=>{
        if(!turnId||canceled)throw new Error('当前任务已结束；输入已保留，请重新发送。');
        const input=[{type:'text',text,text_elements:[]},...images.map(image=>({type:'localImage',path:image.path}))];
        const expectedTurnId=turnId,result=await rpc.request('turn/steer',{threadId,expectedTurnId,input},15000);
        if(result.turnId!==expectedTurnId)throw new Error('原工具未确认补充消息的目标任务');
        return {delivery:'accepted'};
      },
      answer:async(id,answer)=>{
        const request=approvals.get(String(id));if(!request)throw new Error('该请求已失效');
        if(request.method.endsWith('requestUserInput')) {
          if(!['accept','skip'].includes(answer.decision))throw new Error('无效的审批选项');
          const response={};
          for(const q of answer.decision==='skip'?[]:request.params.questions || []) {
            const value=answer.answers?.[q.id];
            if(!(typeof value==='string'||Array.isArray(value)&&value.every(v=>typeof v==='string')) || !value.length || JSON.stringify(value).length>10000)throw new Error('请输入问题的回答');
            response[q.id]={answers:Array.isArray(value)?value:[value]};
          }
          rpc.respond(request.id,{answers:response});
        } else {
          if(!['accept','acceptForSession','decline','cancel'].includes(answer.decision))throw new Error('无效的审批选项');
          rpc.respond(request.id,{decision:answer.decision});
        }
        approvals.delete(String(id));emit({type:'approval-resolved',id:String(id)});
      },
      goal:async(action)=>{
        if(action==='pause') {paused=true;const r=await rpc.request('thread/goal/set',{threadId,status:'paused'});goal=r.goal;emit({type:'goal',goal});if(turnId)await rpc.request('turn/interrupt',{threadId,turnId});}
        else if(action==='clear'){paused=true;await rpc.request('thread/goal/clear',{threadId});goal=null;emit({type:'goal',goal:null});}
        else throw new Error('无效目标操作');
      }
    });
    if(options.mode==='goal') {
      const current=await rpc.request('thread/goal/get',{threadId});
      const requested=options.objective?.trim();
      const params={threadId,status:'active'};
      if(!current.goal || ['complete','budgetLimited'].includes(current.goal.status) || (requested && requested!==current.goal.objective)) params.objective=requested||goalObjective||prompt;
      if(options.tokenBudget)params.tokenBudget=options.tokenBudget;
      const r=await rpc.request('thread/goal/set',params);goal=r.goal;emit({type:'goal',goal});
    } else {
      const current=await rpc.request('thread/goal/get',{threadId}).catch(()=>({goal:null}));
      if(current.goal?.status==='active'){const r=await rpc.request('thread/goal/set',{threadId,status:'paused'});emit({type:'goal',goal:r.goal});}
    }
    let nextPrompt=prompt,firstTurn=true;
    while(!canceled) {
      const complete=new Promise(resolve=>{pendingTurn=resolve;});
      // Send the boundary on every turn, including resumed threads and goal continuation.
      // This also revokes any broader policy retained by a previously full-access session.
      const params={threadId,approvalPolicy:permissions.approvalPolicy,approvalsReviewer:permissions.approvalsReviewer,sandboxPolicy:permissions.sandboxPolicy,input:[{type:'text',text:nextPrompt,text_elements:[]},...(firstTurn?images.map(image=>({type:'localImage',path:image.path})):[])]};
      if(options.mode==='plan'||options.mode==='chat'||options.mode==='goal')params.collaborationMode={mode:options.mode==='plan'?'plan':'default',settings:{model:options.model||result.model,reasoning_effort:options.effort||result.reasoningEffort||null,developer_instructions:null}};
      if(options.effort)params.effort=options.effort;
      if(options.model)params.model=options.model;
      const started=await rpc.request('turn/start',params);turnId=started.turn.id;emit({type:'input-state'});
      firstTurn=false;
      const completed=await Promise.race([complete,rpc.closed.then(error=>{throw error;})]);
      turnId=null;
      if(canceled)throw Object.assign(new Error('已停止'),{canceled:true});
      if(completed?.status==='failed')throw new Error(completed.error?.message || 'Codex 执行失败');
      if(completed?.status==='interrupted' && !paused)throw Object.assign(new Error('执行已中断'),{canceled:true});
      if(options.mode!=='goal' || paused)break;
      const current=await rpc.request('thread/goal/get',{threadId});goal=current.goal;emit({type:'goal',goal});
      if(!goal || goal.status!=='active')break;
      emit({type:'notice',text:'当前目标仍有效，继续下一步。'});
      nextPrompt='继续完成当前已设置的目标。核实完成条件；完成后更新目标状态。若需要用户决策或外部条件，请明确说明并按原生目标规则处理，不要重复无效尝试。';
      await new Promise(resolve=>setTimeout(resolve,300));
    }
  } catch(e) {if(canceled)e.canceled=true;throw e;}
  finally {clearInterval(reconcileTimer);signal?.removeEventListener('abort',onAbort);if(rpc)await rpc.close();if(checking)await checking;}
}

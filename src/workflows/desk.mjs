// Runs one prompt in a desk nobody is watching. Approval requests are declined and questions
// skipped; the step time limit, when the user set one, is enforced with saved checkpoints.
import { redact } from '../process.mjs';
import { historyMessage } from '../history-context.mjs';
import { companionCheckpoint } from '../companion-limits.mjs';
import { clip, oneLine } from './common.mjs';

function describe(request){
  const params=request?.params||{},input=params.input||{};
  return clip(oneLine(params.command||input.command||input.file_path||params.toolName||request?.method||'权限请求'),160);
}

// `bare` leaves out the user's standing preferences and project instructions (exam seats).
export async function runUnattended({runner,store,clockFactory},run,deskId,prompt,{minutes=0,memory=null,bare=false,onNote=()=>{},onRuntime=()=>{},onCheckpoint=()=>{}}={}){
  run.desks.add(deskId);
  try{
    const started=await runner.start(deskId,prompt,[],{desk:true,...bare?{bare:true}:{},memory:{read:!!memory?.read,propose:!!memory?.propose}});
    // Notices already present are Starport's own (context trimming); the tool's arrive later.
    const handled=new Set(),preset=started.assistant.details?.notices?.length||0;
    const clock=clockFactory({minutes}),runtime=()=>({...clock.snapshot(),messageId:started.assistant.id});
    onRuntime(runtime());
    const checkpoint=reason=>{
      const message=runner.active.get(deskId)?.message||store.messageById(deskId,started.assistant.id);
      if(!message)return;
      const saved=companionCheckpoint(message,reason);
      message.details.checkpoints=[...(message.details.checkpoints||[]),saved].slice(-4);
      message.details.liveRevision=(message.details.liveRevision||0)+1;store.saveMessage(message);onCheckpoint(saved);
    };
    const inspect=()=>{
      const active=runner.active.get(deskId);if(!active||active.message?.status!=='running')return;
      for(const event of clock.poll(Date.now(),active.lastEventAt)){
        if(event.type==='idle')onNote(`连续 ${event.idleMinutes} 分钟未收到新活动，任务仍在运行；不会因无活动自动停止。`);
        if(event.type==='resumed')onNote('已收到新的活动，伙伴继续工作。');
        if(event.type==='warning'){
          checkpoint('deadline-warning');
          onNote(`即将达到你设置的 ${minutes} 分钟时限，剩余约 ${Math.ceil(event.remainingSeconds/60)} 分钟；到时将停止，已有进度和执行记录会保留。`);
        }
        if(event.type==='deadline'){
          checkpoint('deadline');
          onNote(`达到你设置的 ${minutes} 分钟时限，正在停止；已有进度和执行记录已保存。`);
          runner.stop(deskId).catch(error=>onNote('停止请求未完成：'+redact(error.message)));
        }
        onRuntime(runtime());
      }
    };
    const watch=setInterval(()=>{
      const active=runner.active.get(deskId);if(!active)return;
      for(const request of active.approvals.values()){
        if(handled.has(request.id))continue;handled.add(request.id);
        const question=request.kind==='question';
        runner.answer(deskId,request.id,{decision:question?'skip':'decline'}).catch(()=>{});
        onNote(question?'伙伴提了问题；无人值守，已跳过':'需要审批的操作已自动拒绝：'+describe(request));
      }
      inspect();
    },800);watch.unref?.();
    const timer=clock.deadlineAt===null?null:setTimeout(inspect,Math.max(0,clock.deadlineAt-Date.now()));timer?.unref?.();
    if(run.stopped)runner.stop(deskId).catch(()=>{});
    try{await started.done?.catch(()=>{});}finally{clearInterval(watch);clearTimeout(timer);}
    const message=store.messageById(deskId,started.assistant.id);
    const output=message?.status==='complete'?message.details?.finalAnswer||message.content||'':message?historyMessage(message)?.content||message.content||'':'';
    return {status:message?.status||'error',output,error:clock.expired?`达到你设置的 ${minutes} 分钟时限，已停止；进度和执行记录已保留。`:message?.details?.error||'',notices:(message?.details?.notices||[]).slice(preset),messageId:started.assistant.id,memory:message?.details?.memory||null};
  }finally{run.desks.delete(deskId);}
}

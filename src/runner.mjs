import { AntigravitySubagents, mergeSubagent, settleSubagents } from './subagents.mjs';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildContext, writeHistoryArchive, historyArchivePath } from './storage.mjs';
import { validateOptions } from './providers.mjs';
import { runCodex } from './adapters/codex.mjs';
import { runCli } from './adapters/cli.mjs';
import { runDeepseek } from './adapters/deepseek.mjs';
import { runClaude } from './adapters/claude.mjs';
import { mergeActivity, settleActivity } from './activity.mjs';
import { ActivityHistory, recoverActivity } from './activity-history.mjs';
import { redact } from './process.mjs';
import { validateEffort } from './effort.mjs';
import { contextBinding, emptyContext, sessionFingerprint, effectiveContext } from './context.mjs';
import { validateInput, validateReply } from './interactions.mjs';
import { contextToolHost,contextCommandBridge,contextToolInstructions,MEMORY_READ_TOOLS,MEMORY_PROPOSE_TOOLS } from './context-tools.mjs';

// Starport transport guard after an observed truncation near 192,000 UTF-8 bytes.
// This is a conservative compatibility limit, not the model context window or a verified
// universal agy limit. Keep it until the installed transport is verified with larger inputs.
export const INPUT_BYTE_LIMITS={antigravity:184000};
const attachmentIds=row=>(row.details.attachments||[]).map(item=>item.id);

export class Runner {
  constructor(store,registry,broadcast,implementations={},attachments=null,history=null) {this.store=store;this.registry=registry;this.broadcast=broadcast;this.active=new Map();this.implementations=implementations;this.attachments=attachments;this.subagentReader=new AntigravitySubagents();this.activityHistory=history?new ActivityHistory(history):null;}
  checkAttachments(ids=[]){
    if(!this.attachments){if(Array.isArray(ids)&&!ids.length)return [];throw new Error('附件不可用');}
    return this.attachments.rows(ids);
  }
  // takesAttachments: the page is served from disk and can be newer than a server not yet
  // restarted; it offers attachments during a task only to a server that keeps them.
  state(chatId) {
    const run=this.active.get(chatId);return run?{id:run.id,provider:run.provider,started:run.started,lastEventAt:run.lastEventAt||run.started,stalled:!!run.stalled,phase:run.phase||'answering',approvals:[...run.approvals.values()],goal:run.goal,inputMode:run.control?.inputMode||null,takesAttachments:true,inputReady:!run.finalizing&&!run.controller.signal.aborted&&typeof run.control?.steer==='function'&&run.control.canSend?.()!==false}:null;
  }
  live(chatId){
    const chat=chatId?this.store.chat(chatId):null;
    const run=chatId?this.active.get(chatId):null,message=run?.message||(chat?this.store.lastAssistant(chatId):null);
    const runId=run?.id||message?.details?.runId||null;
    return {chatId:chat?.id||null,chat,active:[...this.active.keys()],providerVerifications:this.registry.verifications?.()||{},message,inputs:chat?this.store.interactionMessages(chatId,runId):[],...chat?this.store.queue.snapshot(chatId):{},runId,run:chat?this.state(chatId):null,context:chat?this.context(chatId):null};
  }
  snapshot(chatId){return {chat:this.store.chat(chatId),messages:this.store.messages(chatId),...this.store.queue.snapshot(chatId),run:this.state(chatId),context:this.context(chatId)};}
  async refreshContext(chatId,refresh=false){
    const chat=this.store.chat(chatId);if(!chat)return null;
    const options=validateOptions(chat.provider,chat.options[chat.provider]),sample=this.context(chatId);
    await this.registry.contextLimits?.(chat.provider,chat.workspace,sample.model||options.model,refresh);
    return this.context(chatId);
  }
  context(chatId) {
    const chat=this.store.chat(chatId);if(!chat)return null;
    const options=validateOptions(chat.provider,chat.options[chat.provider]);
    const binding=contextBinding(chat,options),runtime=this.registry.resolve(chat.provider);
    const fingerprint=runtime?sessionFingerprint(runtime,chat,options,this.store.memory.epoch,this.store.instructions.fingerprint(chat.project_id||null)):null;
    const promoted=runtime?this.promotedFingerprint(runtime,chat,options):null,current=value=>!!value&&(value===fingerprint||value===promoted);
    const active=this.active.get(chatId),session=this.store.session(chatId,chat.provider);
    const message=active?.message||(current(session?.fingerprint)?this.store.messageById(chatId,session.cursor):null);
    const saved=message?.details?.context,activeFingerprint=active?.message?.details?.context?.fingerprint;
    const valid=saved&&saved.binding===binding&&(activeFingerprint?saved.fingerprint===activeFingerprint:current(saved.fingerprint))&&(!session||active||message.details.sessionId===session.native_id);
    const sample={provider:chat.provider,binding,...valid?saved:emptyContext(chat.provider)};
    return effectiveContext(sample,this.compactor?.settings().budgets[chat.provider]*1000,
      this.registry.cachedContextLimits?.(chat.provider,chat.workspace,sample.model||options.model));
  }
  // A conversation whose folder becomes part of a project keeps its session: so far it carried
  // only global context, and the project's requirements and memories arrive with every turn.
  promotedFingerprint(runtime,chat,options,suffix=''){
    return chat.project_id?sessionFingerprint(runtime,{...chat,project_id:null},options,this.store.memory.epoch,this.store.instructions.fingerprint(null))+suffix:null;
  }
  async start(chatId,text,attachmentIds=[],metadata={}) {
    if(this.active.has(chatId))throw Object.assign(new Error('这个对话正在运行，请先停止或等待完成'),{status:409});
    const chat=this.store.chat(chatId);if(!chat)throw new Error('对话不存在');
    validateInput(text);const replyTo=validateReply(this.store,chatId,metadata.replyTo);
    // A reply to a workflow run card carries that run's result into this turn only.
    const runRef=metadata.runRef!=null?(this.resolveRunRef?this.resolveRunRef(chatId,metadata.runRef):null):null;
    if(metadata.runRef!=null&&!runRef)throw new Error('引用的运行无效');
    const runtime=this.registry.resolve(chat.provider);if(!runtime)throw new Error('未找到这个工具的程序，请在连接设置中配置');
    const options=validateOptions(chat.provider,chat.options[chat.provider]);
    if(!isAbsolute(chat.workspace)||!existsSync(chat.workspace)||!statSync(chat.workspace).isDirectory())throw new Error('工作目录不存在，请在对话设置中指定完整路径');
    // Reserve before any asynchronous provider work to reject concurrent sends.
    const run={id:randomUUID(),chatId,provider:chat.provider,started:new Date().toISOString(),lastEventAt:Date.now(),stalled:false,approvals:new Map(),goal:null,
      controller:new AbortController(),control:null,inputs:new Map(),guidanceRequests:new Map(),inputChain:Promise.resolve()};
    this.active.set(chatId,run);
    try {
      const probe=await this.registry.probe(chat.provider);
      if(options.effort)validateEffort(await this.registry.models(chat.provider,chat.workspace),options);
      if(chat.provider==='claude'){
        if(probe.loggedIn===false)throw new Error('Claude Code 尚未登录，请先在 Claude Code 中登录，再重新检查工具');
        options.nativeNoPrompts=!!probe.nativeNoPrompts;
      }
      if(options.mode==='goal'&&!probe.nativeGoal)throw new Error('本机 Codex 版本尚未提供目标接口，请更新 Codex 后刷新连接');
      if(chat.provider==='codex'&&options.mode==='plan'&&!probe.nativePlan)throw new Error('当前工具尚未提供计划模式');
      if(chat.provider==='codex'&&options.permissionMode==='auto-review'&&!probe.nativeAutoReview)throw new Error('本机 Codex 暂不支持自动审核，请更新后重试或选择请求批准');
      const attached=this.attachments?await this.attachments.resolve(attachmentIds):[];
      const attachmentContext=this.attachments?.context(attached)||'';
      // Desk turns are Starport's own machinery. The room grants each companion memory reading
      // and/or proposals; history tools stay off. Memory is scoped to, and evidence comes from,
      // the conversation the desk works for, never the assembled desk prompt.
      const deskTools=metadata.desk?new Set([...metadata.memory?.read?MEMORY_READ_TOOLS:[],...metadata.memory?.propose?MEMORY_PROPOSE_TOOLS:[]]):null;
      const noContextTools=metadata.disableContextTools||deskTools?.size===0;
      const memoryChat=metadata.desk?this.store.chat(chat.options?.desk?.parentChatId)||chat:chat;
      const memoryUsers=()=>this.store.messages(memoryChat.id).filter(row=>row.role==='user'&&row.status==='complete');
      const deskSuffix=deskTools?':'+[...deskTools].sort().join(','):'',binding=contextBinding(chat,options);
      const fingerprint=sessionFingerprint(runtime,chat,options,this.store.memory.epoch,this.store.instructions.fingerprint(chat.project_id||null))+deskSuffix;
      const promoted=this.promotedFingerprint(runtime,chat,options,deskSuffix);
      let session=this.store.session(chatId,chat.provider);
      if(session&&session.fingerprint!==fingerprint&&session.fingerprint!==promoted)session=null;
      // A fallback answer started without the older history. Do not keep resuming that
      // incomplete native context forever; rebuild it on the next ordinary turn.
      if(session&&!metadata.desk&&this.store.messages(chatId).some(row=>row.details?.sessionId===session.native_id&&row.details?.contextCompaction?.status==='error'))session=null;
      if(chat.provider==='deepseek')session=null;
      const attachmentDetails=attached.length?{attachments:attached.map(row=>this.attachments.metadata(row)),attachmentContext}:{};
      const user=metadata.queued?this.store.queue.consume(metadata.queued,attachmentDetails):this.store.message(chatId,'user',chat.provider,text,'complete',{...attachmentDetails,...(replyTo?{replyTo}:{}),...(runRef?{runRef:runRef.ref,runContext:runRef.context}:{})});
      const recall=metadata.desk&&!metadata.memory?.read?{items:[],index:[],epoch:this.store.memory.epoch,text:'',omitted:0}:this.store.memory.recall(text,{projectId:memoryChat.project_id||null,recentMessages:this.store.messages(chatId)});
      // A conversation's own model may propose an exam; only the user can start it.
      const proposeExam=!metadata.desk&&this.proposeExam?args=>this.proposeExam(chatId,args):null;
      const preamble=(metadata.desk&&!metadata.memory?.propose?'':this.store.memory.instructions())+(metadata.bare?'':this.store.instructions.prompt(chat.project_id||null))+recall.text+(noContextTools?'':contextToolInstructions(chat.provider,deskTools,{exam:!!proposeExam}));
      const inputCap=INPUT_BYTE_LIMITS[chat.provider];
      const toolChatId=noContextTools||deskTools&&!deskTools.has('starport_history_read')?null:chatId;
      // A fresh session (another model, a branch, changed settings, or DeepSeek on every turn) is
      // held to its tool's budget and gets the conversation's summary in place of older messages.
      // A continuing native session already holds its history; desks get only their own prompt.
      const fresh=!session&&!metadata.desk&&!!this.compactor;
      const limits=fresh?{maxChars:Infinity,...this.compactor.limits(chat.provider,preamble)}:{maxBytes:inputCap?inputCap-Buffer.byteLength(preamble):Infinity};
      const compaction=fresh?this.compactor.plan(chatId,limits):null;
      // What isn't given verbatim goes to a file in the workspace, which even a sandboxed tool can read.
      const historyFile=historyArchivePath(chat);
      let context=null,prompt='',archived=false;
      const assemble=()=>{
        const options={...limits,chatId:toolChatId,summary:fresh?this.compactor.summaryFor(chatId):null};
        context=buildContext(this.store.messages(chatId),session?.cursor,{...options,historyFile});archived=false;
        try{archived=writeHistoryArchive(historyFile,chat,context);}catch{}
        if(!archived&&(context.earlier.length||context.trimmed))context=buildContext(this.store.messages(chatId),session?.cursor,options);
        prompt=preamble+context.text;
      };
      const contextNotices=(compacted=null)=>{
        const where=archived?'，原文另存在工作目录的 .starport/history 文件里':'';
        return [
          context.summarized?(compacted?`已把较早的 ${context.summarized} 条消息压缩成摘要（由 ${compacted} 整理）${where}。`:`较早的 ${context.summarized} 条消息以摘要形式交给本次模型${where}。`):null,
          context.omitted?`${context.summarized?'摘要之后另有':'较早的'} ${context.omitted} 条消息未直接附带给本次模型${archived?'，已另存为工作目录下的 .starport/history 文件供它读取':'，完整记录仍保存在本地'}。`:null
        ].filter(Boolean);
      };
      if(!compaction)assemble();
      run.phase=compaction?'compacting':'answering';
      const assistant=this.store.message(chatId,'assistant',chat.provider,'','running',{runId:run.id,liveRevision:0,activity:[],tools:[],subagents:[],notices:compaction?[]:contextNotices(),...(compaction?{contextCompaction:{status:'running',startedAt:Date.now(),covered:compaction.covered}}:{})});
      assistant.details.context={...this.context(chatId),binding,fingerprint};
      assistant.details.memory={epoch:recall.epoch,ids:recall.items.map(row=>row.id),omitted:recall.omitted,candidates:[],sources:[],browsed:(recall.index||[]).map(({id,title,kind})=>({id,title,kind})),reads:[],projectId:memoryChat.project_id||null,preferencesRevision:this.store.instructions.get().revision,projectRevision:chat.project_id?this.store.instructions.get(chat.project_id).revision:0};
      run.message=assistant;
      if(chat.title==='新对话')this.store.updateChat(chatId,{title:text.replace(/\s+/g,' ').slice(0,36)});
      this.broadcast('message',this.live(chatId));
      this.broadcast('refresh',{chatId});
      let nativeId=session?.native_id;
      const emit=e=>{
        if(run.ended||this.active.get(chatId)!==run)return;
        if(e.type==='input-consumed'){
          const input=run.inputs.get(e.id);if(!input)return;
          input.status='complete';input.details.guidance.state='delivered';input.details.liveRevision++;run.cursor=input.id;this.store.saveMessage(input);
          this.broadcast('message',{...this.live(chatId),message:input});return;
        }
        assistant.details.liveRevision++;
        run.lastEventAt=Math.max(run.lastEventAt,e.type==='subagent'?(e.updatedAt??Date.now()):Date.now());
        run.stalled=Date.now()-run.lastEventAt>3*60*1000;
        if(e.type==='delta')assistant.content+=e.text||'';
        if(e.type==='replace')assistant.content=e.text||'';
        if(e.type==='final-answer')assistant.details.finalAnswer=e.text||'';
        if(e.type==='session'){nativeId=e.id;assistant.details.sessionId=e.id;if(e.model)assistant.details.model=e.model;}
        if(e.type==='usage')assistant.details.usage=e.usage;
        if(e.type==='context')assistant.details.context={...e.context,provider:chat.provider,binding,fingerprint};
        if(e.type==='tool'){
          const event=JSON.parse(redact(JSON.stringify(e)));delete event.type;
          const old=assistant.details.tools.find(t=>t.id===event.id);
          if(old?.status==='denied'&&event.status==='error')event.status='denied';
          old?Object.assign(old,event):assistant.details.tools.push(event);
          mergeActivity(assistant.details.activity,e);
        }
        if(e.type==='activity')mergeActivity(assistant.details.activity,e);
        if(e.type==='subagent')mergeSubagent(assistant.details.subagents,e);
        if(e.type==='notice')assistant.details.notices.push(redact(e.text).slice(0,5000));
        if(e.type==='diagnostic'){
          const {type,...entry}=JSON.parse(redact(JSON.stringify(e)));
          assistant.details.diagnostics=[...(assistant.details.diagnostics||[]),{...entry,at:new Date().toISOString()}].slice(-40);
        }
        if(e.type==='goal'){run.goal=e.goal;assistant.details.goal=e.goal;}
        if(e.type==='phase'&&['answering','background'].includes(e.phase))run.phase=e.phase;
        if(e.type==='approval')run.approvals.set(e.request.id,e.request);
        if(e.type==='approval-resolved')run.approvals.delete(e.id);
        this.store.saveMessage(assistant);
        this.broadcast('message',{chatId,runId:run.id,message:assistant,run:this.state(chatId),context:this.context(chatId)});
      };
      let polling=null,watching=true;
      const pollSubagents=()=>{
        if(chat.provider!=='antigravity'||!nativeId||polling||!watching)return polling;
        polling=this.subagentReader.snapshot(nativeId,{since:Date.parse(run.started)}).then(rows=>{
          for(const row of rows){
            const old=assistant.details.subagents.find(item=>item.id===row.id);
            if(!old||Object.entries(row).some(([key,value])=>old[key]!==value))emit({type:'subagent',...row});
          }
        }).catch(()=>{}).finally(()=>{polling=null;});
        return polling;
      };
      const subagentTimer=chat.provider==='antigravity'?setInterval(pollSubagents,2000):null;
      subagentTimer?.unref?.();
      const implementation=this.implementations[chat.provider] || (chat.provider==='codex'?runCodex:chat.provider==='claude'?runClaude:chat.provider==='deepseek'?runDeepseek:runCli);
      const receivedUsers=()=>this.store.messages(chatId).filter(row=>row.role==='user'&&(prompt.includes(row.content)||row.details?.nativeQuestionReply?.runId===run.id||row.details?.guidance?.runId===run.id&&['accepted','delivered'].includes(row.details.guidance.state)));
      const contextTools=noContextTools?null:contextToolHost({store:this.store,chat:memoryChat,messages:metadata.desk?memoryUsers:receivedUsers,tools:deskTools,exam:proposeExam,signal:run.controller.signal,isActive:()=>!run.finalizing&&!run.ended,onEvent:emit,
        onBrowse:items=>{for(const item of items)if(!assistant.details.memory.browsed.some(old=>old.id===item.id))assistant.details.memory.browsed.push({id:item.id,title:item.title,kind:item.kind});},
        onMemories:(items,reason)=>{for(const item of items){if(!assistant.details.memory.ids.includes(item.id))assistant.details.memory.ids.push(item.id);assistant.details.memory.reads.push({id:item.id,revision:item.revision,reason});}},
        onCandidate:id=>{if(!assistant.details.memory.candidates.includes(id))assistant.details.memory.candidates.push(id);},
        onSources:sources=>{for(const source of sources)if(!assistant.details.memory.sources.some(old=>old.citation===source.citation)&&assistant.details.memory.sources.length<80)assistant.details.memory.sources.push(source);}});
      if(contextTools&&['antigravity','deepseek'].includes(chat.provider))run.contextBridge=await contextCommandBridge(contextTools);
      // Stall watchdog: surface long silences WITHOUT killing anything. A single
      // long step must never be mistaken for a dead process — the UI warns and
      // the user decides; the only kill paths are the stop button and the tool's
      // own limits. Any event (text, tool, step, usage…) counts as activity.
      const STALL_WARN_MS=3*60*1000;
      const watchdog=setInterval(()=>{
        if(!this.active.has(chatId)) return clearInterval(watchdog);
        const stalled=Date.now()-run.lastEventAt>STALL_WARN_MS;
        if(stalled!==run.stalled){run.stalled=stalled;this.broadcast('message',{chatId,message:assistant,run:this.state(chatId),context:this.context(chatId)});}
      },15000);
      watchdog.unref?.();
      // Compaction runs inside the turn, before the tool starts, so stopping the turn stops it too.
      const compact=async()=>{
        if(!compaction)return;
        const result=await this.compactor.compact(chat,compaction,{signal:run.controller.signal,onProgress:progress=>{
          if(run.controller.signal.aborted||run.ended)return;
          Object.assign(assistant.details.contextCompaction,progress);
          run.lastEventAt=Date.now();run.stalled=false;
          assistant.details.liveRevision++;this.store.saveMessage(assistant);
          this.broadcast('message',{chatId,runId:run.id,message:assistant,run:this.state(chatId),context:this.context(chatId)});
        }});
        if(run.controller.signal.aborted)throw Object.assign(new Error('已停止'),{canceled:true});
        assemble();
        run.phase='answering';
        Object.assign(assistant.details.contextCompaction,{status:result.summary?'complete':'error',endedAt:Date.now()});
        run.lastEventAt=Date.now();run.stalled=false;
        const by=result.summary?[result.summarizer.provider,result.summarizer.model].filter(Boolean).join(' · '):null;
        assistant.details.notices=[...result.summary?[]:[`压缩没有成功（${result.attempts.map(a=>`${a.provider}${a.model?' · '+a.model:''}：${a.error}`).join('；')||'没有可用的压缩模型'}），这次只附带最近的消息；下次会重新尝试整理。`],...contextNotices(by)];
        if(result.summary)assistant.details.compaction={covered:result.summary.covered,provider:result.summary.provider,model:result.summary.model,created:result.summary.created};
        assistant.details.liveRevision++;this.store.saveMessage(assistant);
        this.broadcast('message',{chatId,runId:run.id,message:assistant,run:this.state(chatId),context:this.context(chatId)});
      };
      run.done=(compaction?Promise.resolve().then(compact):Promise.resolve()).then(()=>implementation({provider:chat.provider,runtime,options,session:session?.native_id,initialContext:assistant.details.context,prompt,contextTools,contextEnv:noContextTools?{STARPORT_CONTEXT_URL:'',STARPORT_CONTEXT_TOKEN:''}:run.contextBridge?.env||{},images:this.attachments?.images(attached)||[],goalObjective:text.trim(),cwd:chat.workspace,unattended:!!metadata.desk,
        signal:run.controller.signal,emit,setControl:control=>{run.control=control;if(run.controller.signal.aborted)Promise.resolve(control.stop?.()).catch(()=>{});this.broadcast('message',this.live(chatId));}}))
        .then(()=>{
          run.finalizing=true;
          assistant.status='complete';
          this.registry.record(chat.provider,true);
        }).catch(error=>{
          run.finalizing=true;
          assistant.status=error.canceled||run.controller.signal.aborted?'interrupted':'error';
          assistant.details.error=redact(error.message).slice(0,8000);
          // Explicitly paused native goals retain their identity and accumulated budget.
          if(assistant.status==='interrupted' && nativeId && chat.provider==='codex' && assistant.details.goal?.status==='paused')
            this.store.saveSession(chatId,chat.provider,nativeId,assistant.id,fingerprint);
          else if(chat.provider==='antigravity' && error.antigravityStartupFailure && session) {
            // No native events or tools were run. Keep the old cursor so the
            // next request can resume without replaying the native history.
            this.store.saveSession(chatId,chat.provider,session.native_id,session.cursor,session.fingerprint);
          }
          else this.store.clearSession(chatId,chat.provider);
          if(assistant.status==='error')this.registry.record(chat.provider,false,assistant.details.error);
        }).finally(async()=>{
          await run.inputChain.catch(()=>{});
          clearInterval(watchdog);clearInterval(subagentTimer);
          if(polling)await polling;
          await pollSubagents();watching=false;
          run.ended=true;assistant.details.liveRevision++;
          assistant.details.endedAt=Date.now();
          if(assistant.details.contextCompaction?.status==='running')Object.assign(assistant.details.contextCompaction,{status:assistant.status==='interrupted'?'interrupted':'error',endedAt:assistant.details.endedAt});
          settleActivity(assistant.details,assistant.status);run.approvals.clear();
          settleSubagents(assistant.details.subagents,assistant.status,assistant.details.endedAt);
          if(assistant.status==='complete'&&(!metadata.desk||metadata.memory?.propose)){
            try{assistant.details.memory.candidates=[...new Set([...assistant.details.memory.candidates,...(metadata.desk?this.store.memory.capture(memoryChat,assistant,memoryUsers()):this.store.memory.capture(chat,assistant,receivedUsers()))])];}
            catch{assistant.details.notices.push('候选记忆暂未保存，可以稍后手动添加。');}
          }
          for(const input of run.inputs.values())if(input.status==='pending'){
            input.status=assistant.status==='interrupted'?'interrupted':'error';input.details.guidance.state='not-delivered';input.details.liveRevision++;
            input.details.error='任务已结束，这条追加消息尚未交给原工具；请确认后重新发送。';this.store.saveMessage(input);
            this.broadcast('message',{...this.live(chatId),message:input});
          }
          if(assistant.status==='complete'&&nativeId){
            if(run.cursor){const input=this.store.messageById(chatId,run.cursor);if(input){input.details.context=assistant.details.context;input.details.sessionId=nativeId;this.store.saveMessage(input);}}
            this.store.saveSession(chatId,chat.provider,nativeId,run.cursor||assistant.id,fingerprint);
          }
          this.store.saveMessage(assistant);this.active.delete(chatId);
          await run.contextBridge?.close();
          if(assistant.status!=='complete')this.store.queue.hold(chatId,'当前任务已停止或失败，请确认后继续发送。');
          // Send the saved, settled state directly. Completion must not wait for
          // provider discovery, full history recovery or an optional refresh hint.
          this.broadcast('message',this.live(chatId));this.broadcast('refresh',{chatId});
          // Tell the user once the chat is done: not for workflow desks, a stop
          // they pressed themselves, or a reply the queue is about to continue.
          const continues=assistant.status==='complete'&&this.store.queue.list(chatId)[0]?.state==='queued';
          if(!metadata.desk&&!this.closing&&!continues&&['complete','error'].includes(assistant.status))
            try{this.onFinished?.({chatId,status:assistant.status,text:assistant.status==='error'?assistant.details.error:assistant.content});}catch{}
          if(assistant.status==='complete'&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});
        });
      const result={id:run.id,user,assistant};Object.defineProperty(result,'done',{value:run.done});
      return result;
    } catch(error) {await run.contextBridge?.close();this.active.delete(chatId);this.broadcast('message',this.live(chatId));throw error;}
  }
  async messages(chatId){
    const messages=this.store.messages(chatId);
    for(let index=0;index<messages.length;index++){
      const message=messages[index];
      if(this.activityHistory&&!this.active.has(chatId)&&['codex','claude'].includes(message.provider)&&message.role==='assistant'&&message.details.sessionId&&!message.details.activity?.length){
        try{
          const source=await this.activityHistory.read(message.provider,message.details.sessionId),activity=recoverActivity(message,source);
          if(activity){message.details.activity=activity;message.details.activityRecovered=true;this.store.saveMessage(message);}
        }catch{}
      }
      if(message.provider!=='antigravity'||message.role!=='assistant'||!message.details.sessionId||message.details.subagents!==undefined)continue;
      if(this.active.has(chatId))continue;
      const until=message.details.endedAt??Date.parse(messages[index+1]?.created||new Date().toISOString());
      try{
        const rows=await this.subagentReader.snapshot(message.details.sessionId,{since:Date.parse(message.created),until});
        if(!rows.length)continue;
        // An old run has ended. Never count an unconfirmed child as successful.
        settleSubagents(rows,message.status,Math.max(...rows.map(row=>row.updatedAt)));
        message.details.subagents=rows;this.store.saveMessage(message);
      }catch{}
    }
    return messages;
  }
  async stop(chatId){this.store.queue.hold(chatId,'当前任务已停止，请确认后继续发送。');const run=this.active.get(chatId);if(!run){this.broadcast('message',this.live(chatId));return;}run.controller.abort();if(run.control?.stop)await run.control.stop();}
  enqueue(chatId,data){
    const run=this.active.get(chatId);if(run&&data.runId!==run.id)throw Object.assign(new Error('当前任务已改变，请重新发送'),{status:409});
    const row=this.store.queue.add(chatId,{...data,attachments:this.checkAttachments(data.attachments).map(row=>this.attachments.metadata(row))});this.broadcast('message',this.live(chatId));
    if(!run&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return {queued:row,...row.message?{user:row.message}:{},...this.store.queue.snapshot(chatId)};
  }
  editQueued(chatId,id,data){this.store.queue.edit(chatId,id,data.revision,data.text);this.broadcast('message',this.live(chatId));if(!this.active.has(chatId)&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return this.store.queue.snapshot(chatId);}
  beginQueuedEdit(chatId,id,data){this.store.queue.beginEdit(chatId,id,data.revision);this.broadcast('message',this.live(chatId));return this.store.queue.snapshot(chatId);}
  cancelQueuedEdit(chatId,id,data){this.store.queue.cancelEdit(chatId,id,data.revision);this.broadcast('message',this.live(chatId));if(!this.active.has(chatId)&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return this.store.queue.snapshot(chatId);}
  deleteQueued(chatId,id,data){this.store.queue.remove(chatId,id,data.revision);this.broadcast('message',this.live(chatId));if(!this.active.has(chatId)&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return this.store.queue.snapshot(chatId);}
  async dispatchQueue(chatId,id=null,revision=null){
    if(this.closing||this.active.has(chatId)){if(id)throw Object.assign(new Error('请等待当前任务结束，或选择引导'),{status:409});return;}
    const queued=id?this.store.queue.editable(chatId,id,revision):this.store.queue.list(chatId)[0];if(!queued||!id&&queued.state!=='queued')return;
    if(queued.state==='editing')throw Object.assign(new Error('请先保存或取消修改'),{status:409});
    const chat=this.store.chat(chatId);if(chat?.provider!==queued.provider){this.store.queue.hold(chatId,'工具已改变，请切回原工具后继续发送。');this.broadcast('message',this.live(chatId));return;}
    const row=this.store.queue.change(queued,'dispatching',{...queued.details,error:undefined});this.broadcast('message',this.live(chatId));
    try{return await this.start(chatId,row.content,attachmentIds(row),{queued:row,replyTo:row.details.replyTo});}
    catch(error){const remaining=this.store.queue.get(chatId,row.id);if(remaining)this.store.queue.change(remaining,'held',{...remaining.details,error:redact(error.message)});this.store.queue.hold(chatId,'未发送成功，请确认后继续发送。');this.broadcast('message',this.live(chatId));throw error;}
  }
  async steerQueued(chatId,id,{revision,runId}={}){
    const run=this.active.get(chatId);if(!run||run.id!==runId||run.control?.inputMode!=='steer'||!this.state(chatId).inputReady)throw Object.assign(new Error('当前任务暂不支持引导，消息仍在队列中'),{status:409});
    const queued=this.store.queue.editable(chatId,id,revision);if(queued.provider!==run.provider)throw new Error('请切回这条消息的原工具');
    if(queued.state==='editing')throw Object.assign(new Error('请先保存或取消修改'),{status:409});
    const row=this.store.queue.change(queued,'steering');this.broadcast('message',this.live(chatId));
    try{
      const result=await this.guidance(chatId,{text:row.content,runId,clientId:row.id+'-'+revision,replyTo:row.details.replyTo,attachments:attachmentIds(row)});
      if(['not-delivered','unconfirmed'].includes(result.delivery))throw new Error(result.user?.details?.error||'未确认送达');
      result.user.details.queuedMessage={id:row.id,clientId:row.client_id,inputHash:row.details.inputHash};
      result.user.details.liveRevision=(result.user.details.liveRevision||0)+1;this.store.saveMessage(result.user);
      this.store.queue.erase(row);this.broadcast('message',this.live(chatId));
      // If the native turn finished during steering, continue the next waiting item.
      if(!this.active.has(chatId)&&this.store.lastAssistant(chatId)?.status==='complete'&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});
      return {user:result.user,...this.store.queue.snapshot(chatId)};
    }catch(error){const remaining=this.store.queue.get(chatId,id);if(remaining)this.store.queue.change(remaining,'held',{...remaining.details,error:redact(error.message)});this.broadcast('message',this.live(chatId));throw error;}
  }
  async answer(chatId,id,answer){
    const run=this.active.get(chatId),request=run?.approvals.get(String(id));if(!run?.control?.answer)throw new Error('请求已失效');
    if(answer.decision==='skip'&&request?.kind!=='question')throw new Error('无效的审批选项');
    const promise=run.inputChain.catch(()=>{}).then(async()=>{
      await run.control.answer(id,answer);
      if(request?.kind==='question'&&['accept','skip'].includes(answer.decision)){
        const skipped=answer.decision==='skip';
        const text=skipped?'已跳过助手的问题。':(request.params.questions||[]).map(q=>q.question+'\n'+[].concat(answer.answers?.[q.id]||[]).join('、')).join('\n\n');
        const user=this.store.message(chatId,'user',run.provider,text,'complete',{nativeQuestionReply:{requestId:String(id),runId:run.id,...skipped?{skipped:true}:{}}});run.cursor=user.id;
        this.broadcast('message',{...this.live(chatId),message:user});
      }
    });
    run.inputChain=promise;return promise;
  }
  skipQuestions(chatId,replyTo){
    const reply=validateReply(this.store,chatId,replyTo);
    if(!reply||this.store.lastAssistant(chatId)?.id!==reply.messageId)throw new Error('问题已失效，请重新打开对话');
    const message=this.active.get(chatId)?.message||this.store.messageById(chatId,reply.messageId);
    if(message.id!==reply.messageId)throw new Error('问题已失效，请重新打开对话');
    const skipped=new Set(message.details.skippedQuestions||[]);
    for(const id of reply.questions)skipped.add(id);
    if(skipped.size>64)throw new Error('跳过的问题过多');
    message.details.skippedQuestions=[...skipped];message.details.liveRevision=(message.details.liveRevision||0)+1;
    this.store.saveMessage(message);const snapshot=this.live(chatId);this.broadcast('message',snapshot);return snapshot;
  }
  // Attachments join the running task as they would a new message: images go to tools that take
  // them natively, and each attachment's description (path, file text) follows the text.
  async guidance(chatId,{text,runId,clientId,replyTo,attachments=[]}={}){
    validateInput(text);
    if(typeof clientId!=='string'||!/^[-\w]{1,100}$/.test(clientId)||typeof runId!=='string')throw new Error('补充消息标识无效');
    const rows=this.checkAttachments(attachments),ids=rows.map(row=>row.id).join();
    const previous=this.store.guidanceReceipt(chatId,clientId),run=this.active.get(chatId),cached=run?.guidanceRequests.get(clientId);
    if(cached){if(cached.text!==text||cached.ids!==ids||run.id!==runId)throw new Error('补充消息标识已用于另一条消息');return cached.promise;}
    if(previous){if(previous.content!==text||(previous.details.attachments||[]).map(row=>row.id).join()!==ids||previous.details.guidance.runId!==runId)throw new Error('补充消息标识已用于另一条消息');return {user:previous,delivery:previous.details.guidance.state};}
    if(!run||run.id!==runId||!this.state(chatId).inputReady)throw Object.assign(new Error('当前任务暂不接收补充消息；输入已保留，请稍后再试。'),{status:409});
    if(run.guidanceRequests.size>=64)throw new Error('本次任务的追加消息已达上限，请等待任务完成。');
    const attachmentContext=rows.length?this.attachments.context(rows):'';
    const reply=validateReply(this.store,chatId,replyTo),user=this.store.message(chatId,'user',run.provider,text,'pending',{liveRevision:0,guidance:{runId,clientId,state:'sending'},...(rows.length?{attachments:rows.map(row=>this.attachments.metadata(row)),attachmentContext}:{}),...(reply?{replyTo:reply}:{})});
    run.inputs.set(user.id,user);this.broadcast('message',{...this.live(chatId),message:user});
    const promise=run.inputChain.catch(()=>{}).then(async()=>{
      if(run.controller.signal.aborted||run.finalizing)throw Object.assign(new Error('当前任务已结束；输入已保留，请重新发送。'),{status:409});
      const attached=rows.length?await this.attachments.resolve(rows.map(row=>row.id)):[];
      const result=await run.control.steer(attachmentContext?text+'\n\n'+attachmentContext:text,{id:user.id,images:attached.length?this.attachments.images(attached):[]});
      if(user.status==='pending'){
        user.details.guidance.state=result?.delivery==='queued'?'queued':'accepted';
        if(user.details.guidance.state==='accepted'){user.status='complete';run.cursor=user.id;}
      }
      user.details.liveRevision++;this.store.saveMessage(user);this.broadcast('message',{...this.live(chatId),message:user});
      return {user,delivery:user.details.guidance.state};
    }).catch(error=>{
      user.status='error';user.details.liveRevision++;user.details.guidance.state=/timeout|timed out|connection|disconnected|断开|超时/i.test(error.message)?'unconfirmed':'not-delivered';user.details.error=redact(error.message).slice(0,2000);this.store.saveMessage(user);
      this.broadcast('message',{...this.live(chatId),message:user});throw error;
    });
    run.inputChain=promise;run.guidanceRequests.set(clientId,{text,ids,promise});return promise;
  }
  async goal(chatId,action){const run=this.active.get(chatId);if(!run?.control?.goal)throw new Error('当前没有运行中的目标');await run.control.goal(action);}
  async close(){this.closing=true;await Promise.all([...this.active.keys()].map(id=>this.stop(id)));await Promise.all([...this.active.values()].map(r=>r.done));}
}

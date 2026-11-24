import { AntigravitySubagents, mergeSubagent, settleSubagents } from './subagents.mjs';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildContext, writeHistoryArchive, historyArchivePath } from './storage.mjs';
import { validateOptions, PROVIDERS } from './providers.mjs';
import { ProviderPreferences } from './provider-preferences.mjs';
import { runCodex } from './adapters/codex.mjs';
import { runCli } from './adapters/cli.mjs';
import { runDeepseek } from './adapters/deepseek.mjs';
import { runOllama } from './adapters/ollama.mjs';
import { runClaude } from './adapters/claude.mjs';
import { mergeActivity, settleActivity } from './activity.mjs';
import { LivePatch } from './live-patch.mjs';
import { ActivityHistory, recoverActivity } from './activity-history.mjs';
import { redact } from './process.mjs';
import { validateEffort } from './effort.mjs';
import { contextBinding, emptyContext, sessionFingerprint, legacySessionFingerprint, effectiveContext } from './context.mjs';
import { validateInput, validateReply } from './interactions.mjs';
import { contextToolHost,contextCommandBridge,contextToolInstructions,MEMORY_READ_TOOLS,MEMORY_PROPOSE_TOOLS,CALL_TOOLS,KNOWLEDGE_TOOLS } from './context-tools.mjs';
import { insideFolder } from './knowledge.mjs';
import { PromptParts } from './prompt-parts.mjs';

// Starport transport guard after an observed truncation near 192,000 UTF-8 bytes.
// This is a conservative compatibility limit, not the model context window or a verified
// universal agy limit. Keep it until the installed transport is verified with larger inputs.
export const INPUT_BYTE_LIMITS={antigravity:184000};
const attachmentIds=row=>(row.details.attachments||[]).map(item=>item.id);
// Native sessions keep the tools they started with, so whom a model may call is part of its session.
const callSuffix=grant=>grant?':calls='+grant.callees.map(c=>c.id).sort().join(','):'';
// Codex keeps the tools a thread started with, so whether it may save to knowledge is part of its session.
const knowledgeSuffix=(provider,targets)=>provider==='codex'&&targets.length?':knowledge-save':'';
const streaming=row=>['running','pending'].includes(row.status);

export class Runner {
  constructor(store,registry,broadcast,implementations={},attachments=null,history=null) {this.store=store;this.registry=registry;this.broadcast=broadcast;this.active=new Map();this.implementations=implementations;this.attachments=attachments;this.subagentReader=new AntigravitySubagents();this.activityHistory=history?new ActivityHistory(history):null;this.preferences=new ProviderPreferences(store);this.prompts=new PromptParts();}
  checkAttachments(ids=[]){
    if(!this.attachments){if(Array.isArray(ids)&&!ids.length)return [];throw new Error('附件不可用');}
    return this.attachments.rows(ids);
  }
  // takesAttachments: the page is served from disk and can be newer than a server not yet
  // restarted; it offers attachments during a task only to a server that keeps them.
  state(chatId) {
    const run=this.active.get(chatId);return run?{id:run.id,provider:run.provider,started:run.started,lastEventAt:run.lastEventAt||run.started,stalled:!!run.stalled,phase:run.phase||'answering',approvals:[...run.approvals.values()],goal:run.goal,inputMode:run.control?.inputMode||null,takesAttachments:true,inputReady:!run.finalizing&&!run.controller.signal.aborted&&typeof run.control?.steer==='function'&&run.control.canSend?.()!==false}:null;
  }
  // Conversations whose model has stopped to ask the user a question and is waiting for the answer.
  asking(){return [...this.active].filter(([,run])=>[...run.approvals.values()].some(request=>request.kind==='question')).map(([chatId])=>chatId);}
  awaitingApproval(){
    return [...this.active].filter(([,run])=>[...run.approvals.values()].some(request=>request.kind!=='question')).map(([chatId])=>chatId);
  }
  // follow: messages the page still shows as running. A run card above the latest reply is not
  // the last assistant message, so a page that missed its end would otherwise never learn of it.
  // have: the running reply's id and revision the page already holds, from GET /api/live.
  live(chatId,follow=[],have=null){
    const chat=chatId?this.store.chat(chatId):null;
    const run=chatId?this.active.get(chatId):null;
    const message=run?.message||(chat?this.store.lastAssistant(chatId):null);let reply={message};
    if(run&&have?.id===message?.id){
      const revision=message.details.liveRevision,base=run.patch?.base?.revision;
      if(have.revision===revision)reply={};
      else if(Number.isFinite(base)&&base<=have.revision&&have.revision<revision)reply={patch:run.patch.diff()};
    }
    const runId=run?.id||message?.details?.runId||null;
    const followed=chat?follow.filter(id=>id!==message?.id).map(id=>this.store.messageById(chatId,id)).filter(Boolean):[];
    return {chatId:chat?.id||null,chat,active:[...this.active.keys()],asking:this.asking(),awaitingApproval:this.awaitingApproval(),providerVerifications:this.registry.verifications?.()||{},...reply,...followed.length?{followed}:{},inputs:chat?this.store.interactionMessages(chatId,runId):[],...chat?this.store.queue.snapshot(chatId):{},runId,run:chat?this.state(chatId):null,context:chat?this.context(chatId):null};
  }
  // What every page is sent: a running reply goes as its changes since the last push, which all
  // pages have had (live-patch.mjs). Packets that name another message keep using live().
  packet(chatId){
    const data=this.live(chatId),run=chatId?this.active.get(chatId):null;
    if(run?.patch&&data.message===run.message){const patch=run.patch.next();if(patch){delete data.message;data.patch=patch;}}
    return data;
  }
  // A running reply comes whole, since the page shows it open, and from memory, since saves trail
  // it by up to a second; the others with an outline of their logs, read when opened (store.trace).
  snapshot(chatId){
    const reply=this.active.get(chatId)?.message,messages=this.store.messages(chatId,{trace:streaming}).map(row=>row.id===reply?.id?reply:row);
    return {chat:this.store.chat(chatId),messages,...this.store.queue.snapshot(chatId),run:this.state(chatId),context:this.context(chatId)};
  }
  async refreshContext(chatId,refresh=false){
    const chat=this.store.chat(chatId);if(!chat)return null;
    const options=validateOptions(chat.provider,chat.options[chat.provider]),sample=this.context(chatId);
    await this.registry.contextLimits?.(chat.provider,chat.workspace,sample.model||options.model,refresh);
    return this.context(chatId);
  }
  context(chatId) {
    const chat=this.store.chat(chatId);if(!chat)return null;
    const options=validateOptions(chat.provider,chat.options[chat.provider]);
    // The meter is redrawn on every push of a running reply; a resolution a few seconds old serves it.
    const binding=contextBinding(chat,options),runtime=(this.registry.cachedResolve||this.registry.resolve).call(this.registry,chat.provider,chat.workspace);
    const suffix=chat.options?.desk?'':knowledgeSuffix(chat.provider,chat.provider==='codex'?this.store.knowledge.writeTargets(chat):[])+callSuffix(this.companionCalls?.grant(chat)||null);
    const active=this.active.get(chatId),session=this.store.session(chatId,chat.provider);
    const cursorMessage=session?this.store.messageById(chatId,session.cursor):null;
    const priorEpoch=cursorMessage?.details?.memory?.epoch??this.store.lastAssistant(chatId)?.details?.memory?.epoch;
    const current=value=>this.compatibleFingerprint(value,runtime,chat,options,suffix,priorEpoch);
    const message=active?.message||(current(session?.fingerprint)?cursorMessage:null);
    const saved=message?.details?.context,activeFingerprint=active?.message?.details?.context?.fingerprint;
    const valid=saved&&saved.binding===binding&&(activeFingerprint?saved.fingerprint===activeFingerprint:current(saved.fingerprint))&&(!session||active||message.details.sessionId===session.native_id);
    const sample={provider:chat.provider,binding,...valid?saved:emptyContext(chat.provider)};
    if(active?.phase==='compacting')Object.assign(sample,{status:'compacting',usedTokens:null});
    return effectiveContext(sample,this.compactor?.settings().budgets[chat.provider]*1000,
      this.registry.cachedContextLimits?.(chat.provider,chat.workspace,sample.model||options.model),INPUT_BYTE_LIMITS[chat.provider]);
  }
  // Existing native sessions saved before sessionFingerprint dropped memoryEpoch /
  // instructionFingerprint remain resumable across the upgrade and move to the new fingerprint
  // once their next turn completes.
  compatibleFingerprint(value,runtime,chat,options,suffix='',priorEpoch=null){
    if(!value||!runtime)return false;
    if(value===sessionFingerprint(runtime,chat,options)+suffix)return true;
    const epochs=new Set([this.store.memory.epoch,...(Number.isInteger(priorEpoch)?[priorEpoch]:[])]);
    const currentFp=this.store.instructions.fingerprint(chat.project_id||null);
    const globalFp=chat.project_id?this.store.instructions.fingerprint(null):null;
    for(const epoch of epochs){
      if(value===legacySessionFingerprint(runtime,chat,options,epoch,currentFp)+suffix)return true;
      if(chat.project_id&&value===legacySessionFingerprint(runtime,{...chat,project_id:null},options,epoch,globalFp)+suffix)return true;
    }
    return false;
  }
  recoverNativeSession(chatId,{messageId,action}={}) {
    if(typeof messageId!=='string'||!messageId||messageId.length>200||!['retry','independent'].includes(action))
      throw Object.assign(new Error('这条连接恢复操作已失效，请查看最新消息。'),{status:409});
    const conflict=this.store.messageById(chatId,messageId),receipt=conflict?.details?.nativeConflict;
    const user=receipt&&this.store.messageById(chatId,receipt.userId);
    if(!['retry','independent'].includes(action)||this.store.chat(chatId)?.provider!=='codex'||
      conflict?.role!=='assistant'||conflict.status!=='error'||receipt?.kind!=='active-writer'||
      receipt.delivery!=='not-delivered'||receipt.recoverable===false||user?.role!=='user'||user.provider!=='codex'||
      this.store.messages(chatId).at(-1)?.id!==messageId)
      throw Object.assign(new Error('这条连接恢复操作已失效，请查看最新消息。'),{status:409});
    return this.start(chatId,user.content,attachmentIds(user),{disableContextTools:!!receipt.disableContextTools,nativeRecovery:{messageId,action,userId:user.id,receipt}});
  }
  async start(chatId,text,attachmentIds=[],metadata={}) {
    if(this.active.has(chatId))throw Object.assign(new Error('这个对话正在运行，请先停止或等待完成'),{status:409});
    const chat=this.store.chat(chatId);if(!chat)throw new Error('对话不存在');
    validateInput(text);const replyTo=validateReply(this.store,chatId,metadata.replyTo);
    // A reply to a workflow run card carries that run's result into this turn only.
    const runRef=metadata.runRef!=null?(this.resolveRunRef?this.resolveRunRef(chatId,metadata.runRef):null):null;
    if(metadata.runRef!=null&&!runRef)throw new Error('引用的运行无效');
    const runtime=this.registry.resolve(chat.provider,chat.workspace);if(!runtime)throw new Error('未找到这个工具的程序，请在连接设置中配置');
    const options=validateOptions(chat.provider,chat.options[chat.provider]);
    if(!isAbsolute(chat.workspace)||!existsSync(chat.workspace)||!statSync(chat.workspace).isDirectory())throw new Error('工作目录不存在，请在对话设置中指定完整路径');
    // Reserve before any asynchronous provider work to reject concurrent sends.
    const run={id:randomUUID(),chatId,provider:chat.provider,started:new Date().toISOString(),lastEventAt:Date.now(),stalled:false,approvals:new Map(),goal:null,
      controller:new AbortController(),control:null,inputs:new Map(),guidanceRequests:new Map(),inputChain:Promise.resolve()};
    this.active.set(chatId,run);
    try {
      let probe=await this.registry.probe(chat.provider);
      if(options.effort)validateEffort(await this.registry.models(chat.provider,chat.workspace),options);
      if(chat.provider==='claude'){
        // Claude can be signed in outside Starport while this probe is cached.
        if(probe.loggedIn===false)probe=await this.registry.probe(chat.provider,true);
        if(probe.loggedIn===false)throw new Error('Claude Code 尚未登录，请先在 Claude Code 中登录，再重新检查工具');
        options.nativeNoPrompts=!!probe.nativeNoPrompts;
      }
      if(options.mode==='goal'&&!probe.nativeGoal)throw new Error('本机 Codex 版本尚未提供目标接口，请更新 Codex 后刷新连接');
      if(chat.provider==='codex'&&options.mode==='plan'&&!probe.nativePlan)throw new Error('当前工具尚未提供计划模式');
      if(chat.provider==='codex'&&options.permissionMode==='auto-review'&&!probe.nativeAutoReview)throw new Error('本机 Codex 暂不支持自动审核，请更新后重试或选择请求批准');
      const attached=this.attachments?await this.attachments.resolve(attachmentIds):[];
      if(!metadata.desk&&!chat.options?.desk)this.preferences.remember(chat.provider,options);
      const attachmentContext=this.attachments?.context(attached)||'';
      // Desk turns are Starport's own machinery. The room grants each companion memory reading
      // and/or proposals; history tools stay off. Memory is scoped to, and evidence comes from,
      // the conversation the desk works for, never the assembled desk prompt.
      // A model at work may hand tasks to the companions its room lets it call; callChain is who
      // called whom to get here, so nobody up the chain is called again.
      // A tool that only answers in text (Ollama) gets no Starport tools or companions to call.
      const toolless=PROVIDERS[chat.provider]?.contextTools===false;
      const grant=metadata.bare||metadata.disableContextTools||toolless?null:this.companionCalls?.grant(chat,{chain:metadata.callChain||[]})||null;
      // Knowledge folders this turn may save into, when the user asks for it (knowledge.mjs).
      const knowledgeTargets=metadata.bare||metadata.disableContextTools||toolless?[]:this.store.knowledge.writeTargets(chat);
      const deskTools=metadata.desk?new Set([...metadata.memory?.read?MEMORY_READ_TOOLS:[],...metadata.memory?.propose?MEMORY_PROPOSE_TOOLS:[],...grant?CALL_TOOLS:[],...knowledgeTargets.length?KNOWLEDGE_TOOLS:[]]):null;
      const noContextTools=metadata.disableContextTools||toolless||deskTools?.size===0;
      const memoryChat=metadata.desk?this.store.chat(chat.options?.desk?.parentChatId)||chat:chat;
      // Starport writes the text of an @主模型 turn, so it never counts as the user's own words.
      const memoryUsers=()=>this.store.messages(memoryChat.id).filter(row=>row.role==='user'&&row.status==='complete'&&!row.details?.dispatchStep);
      const deskSuffix=(deskTools?':'+[...deskTools].sort().join(','):knowledgeSuffix(chat.provider,knowledgeTargets))+callSuffix(grant),binding=contextBinding(chat,options);
      const fingerprint=sessionFingerprint(runtime,chat,options)+deskSuffix;
      let session=this.store.session(chatId,chat.provider);
      const allMessages=this.store.messages(chatId);
      const priorEpoch=session?(allMessages.findLast(row=>row.role==='assistant'&&row.details?.sessionId===session.native_id&&row.details?.memory)?.details.memory.epoch??null):null;
      if(session&&!this.compatibleFingerprint(session.fingerprint,runtime,chat,options,deskSuffix,priorEpoch))session=null;
      // A fallback answer started without the older history. Do not keep resuming that
      // incomplete native context forever; rebuild it on the next ordinary turn.
      if(session&&!metadata.desk&&allMessages.some(row=>row.details?.sessionId===session.native_id&&row.details?.contextCompaction?.status==='error'))session=null;
      if(PROVIDERS[chat.provider]?.sessions===false)session=null;
      if(metadata.nativeRecovery){
        const {action,receipt}=metadata.nativeRecovery;
        if(action==='retry'&&(!session||session.native_id!==receipt.nativeId||session.cursor!==receipt.cursor||session.fingerprint!==receipt.fingerprint))
          throw Object.assign(new Error('连接设置已变化，请选择在独立会话中继续。'),{status:409});
        if(action==='independent')session=null;
      }
      const sessionTurns=session?allMessages.filter(row=>row.role==='assistant'&&row.details?.sessionId===session.native_id&&row.details?.memory&&(row.status==='complete'||row.status==='interrupted'&&row.details?.goal?.status==='paused')):[];
      const priorMemory=sessionTurns.at(-1)?.details?.memory||null,resumed=!!priorMemory;
      const attachmentDetails=attached.length?{attachments:attached.map(row=>this.attachments.metadata(row)),attachmentContext}:{};
      const user=metadata.nativeRecovery?this.store.messageById(chatId,metadata.nativeRecovery.userId):metadata.queued?this.store.queue.consume(metadata.queued,attachmentDetails):this.store.message(chatId,'user',chat.provider,text,'complete',{...attachmentDetails,...metadata.mobileSubmission?{mobileSubmission:metadata.mobileSubmission}:{},...(replyTo?{replyTo}:{}),...(runRef?{runRef:runRef.ref,runContext:runRef.context}:{}),...(metadata.dispatchStep?{dispatchStep:metadata.dispatchStep}:{})});
      const memoryChanges=resumed&&!(metadata.desk&&!metadata.memory?.read)?this.store.memory.sessionChanges(sessionTurns,{projectId:memoryChat.project_id||null}):{text:'',notified:[]};
      const recall=metadata.desk&&!metadata.memory?.read?{items:[],index:[],epoch:this.store.memory.epoch,text:'',omitted:0}:this.store.memory.recall(text,{projectId:memoryChat.project_id||null,recentMessages:this.store.messages(chatId),compact:resumed});
      // A conversation's own model may propose an exam; only the user can start it.
      const proposeExam=!metadata.desk&&this.proposeExam?args=>this.proposeExam(chatId,args):null;
      const captureEnabled=!(metadata.desk&&!metadata.memory?.propose)&&this.store.memory.config().capture;
      const capturePrompt=metadata.desk&&!metadata.memory?.propose?'':!resumed||priorMemory.capture===false&&captureEnabled?this.store.memory.instructions():priorMemory.capture!==false&&!captureEnabled?'星港候选记忆更新：候选记忆提炼已关闭，请勿调用 starport_memory_propose 或输出 starport-memory 代码块。\n':'';
      const instructionState=this.store.instructions.activeState(chat.project_id||null);
      const instructionPrompt=metadata.bare?'':this.store.instructions.sessionPrompt(chat.project_id||null,priorMemory);
      // Read-only folders from the room, the conversation and a working companion (knowledge.mjs).
      const knowledge=toolless?{folders:[],notices:[]}:this.store.knowledge.forRun(chat,{bare:!!metadata.bare});
      const priorKnowledge=resumed?sessionTurns.at(-1)?.details?.knowledge||{}:null;
      const knowledgeSave=knowledgeTargets.length>0;
      const knowledgePrompt=this.store.knowledge.sessionPrompt(knowledge.folders,priorKnowledge,{save:knowledgeSave});
      // Plugins' context for this turn, e.g. what the LaTeX editor has open (src/plugins/latex.mjs).
      const pluginPrompt=metadata.bare||toolless?'':await this.prompts.text({chat,resumed,desk:!!metadata.desk});
      const preamble=capturePrompt+instructionPrompt+knowledgePrompt+pluginPrompt+memoryChanges.text+recall.text+(noContextTools?'':contextToolInstructions(chat.provider,deskTools,{exam:!!proposeExam,callees:grant?.callees,knowledge:knowledgeSave,compact:resumed}));
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
        const messages=this.store.messages(chatId);
        context=buildContext(messages,session?.cursor,{...options,historyFile});archived=false;
        try{archived=writeHistoryArchive(historyFile,chat,context);}catch{}
        if(!archived&&(context.earlier.length||context.trimmed))context=buildContext(messages,session?.cursor,options);
        prompt=preamble+context.text;
      };
      const contextNotices=(compacted=null)=>{
        const where=archived?'，原文另存在工作目录的 .starport/history 文件里':'';
        return [
          context.summarized?(compacted?`已把较早的 ${context.summarized} 条消息压缩成摘要（由 ${compacted} 整理）${where}。`:`较早的 ${context.summarized} 条消息以摘要形式交给本次模型${where}。`):null,
          context.omitted?`${context.summarized?'摘要之后另有':'较早的'} ${context.omitted} 条消息未直接附带给本次模型${archived?'，已另存为工作目录下的 .starport/history 文件供它读取':'，完整记录仍保存在本地'}。`:null,
          ...knowledge.notices
        ].filter(Boolean);
      };
      if(!compaction)assemble();
      run.phase=compaction?'compacting':'answering';
      const assistant=this.store.message(chatId,'assistant',chat.provider,'','running',{runId:run.id,liveRevision:0,activity:[],tools:[],subagents:[],notices:compaction?[]:contextNotices(),...(compaction?{contextCompaction:{status:'running',startedAt:Date.now(),covered:compaction.covered}}:{})});
      if(metadata.nativeRecovery)assistant.details.nativeRecovery={messageId:metadata.nativeRecovery.messageId,action:metadata.nativeRecovery.action};
      assistant.details.context={...session?this.context(chatId):emptyContext(chat.provider),binding,fingerprint};
      if(knowledge.folders.length||priorKnowledge?.fingerprint)
        assistant.details.knowledge={fingerprint:this.store.knowledge.fingerprint(knowledge.folders,knowledgeSave),folders:knowledge.folders.map(({scope,name,path})=>({scope,name,path}))};
      assistant.details.memory={epoch:recall.epoch,ids:recall.items.map(row=>row.id),omitted:recall.omitted,candidates:[],sources:[],browsed:(recall.index||[]).map(({id,title,kind})=>({id,title,kind})),reads:[],notifiedChanges:memoryChanges.notified,capture:captureEnabled,projectId:memoryChat.project_id||null,instructionProjectId:instructionState.instructionProjectId,preferencesRevision:instructionState.preferencesRevision,projectRevision:instructionState.projectRevision,instructionsFingerprint:metadata.bare?'':instructionState.fingerprint,globalActive:metadata.bare?false:instructionState.globalActive,projectActive:metadata.bare?false:instructionState.projectActive};
      run.message=assistant;run.patch=new LivePatch(assistant);
      if(chat.title==='新对话')this.store.updateChat(chatId,{title:text.replace(/\s+/g,' ').slice(0,36)});
      this.broadcast('message',this.packet(chatId));
      this.broadcast('refresh',{chatId});
      let nativeId=session?.native_id,unsavedSession=false;
      // A desk used once (compaction, planning, a call, a workflow step, an exam seat) never
      // resumes, so its native session need not land in the tool's own history list.
      const oneOffDesk=!!chat.options?.desk&&!chat.options.desk.persistent;
      // A push carries what changed since the last one (live-patch.mjs), so it stays small however
      // long the reply grows. Pushes are still coalesced to about 2 MB/s, at most a second apart, in
      // case one is large; approvals and phase changes go out at once.
      let pushTimer=null,pushSize=0;
      const pushNow=()=>{
        clearTimeout(pushTimer);pushTimer=null;
        const patch=run.patch.next(),reply=patch?{patch}:{message:assistant};
        pushSize=this.broadcast('message',{chatId,runId:run.id,...reply,run:this.state(chatId),context:this.context(chatId)})||0;
      };
      const push=urgent=>{
        if(urgent)return pushNow();
        if(pushTimer)return;
        pushTimer=setTimeout(pushNow,Math.min(1000,Math.max(40,pushSize/2048)));pushTimer.unref?.();
      };
      // Saving rewrites the whole reply with its process log, so a turn saved on every token kept the
      // server too busy to answer anyone. Saves wait up to a second; the end of the turn saves at once.
      let saveTimer=null;
      const saveNow=()=>{clearTimeout(saveTimer);saveTimer=null;this.store.saveMessage(assistant);};
      const save=urgent=>{
        if(urgent)return saveNow();
        if(!saveTimer){saveTimer=setTimeout(saveNow,1000);saveTimer.unref?.();}
      };
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
        if(e.type==='replace'){assistant.content=e.text||'';run.patch.replaced();}
        if(e.type==='final-answer')assistant.details.finalAnswer=e.text||'';
        // agy names its conversation on every step; only a new one is worth saving at once.
        const newSession=e.type==='session'&&nativeId!==e.id;
        if(e.type==='session'){
          if(newSession)assistant.details.context={...emptyContext(chat.provider),provider:chat.provider,binding,fingerprint};
          nativeId=e.id;unsavedSession=!!e.ephemeral;assistant.details.sessionId=e.id;if(e.model)assistant.details.model=e.model;
        }
        if(e.type==='usage')assistant.details.usage=e.usage;
        if(e.type==='context')assistant.details.context={...e.context,sessionId:nativeId,provider:chat.provider,binding,fingerprint};
        if(e.type==='tool'){
          const event=JSON.parse(redact(JSON.stringify(e)));delete event.type;
          const old=assistant.details.tools.find(t=>t.id===event.id);
          if(old?.status==='denied'&&event.status==='error')event.status='denied';
          old?Object.assign(old,event):assistant.details.tools.push(event);
          mergeActivity(assistant.details.activity,e);
          run.patch.touch('tools',event.id);run.patch.touch('activity',e.id);
        }
        if(e.type==='activity'){mergeActivity(assistant.details.activity,e);run.patch.touch('activity',e.item?.id);}
        if(e.type==='subagent')mergeSubagent(assistant.details.subagents,e);
        if(e.type==='notice')assistant.details.notices.push(redact(e.text).slice(0,5000));
        if(e.type==='diagnostic'){
          const {type,...entry}=JSON.parse(redact(JSON.stringify(e)));
          assistant.details.diagnostics=[...(assistant.details.diagnostics||[]),{...entry,at:new Date().toISOString()}].slice(-40);
        }
        if(e.type==='goal'){run.goal=e.goal;assistant.details.goal=e.goal;}
        if(e.type==='phase'&&['answering','background'].includes(e.phase))run.phase=e.phase;
        if(e.type==='approval'){
          run.approvals.set(e.request.id,e.request);
          // Desks skip questions on their own; a conversation's model waits for the user.
          if(e.request?.kind==='question'&&!metadata.desk)this.onQuestion?.({chatId,request:e.request});
        }
        if(e.type==='approval-resolved')run.approvals.delete(e.id);
        const urgent=['approval','approval-resolved','phase','goal'].includes(e.type);
        save(urgent||newSession);push(urgent);
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
      // Tools that can enforce it get read-only access to the knowledge folders: Claude through
      // extra working directories with edits denied, its sandboxed terminal through read grants,
      // agy through --add-dir. Codex's sandbox already reads outside the working folder.
      const knowledgeDirs=knowledge.folders.map(folder=>folder.canonical);
      const knowledgeRuntime=knowledgeDirs.length&&runtime.externalTools
        ?{...runtime,externalTools:{...runtime.externalTools,knowledge:knowledgeDirs.filter(dir=>!insideFolder(dir,chat.workspace))}}:runtime;
      const implementation=this.implementations[chat.provider] || (chat.provider==='codex'?runCodex:chat.provider==='claude'?runClaude:chat.provider==='deepseek'?runDeepseek:chat.provider==='ollama'?runOllama:runCli);
      const receivedUsers=()=>this.store.messages(chatId).filter(row=>row.role==='user'&&!row.details?.dispatchStep&&(prompt.includes(row.content)||row.details?.nativeQuestionReply?.runId===run.id||row.details?.guidance?.runId===run.id&&['accepted','delivered'].includes(row.details.guidance.state)));
      const contextTools=noContextTools?null:contextToolHost({store:this.store,chat:memoryChat,messages:metadata.desk?memoryUsers:receivedUsers,tools:deskTools,exam:proposeExam,
        calls:grant?this.companionCalls.session(grant):null,
        // What the user said this turn must ask for a save: their own message and anything they
        // added while it ran; at a desk, the conversation message it works on.
        knowledge:knowledgeSave?{targets:knowledgeTargets,workspace:chat.workspace,requestText:()=>metadata.desk?memoryUsers().at(-1)?.content||''
          :[user.content,...this.store.messages(chatId).filter(row=>row.role==='user'&&(row.details?.guidance?.runId===run.id||row.details?.nativeQuestionReply?.runId===run.id)).map(row=>row.content)].join('\n')}:null,
        localControl:metadata.desk?null:this.localControl,signal:run.controller.signal,isActive:()=>!run.finalizing&&!run.ended,onEvent:emit,
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
        if(stalled!==run.stalled){run.stalled=stalled;pushNow();}
      },15000);
      watchdog.unref?.();
      // Compaction runs inside the turn, before the tool starts, so stopping the turn stops it too.
      const compact=async()=>{
        if(!compaction)return;
        const result=await this.compactor.compact(chat,compaction,{signal:run.controller.signal,onProgress:progress=>{
          if(run.controller.signal.aborted||run.ended)return;
          Object.assign(assistant.details.contextCompaction,progress);
          run.lastEventAt=Date.now();run.stalled=false;
          assistant.details.liveRevision++;this.store.saveMessage(assistant);pushNow();
        }});
        if(run.controller.signal.aborted)throw Object.assign(new Error('已停止'),{canceled:true});
        assemble();
        run.phase='answering';
        Object.assign(assistant.details.contextCompaction,{status:result.summary?'complete':'error',endedAt:Date.now()});
        run.lastEventAt=Date.now();run.stalled=false;
        const by=result.summary?[result.summarizer.provider,result.summarizer.model].filter(Boolean).join(' · '):null;
        assistant.details.notices=[...result.summary?[]:[`压缩没有成功（${result.attempts.map(a=>`${a.provider}${a.model?' · '+a.model:''}：${a.error}`).join('；')||'没有可用的压缩模型'}），这次只附带最近的消息；下次会重新尝试整理。`],...contextNotices(by)];
        if(result.summary)assistant.details.compaction={covered:result.summary.covered,provider:result.summary.provider,model:result.summary.model,created:result.summary.created};
        assistant.details.liveRevision++;this.store.saveMessage(assistant);pushNow();
      };
      run.done=(compaction?Promise.resolve().then(compact):Promise.resolve()).then(()=>implementation({provider:chat.provider,runtime:knowledgeRuntime,knowledgeDirs,options,session:session?.native_id,threadName:'StarPort · '+this.store.chat(chatId).title.replace(/\s+/g,' ').trim().slice(0,200),ephemeral:oneOffDesk,initialContext:assistant.details.context,prompt,contextTools,contextEnv:noContextTools?{STARPORT_CONTEXT_URL:'',STARPORT_CONTEXT_TOKEN:''}:run.contextBridge?.env||{},images:this.attachments?.images(attached)||[],goalObjective:text.trim(),cwd:chat.workspace,unattended:!!metadata.desk,
        signal:run.controller.signal,emit,setControl:control=>{run.control=control;if(run.controller.signal.aborted)Promise.resolve(control.stop?.()).catch(()=>{});this.broadcast('message',this.packet(chatId));}}))
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
          else if(chat.provider==='codex' && error.codexWriterConflict && session) {
            assistant.details.nativeConflict={kind:'active-writer',delivery:'not-delivered',nativeId:session.native_id,cursor:session.cursor,fingerprint:session.fingerprint,userId:user.id,recoverable:!metadata.desk,disableContextTools:!!noContextTools};
            this.store.saveSession(chatId,chat.provider,session.native_id,session.cursor,session.fingerprint);
          }
          else if(chat.provider==='antigravity' && error.antigravityStartupFailure && session) {
            // No native events or tools were run. Keep the old cursor so the
            // next request can resume without replaying the native history.
            this.store.saveSession(chatId,chat.provider,session.native_id,session.cursor,session.fingerprint);
          }
          else this.store.clearSession(chatId,chat.provider);
          if(assistant.status==='error'&&!assistant.details.nativeConflict)this.registry.record(chat.provider,false,assistant.details.error);
        }).finally(async()=>{
          await run.inputChain.catch(()=>{});
          clearInterval(watchdog);clearInterval(subagentTimer);
          if(polling)await polling;
          await pollSubagents();watching=false;
          run.ended=true;clearTimeout(pushTimer);clearTimeout(saveTimer);assistant.details.liveRevision++;
          // Calls this turn handed out and never collected would keep working for nobody.
          try{contextTools?.close();}catch{}
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
          // An ephemeral session is gone once its process ends; a later turn starts afresh.
          if(assistant.status==='complete'&&nativeId&&!unsavedSession){
            if(run.cursor){const input=this.store.messageById(chatId,run.cursor);if(input){input.details.context=assistant.details.context;input.details.sessionId=nativeId;this.store.saveMessage(input);}}
            this.store.saveSession(chatId,chat.provider,nativeId,run.cursor||assistant.id,fingerprint);
          }
          this.store.saveMessage(assistant);this.active.delete(chatId);
          await run.contextBridge?.close();
          if(assistant.status!=='complete')this.store.queue.hold(chatId,'当前任务已停止或失败，请确认后继续发送。');
          // Send the saved, settled state directly. Completion must not wait for
          // provider discovery, full history recovery or an optional refresh hint.
          // The reply goes with its settled process log, which the page already shows.
          const settled=this.live(chatId);if(settled.message?.id===assistant.id)settled.message=assistant;
          this.broadcast('message',settled);this.broadcast('refresh',{chatId});
          // Tell the user once the chat is done: not for workflow desks, the conversation
          // model's part of an @-message (its run card tells once everyone is done), a stop
          // they pressed themselves, or a reply the queue is about to continue.
          const continues=assistant.status==='complete'&&this.store.queue.list(chatId)[0]?.state==='queued';
          if(!metadata.desk&&!metadata.dispatchStep&&!this.closing&&!continues&&['complete','error'].includes(assistant.status))
            try{this.onFinished?.({chatId,status:assistant.status,text:assistant.status==='error'?assistant.details.error:assistant.content});}catch{}
          if(assistant.status==='complete'&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});
        });
      const result={id:run.id,user,assistant};Object.defineProperty(result,'done',{value:run.done});
      return result;
    } catch(error) {await run.contextBridge?.close();this.active.delete(chatId);this.broadcast('message',this.packet(chatId));throw error;}
  }
  async messages(chatId){
    const messages=this.store.messages(chatId,{trace:streaming});
    for(let index=0;index<messages.length;index++){
      const message=messages[index];
      if(this.activityHistory&&!this.active.has(chatId)&&['codex','claude'].includes(message.provider)&&message.role==='assistant'&&message.details.sessionId&&!message.details.activity?.length){
        try{
          const source=await this.activityHistory.read(message.provider,message.details.sessionId),activity=recoverActivity(message,source);
          // Saved with its tool list in full, not the outline it was read with.
          if(activity){this.store.attachTrace(message);message.details.activity=activity;message.details.activityRecovered=true;this.store.saveMessage(message);}
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
  async stop(chatId){this.store.queue.hold(chatId,'当前任务已停止，请确认后继续发送。');const run=this.active.get(chatId);if(!run){this.broadcast('message',this.packet(chatId));return;}run.controller.abort();if(run.control?.stop)await run.control.stop();}
  enqueue(chatId,data){
    const run=this.active.get(chatId);if(run&&data.runId!==run.id)throw Object.assign(new Error('当前任务已改变，请重新发送'),{status:409});
    const row=this.store.queue.add(chatId,{...data,attachments:this.checkAttachments(data.attachments).map(row=>this.attachments.metadata(row))});this.broadcast('message',this.packet(chatId));
    if(!run&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return {queued:row,...row.message?{user:row.message}:{},...this.store.queue.snapshot(chatId)};
  }
  editQueued(chatId,id,data){this.store.queue.edit(chatId,id,data.revision,data.text);this.broadcast('message',this.packet(chatId));if(!this.active.has(chatId)&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return this.store.queue.snapshot(chatId);}
  beginQueuedEdit(chatId,id,data){this.store.queue.beginEdit(chatId,id,data.revision);this.broadcast('message',this.packet(chatId));return this.store.queue.snapshot(chatId);}
  cancelQueuedEdit(chatId,id,data){this.store.queue.cancelEdit(chatId,id,data.revision);this.broadcast('message',this.packet(chatId));if(!this.active.has(chatId)&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return this.store.queue.snapshot(chatId);}
  deleteQueued(chatId,id,data){this.store.queue.remove(chatId,id,data.revision);this.broadcast('message',this.packet(chatId));if(!this.active.has(chatId)&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});return this.store.queue.snapshot(chatId);}
  async dispatchQueue(chatId,id=null,revision=null){
    if(this.closing||this.active.has(chatId)){if(id)throw Object.assign(new Error('请等待当前任务结束，或选择引导'),{status:409});return;}
    const queued=id?this.store.queue.editable(chatId,id,revision):this.store.queue.list(chatId)[0];if(!queued||!id&&queued.state!=='queued')return;
    if(queued.state==='editing')throw Object.assign(new Error('请先保存或取消修改'),{status:409});
    const chat=this.store.chat(chatId);if(chat?.provider!==queued.provider){this.store.queue.hold(chatId,'工具已改变，请切回原工具后继续发送。');this.broadcast('message',this.packet(chatId));return;}
    const row=this.store.queue.change(queued,'dispatching',{...queued.details,error:undefined});this.broadcast('message',this.packet(chatId));
    try{return await this.start(chatId,row.content,attachmentIds(row),{queued:row,replyTo:row.details.replyTo});}
    catch(error){const remaining=this.store.queue.get(chatId,row.id);if(remaining)this.store.queue.change(remaining,'held',{...remaining.details,error:redact(error.message)});this.store.queue.hold(chatId,'未发送成功，请确认后继续发送。');this.broadcast('message',this.packet(chatId));throw error;}
  }
  async steerQueued(chatId,id,{revision,runId}={}){
    const run=this.active.get(chatId);if(!run||run.id!==runId||run.control?.inputMode!=='steer'||!this.state(chatId).inputReady)throw Object.assign(new Error('当前任务暂不支持引导，消息仍在队列中'),{status:409});
    const queued=this.store.queue.editable(chatId,id,revision);if(queued.provider!==run.provider)throw new Error('请切回这条消息的原工具');
    if(queued.state==='editing')throw Object.assign(new Error('请先保存或取消修改'),{status:409});
    const row=this.store.queue.change(queued,'steering');this.broadcast('message',this.packet(chatId));
    try{
      const result=await this.guidance(chatId,{text:row.content,runId,clientId:row.id+'-'+revision,replyTo:row.details.replyTo,attachments:attachmentIds(row)});
      if(['not-delivered','unconfirmed'].includes(result.delivery))throw new Error(result.user?.details?.error||'未确认送达');
      result.user.details.queuedMessage={id:row.id,clientId:row.client_id,inputHash:row.details.inputHash};
      result.user.details.liveRevision=(result.user.details.liveRevision||0)+1;this.store.saveMessage(result.user);
      this.store.queue.erase(row);this.broadcast('message',this.packet(chatId));
      // If the native turn finished during steering, continue the next waiting item.
      if(!this.active.has(chatId)&&this.store.lastAssistant(chatId)?.status==='complete'&&!this.closing)this.dispatchQueue(chatId).catch(()=>{});
      return {user:result.user,...this.store.queue.snapshot(chatId)};
    }catch(error){const remaining=this.store.queue.get(chatId,id);if(remaining)this.store.queue.change(remaining,'held',{...remaining.details,error:redact(error.message)});this.broadcast('message',this.packet(chatId));throw error;}
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
    this.store.saveMessage(message);const snapshot=this.live(chatId);this.broadcast('message',this.packet(chatId));return snapshot;
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

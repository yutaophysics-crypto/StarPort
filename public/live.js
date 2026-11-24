'use strict';
globalThis.StarportLive=(()=>{
  const terminal=message=>message&&['complete','error','interrupted'].includes(message.status);
  function orderedMessages(messages){
    const replies=new Map(),moved=new Set();
    for(const message of messages)if(message.role==='user'){
      const id=message.details?.guidance?.runId||message.details?.nativeQuestionReply?.runId;if(!id)continue;
      if(!replies.has(id))replies.set(id,[]);replies.get(id).push(message);
    }
    for(const message of messages)if(message.role==='assistant'&&terminal(message))for(const reply of replies.get(message.details?.runId)||[])moved.add(reply.id);
    return messages.flatMap(message=>moved.has(message.id)?[]:message.role==='assistant'&&terminal(message)?[...(replies.get(message.details?.runId)||[]),message]:[message]);
  }
  function preferMessage(current,incoming){
    if(!current||current.id!==incoming?.id)return incoming;
    if(terminal(current)&&!terminal(incoming))return current;
    if((current.details?.liveRevision||0)>(incoming.details?.liveRevision||0))return current;
    // The same reply sent again without its process log keeps the log this page already read.
    if(incoming.deferredTrace&&!current.deferredTrace&&(current.details?.liveRevision||0)===(incoming.details?.liveRevision||0)){
      incoming.details.activity=current.details?.activity||[];if(current.details?.tools)incoming.details.tools=current.details.tools;
      delete incoming.deferredTrace;
    }
    return incoming;
  }
  // A push about a running reply carries what changed since the push before (src/live-patch.mjs).
  // Rows it does not name stay the same objects, so the page redraws only the rows that changed.
  // Returns the updated reply, the same one when it is already newer, or null when this copy is
  // older than the push's starting point and the reply has to be read again.
  function applyPatch(message,patch){
    const revision=message?.details?.liveRevision;
    if(!message||!patch||message.id!==patch.id||message.deferredTrace||!Number.isFinite(revision)||revision<patch.base)return null;
    if(revision>=patch.revision)return message;
    const content=message.content||'';
    if(patch.content&&patch.content.at>content.length)return null;
    const details={...message.details,...patch.details};
    for(const key of patch.unset||[])delete details[key];
    for(const [name,list] of Object.entries(patch.lists||{})){
      const before=message.details[name]||[];let rows;
      if(list.ids){
        const byId=new Map(before.map(row=>[row.id,row]));for(const row of list.rows)byId.set(row.id,row);
        rows=list.ids.map(id=>byId.get(id));if(rows.some(row=>!row))return null;
      }else{
        const at=new Map(before.map((row,index)=>[row.id,index]));rows=before.slice();
        for(const row of list.rows){const index=at.get(row.id);if(index===undefined){at.set(row.id,rows.length);rows.push(row);}else rows[index]=row;}
      }
      if(rows.length!==list.n)return null;
      details[name]=rows;
    }
    return {...message,...patch.fields,content:patch.content?content.slice(0,patch.content.at)+patch.content.text:content,details};
  }
  function mergeChatStatus(current,incoming){
    if(!current)return incoming;
    const next={...current,...incoming};
    const older=(incoming.last_assistant_sequence??0)<(current.last_assistant_sequence??0);
    const regressed=incoming.last_assistant_id===current.last_assistant_id&&current.last_assistant_status==='complete'&&incoming.last_assistant_status==='running';
    if(older||regressed)for(const key of ['last_assistant_id','last_assistant_sequence','last_assistant_status'])next[key]=current[key];
    if((incoming.read_revision??0)<(current.read_revision??0))for(const key of ['read_message_id','read_revision'])next[key]=current[key];
    if(next.last_assistant_id!==undefined)next.unread=next.last_assistant_status==='complete'&&next.last_assistant_id!==next.read_message_id;
    return next;
  }
  function applyUpdate(state,data){
    const sidebarRuns=()=>JSON.stringify([state.active||[],state.asking||[],state.awaitingApproval||[]]);
    const previousActive=sidebarRuns(),previousRun=state.run?.id;let currentChanged=false,chatChanged=false,sidebarChanged=false,providersChanged=false;
    for(const provider of state.providers||[]){
      const incoming=data.providerVerifications?.[provider.id];
      if(!incoming)continue;
      const incomingDate=Date.parse(incoming.date)||0,currentDate=Date.parse(provider.verification?.date)||0;
      if(incomingDate<currentDate||incomingDate===currentDate&&(incoming.revision||0)<(provider.verification?.revision||0))continue;
      if(JSON.stringify(provider.verification)!==JSON.stringify(incoming)){provider.verification=incoming;providersChanged=true;}
    }
    if(data.chatId===state.chat?.id&&Array.isArray(data.queue)&&Number.isSafeInteger(data.queueVersion)&&data.queueVersion>=(state.queueVersion??-1)){
      currentChanged=JSON.stringify(state.queue)!==JSON.stringify(data.queue);state.queue=data.queue;state.queueVersion=data.queueVersion;
    }
    for(const message of [...data.inputs||[],...data.followed||[]])currentChanged=applyUpdate(state,{chatId:data.chatId,message}).currentChanged||currentChanged;
    const current=data.chatId===state.chat?.id;
    // A push this page cannot apply leaves its copy as it is until the reply is read again.
    let patched=false,resync=false;
    if(current&&data.patch){
      const at=state.messages.findIndex(row=>row.id===data.patch.id),next=at<0?null:applyPatch(state.messages[at],data.patch);
      if(!next)resync=true;
      patched=!!next&&next!==state.messages[at];
      data={...data,message:patched?next:undefined};
    }
    const index=current&&data.message?state.messages.findIndex(row=>row.id===data.message.id):-1;
    const selected=index<0?data.message:preferMessage(state.messages[index],data.message);
    // A late packet from a finished run cannot restore its old running state.
    if(current&&data.message&&selected!==data.message)return {currentChanged,chatChanged:false,activeChanged:false,providersChanged,resync};
    // Run cards are not the runner's replies: one added below a running reply (a companion called
    // mid-turn) must not make that reply's own packets look stale.
    const latestIndex=current?state.messages.findLastIndex(row=>row.role==='assistant'&&!row.details?.workflowRun):-1;
    const older=current&&(data.runId&&state.run&&data.runId!==state.run.id&&!data.run||data.message&&(index>=0&&index<latestIndex||index<0&&latestIndex>=0&&Date.parse(data.message.created)<Date.parse(state.messages[latestIndex].created)));
    if(current&&data.message){
      if(index>=0){currentChanged=patched||JSON.stringify(state.messages[index])!==JSON.stringify(selected)||currentChanged;state.messages[index]=selected;}
      else if(!older){state.messages.push(selected);currentChanged=true;}
    }
    if(older)return {currentChanged,chatChanged:false,activeChanged:false,providersChanged,resync};
    const previousChat=state.chats?.find(chat=>chat.id===data.chat?.id);
    if(previousChat&&data.chat&&((data.chat.last_assistant_sequence??0)<(previousChat.last_assistant_sequence??0)||data.chat.last_assistant_id===previousChat.last_assistant_id&&previousChat.last_assistant_status==='complete'&&data.chat.last_assistant_status==='running'))return {currentChanged,chatChanged:false,activeChanged:false,providersChanged,resync};
    for(const incoming of [...data.chatStatuses||[],...data.chat?[data.chat]:[]]){
      const index=state.chats?.findIndex(chat=>chat.id===incoming.id)??-1;
      if(index>=0){const merged=mergeChatStatus(state.chats[index],incoming);sidebarChanged=JSON.stringify(merged)!==JSON.stringify(state.chats[index])||sidebarChanged;state.chats[index]=merged;}
      if(incoming.id===state.chat?.id){const merged=mergeChatStatus(state.chat,incoming);chatChanged=JSON.stringify(merged)!==JSON.stringify(state.chat)||chatChanged;state.chat=merged;}
    }
    if(Array.isArray(data.active))state.active=[...data.active];
    else if(data.chatId&&Object.hasOwn(data,'run')){const active=new Set(state.active||[]);data.run?active.add(data.chatId):active.delete(data.chatId);state.active=[...active];}
    for(const [key,question] of [['asking',true],['awaitingApproval',false]]){
      if(Array.isArray(data[key]))state[key]=[...data[key]];
      else if(data.chatId&&Object.hasOwn(data,'run')){
        const waiting=new Set(state[key]||[]);
        if(data.run?.approvals?.some(request=>(request.kind==='question')===question))waiting.add(data.chatId);
        else waiting.delete(data.chatId);
        state[key]=[...waiting];
      }
    }
    if(current){
      if(Object.hasOwn(data,'run')){currentChanged=JSON.stringify(state.run)!==JSON.stringify(data.run)||currentChanged;state.run=data.run;}
      if(Object.hasOwn(data,'context')){currentChanged=JSON.stringify(state.context)!==JSON.stringify(data.context)||currentChanged;state.context=data.context;}
    }
    return {currentChanged,chatChanged,sidebarChanged,providersChanged,resync,runChanged:previousRun!==state.run?.id,activeChanged:previousActive!==sidebarRuns()};
  }
  function create({state,api,viewRevision,onChange,onConnection,onRefresh,onError=()=>{},events=new EventSource('/api/events'),document:doc=globalThis.document,window:win=globalThis.window,interval=5000,setInterval:setTimer=globalThis.setInterval,clearInterval:clearTimer=globalThis.clearInterval}){
    // whole: a push could not be applied, so the next read asks for the whole running reply.
    let revision=0,pending=null,needsSync=true,closed=false,whole=false;
    const running=()=>(state.messages||[]).filter(message=>message.role==='assistant'&&message.status==='running');
    const receive=data=>{
      if(closed)return;const change=applyUpdate(state,data);
      if(change.currentChanged||change.chatChanged||change.sidebarChanged||change.activeChanged||change.providersChanged)revision++;
      onChange?.({...change,terminal:change.currentChanged&&!state.run});
      if(change.resync){needsSync=true;whole=true;Promise.resolve().then(reconcile);}
    };
    async function reconcile(){
      if(closed)return;if(pending)return pending;
      const chatId=state.chat?.id||null,view=viewRevision(),version=revision;
      // Every reply still shown as running is read back, not only the latest: a run card above the
      // main model's answer would otherwise stay "working" after a dropped stream until F5.
      const follow=chatId?running().map(message=>message.id).slice(-20):[];
      // The running reply this page holds is sent back only as what changed since.
      const held=chatId?running().filter(message=>!message.details?.workflowRun&&!message.deferredTrace&&Number.isFinite(message.details?.liveRevision)).at(-1):null;
      const have=held&&!whole?'&have='+encodeURIComponent(held.id+':'+held.details.liveRevision):'';
      pending=(async()=>{
        try{
          const data=await api('/live'+(chatId?'?chatId='+encodeURIComponent(chatId)+(follow.length?'&follow='+follow.map(encodeURIComponent).join(','):'')+have:''));
          if(closed)return;
          if(view!==viewRevision()||chatId!==(state.chat?.id||null)){needsSync=true;return;}
          if(data.message)whole=false;
          // Pushes arrived meanwhile, so the rest may be older than what they said. The reply itself
          // is still taken when newer than this page's copy, which pushes alone cannot bring up to date.
          if(version!==revision){needsSync=true;if(data.message&&chatId)receive({chatId,message:data.message});return;}
          receive(data);needsSync=false;
        }catch(error){needsSync=true;onError(error);}
        finally{pending=null;}
      })();return pending;
    }
    events.onopen=()=>{onConnection?.(true);needsSync=true;reconcile();globalThis.StarportWorkflows?.receive({reason:'reconnect'});};
    events.onerror=()=>{onConnection?.(false);needsSync=true;};
    // Packets about other chats include companions' desks, whose turns show in run cards.
    events.addEventListener('message',event=>{
      let data;try{data=JSON.parse(event.data);receive(data);}catch(error){needsSync=true;onError(error);return;}
      if((data?.message||data?.patch)&&data.chatId&&data.chatId!==state.chat?.id)try{globalThis.StarportWorkflows?.deskMessage?.(data.chatId,data.message,data.patch);}catch{}
    });
    events.addEventListener('refresh',event=>{let data={};try{data=JSON.parse(event.data||'{}')||{};}catch{}onRefresh?.(data);});
    events.addEventListener('workflows',event=>{try{globalThis.StarportWorkflows?.receive(JSON.parse(event.data));}catch(error){onError(error);}});
    events.addEventListener('memory-sync',event=>{try{globalThis.StarportMemorySync?.receive(JSON.parse(event.data));}catch(error){onError(error);}});
    const resume=()=>{if(!doc?.hidden)reconcile();};
    doc?.addEventListener('visibilitychange',resume);win?.addEventListener('pageshow',resume);win?.addEventListener('focus',resume);
    const timer=setTimer(()=>{if(!doc?.hidden&&(needsSync||state.run||state.queue?.length||state.active?.length||state.messages?.at(-1)?.status==='running'||running().length))reconcile();},interval);
    return {receive,reconcile,get revision(){return revision;},close(){closed=true;clearTimer(timer);events.close();doc?.removeEventListener('visibilitychange',resume);win?.removeEventListener('pageshow',resume);win?.removeEventListener('focus',resume);}};
  }
  return {create,applyUpdate,applyPatch,preferMessage,orderedMessages,mergeChatStatus};
})();

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
    return incoming;
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
    const previousActive=JSON.stringify(state.active||[]),previousRun=state.run?.id;let currentChanged=false,chatChanged=false,sidebarChanged=false,providersChanged=false;
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
    for(const message of data.inputs||[])currentChanged=applyUpdate(state,{chatId:data.chatId,message}).currentChanged||currentChanged;
    const current=data.chatId===state.chat?.id;
    const index=current&&data.message?state.messages.findIndex(row=>row.id===data.message.id):-1;
    const selected=index<0?data.message:preferMessage(state.messages[index],data.message);
    // A late packet from a finished run cannot restore its old running state.
    if(current&&data.message&&selected!==data.message)return {currentChanged,chatChanged:false,activeChanged:false,providersChanged};
    const latestIndex=current?state.messages.findLastIndex(row=>row.role==='assistant'):-1;
    const older=current&&(data.runId&&state.run&&data.runId!==state.run.id&&!data.run||data.message&&(index>=0&&index<latestIndex||index<0&&latestIndex>=0&&Date.parse(data.message.created)<Date.parse(state.messages[latestIndex].created)));
    if(current&&data.message){
      if(index>=0){currentChanged=JSON.stringify(state.messages[index])!==JSON.stringify(selected)||currentChanged;state.messages[index]=selected;}
      else if(!older){state.messages.push(selected);currentChanged=true;}
    }
    if(older)return {currentChanged,chatChanged:false,activeChanged:false,providersChanged};
    const previousChat=state.chats?.find(chat=>chat.id===data.chat?.id);
    if(previousChat&&data.chat&&((data.chat.last_assistant_sequence??0)<(previousChat.last_assistant_sequence??0)||data.chat.last_assistant_id===previousChat.last_assistant_id&&previousChat.last_assistant_status==='complete'&&data.chat.last_assistant_status==='running'))return {currentChanged,chatChanged:false,activeChanged:false,providersChanged};
    for(const incoming of [...data.chatStatuses||[],...data.chat?[data.chat]:[]]){
      const index=state.chats?.findIndex(chat=>chat.id===incoming.id)??-1;
      if(index>=0){const merged=mergeChatStatus(state.chats[index],incoming);sidebarChanged=JSON.stringify(merged)!==JSON.stringify(state.chats[index])||sidebarChanged;state.chats[index]=merged;}
      if(incoming.id===state.chat?.id){const merged=mergeChatStatus(state.chat,incoming);chatChanged=JSON.stringify(merged)!==JSON.stringify(state.chat)||chatChanged;state.chat=merged;}
    }
    if(Array.isArray(data.active))state.active=[...data.active];
    else if(data.chatId&&Object.hasOwn(data,'run')){const active=new Set(state.active||[]);data.run?active.add(data.chatId):active.delete(data.chatId);state.active=[...active];}
    if(current){
      if(Object.hasOwn(data,'run')){currentChanged=JSON.stringify(state.run)!==JSON.stringify(data.run)||currentChanged;state.run=data.run;}
      if(Object.hasOwn(data,'context')){currentChanged=JSON.stringify(state.context)!==JSON.stringify(data.context)||currentChanged;state.context=data.context;}
    }
    return {currentChanged,chatChanged,sidebarChanged,providersChanged,runChanged:previousRun!==state.run?.id,activeChanged:previousActive!==JSON.stringify(state.active||[])};
  }
  function create({state,api,viewRevision,onChange,onConnection,onRefresh,onError=()=>{},events=new EventSource('/api/events'),document:doc=globalThis.document,window:win=globalThis.window,interval=5000,setInterval:setTimer=globalThis.setInterval,clearInterval:clearTimer=globalThis.clearInterval}){
    let revision=0,pending=null,needsSync=true,closed=false;
    const receive=data=>{if(closed)return;const change=applyUpdate(state,data);if(change.currentChanged||change.chatChanged||change.sidebarChanged||change.activeChanged||change.providersChanged)revision++;onChange?.({...change,terminal:change.currentChanged&&!state.run});};
    async function reconcile(){
      if(closed)return;if(pending)return pending;
      const chatId=state.chat?.id||null,view=viewRevision(),version=revision;
      pending=(async()=>{
        try{
          const data=await api('/live'+(chatId?'?chatId='+encodeURIComponent(chatId):''));
          if(closed)return;
          if(view!==viewRevision()||chatId!==(state.chat?.id||null)||version!==revision){needsSync=true;return;}
          receive(data);needsSync=false;
        }catch(error){needsSync=true;onError(error);}
        finally{pending=null;}
      })();return pending;
    }
    events.onopen=()=>{onConnection?.(true);needsSync=true;reconcile();globalThis.StarportWorkflows?.receive({reason:'reconnect'});};
    events.onerror=()=>{onConnection?.(false);needsSync=true;};
    events.addEventListener('message',event=>{try{receive(JSON.parse(event.data));}catch(error){needsSync=true;onError(error);}});
    events.addEventListener('refresh',()=>onRefresh?.());
    events.addEventListener('workflows',event=>{try{globalThis.StarportWorkflows?.receive(JSON.parse(event.data));}catch(error){onError(error);}});
    events.addEventListener('memory-sync',event=>{try{globalThis.StarportMemorySync?.receive(JSON.parse(event.data));}catch(error){onError(error);}});
    const resume=()=>{if(!doc?.hidden)reconcile();};
    doc?.addEventListener('visibilitychange',resume);win?.addEventListener('pageshow',resume);win?.addEventListener('focus',resume);
    const timer=setTimer(()=>{if(!doc?.hidden&&(needsSync||state.run||state.queue?.length||state.active?.length||state.messages?.at(-1)?.status==='running'))reconcile();},interval);
    return {receive,reconcile,get revision(){return revision;},close(){closed=true;clearTimer(timer);events.close();doc?.removeEventListener('visibilitychange',resume);win?.removeEventListener('pageshow',resume);win?.removeEventListener('focus',resume);}};
  }
  return {create,applyUpdate,preferMessage,orderedMessages,mergeChatStatus};
})();

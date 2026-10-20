'use strict';
globalThis.StarportQueue=(()=>{
  const drafts=new Map(),busy=new Set();let previous='';
  function render(root,{state,el,t,language,action,onError}){
    if(!root)return;
    const rows=state.queue||[],chatId=state.chat?.id,key=JSON.stringify([chatId,language,rows,state.run?.id,state.run?.inputMode,state.run?.inputReady,[...busy],[...drafts.keys()]]);
    if(previous===key)return;previous=key;
    const focused=root.contains(document.activeElement)&&document.activeElement.matches('.queue-editor')?{id:document.activeElement.closest('.queue-item').dataset.queueId,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd,direction:document.activeElement.selectionDirection}:null;
    root.hidden=!rows.length||!chatId;root.replaceChildren();if(root.hidden)return;
    root.append(el('div',{class:'queue-heading',text:t('等待队列 · {count}',{count:rows.length})}));
    const draw=()=>{previous='';render(root,{state,el,t,language,action,onError});};
    for(const row of rows){
      const id=chatId+':'+row.id,inFlight=!['queued','held','editing'].includes(row.state),locked=inFlight||busy.has(id),draft=drafts.get(id);
      if(draft&&row.state==='held'&&row.content===draft.original)draft.revision=row.revision;
      const item=el('div',{class:'queue-item','data-queue-id':row.id}),status=el('small',{class:'queue-status',text:t(row.state==='held'?'等待你继续':row.state==='editing'?'正在修改，保存前不会发送':inFlight?'正在发送…':'当前任务完成后发送')});
      const buttons=el('div',{class:'queue-actions'}),attachments=row.details?.attachments?.length&&globalThis.StarportComposer?.attachmentList(row.details.attachments);
      async function perform(type,text){
        if(locked||busy.has(id))return;busy.add(id);draw();
        try{await action(type,{...row,revision:draft?.revision??row.revision},text);drafts.delete(id);}
        catch(error){onError(error);}
        finally{busy.delete(id);draw();}
      }
      const button=(text,handler,disabled=locked)=>{const node=el('button',{type:'button',class:'queue-action',text:t(text),disabled});node.onclick=handler;buttons.append(node);return node;};
      if(draft){
        const input=el('textarea',{class:'queue-editor',rows:3,maxlength:100000,'aria-label':t('修改排队消息')});input.value=draft.text;input.disabled=locked;input.oninput=()=>{draft.text=input.value;};
        item.append(input);if(attachments)item.append(attachments);button('保存',()=>perform('edit',draft.text));button('取消',()=>perform('cancel-edit'));
      }else{
        item.append(el('div',{class:'queue-content',text:row.content}));if(attachments)item.append(attachments);
        button('修改',async()=>{
          busy.add(id);draw();try{const result=await action('begin-edit',row),updated=result.queue.find(item=>item.id===row.id);if(updated)drafts.set(id,{text:updated.content,original:updated.content,revision:updated.revision});}
          catch(error){onError(error);}finally{busy.delete(id);draw();[...root.querySelectorAll('.queue-item')].find(item=>item.dataset.queueId===row.id)?.querySelector('textarea')?.focus();}
        });
        if(state.run?.inputMode==='steer'){
          const steer=button('引导',()=>perform('steer'),locked||!state.run.inputReady);steer.title=t(state.run.provider==='claude'?'在执行间隙加入当前任务，不停止当前操作':'立即加入当前任务');
        }else if(!state.run)button('发送',()=>perform('send'));
        button('删除',()=>perform('delete'));
      }
      item.append(el('div',{class:'queue-footer'},[status,buttons]));
      if(row.details?.error)item.append(el('p',{class:'queue-error',text:row.details.error}));root.append(item);
    }
    if(focused){const input=[...root.querySelectorAll('.queue-item')].find(item=>item.dataset.queueId===focused.id)?.querySelector('textarea');if(input&&!input.disabled){input.focus({preventScroll:true});input.setSelectionRange(focused.start,focused.end,focused.direction);}}
    if(drafts.size>64)drafts.delete(drafts.keys().next().value);
  }
  return {render};
})();

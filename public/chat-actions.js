'use strict';
globalThis.StarportChatActions=(()=>{
  const menu=el('div',{id:'chat-actions-menu',class:'chat-actions-menu',role:'menu',hidden:''});
  const dialog=el('dialog',{id:'chat-action-dialog',class:'chat-action-dialog','aria-labelledby':'chat-action-title'});
  document.body.append(menu,dialog);
  // anchor gets focus back; the chat's ⋯ button (expander) stays highlighted while its menu is open.
  // A right-click opens the menu at the pointer instead of under the anchor.
  let anchor=null,expander=null,point=null,source=null,sourceId=null,saving=false;
  const trigger=id=>[...document.querySelectorAll('.chat-more')].find(node=>node.dataset.chatId===id);
  const running=id=>state.active?.includes(id)||(state.chat?.id===id&&!!state.run);
  function locate(){
    if(source.kind==='group')return [...document.querySelectorAll('.group-heading')].find(node=>node.dataset.groupId===(source.id||''))?.querySelector('.group-toggle');
    const more=trigger(source.id);return source.via==='more'?more:more?.parentElement.querySelector('.chat-link');
  }
  function closeMenu(focus=false){
    menu.hidden=true;expander?.setAttribute('aria-expanded','false');
    if(focus)anchor?.focus();anchor=expander=point=null;
  }
  function position(){
    const rect=anchor.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
    menu.style.left=Math.max(8,Math.min(point?point.x:rect.right-width,innerWidth-width-8))+'px';
    menu.style.top=Math.max(8,Math.min(point?point.y:rect.bottom+5,innerHeight-height-8))+'px';
  }
  function sync(){
    if(menu.hidden||!anchor)return;
    const next=locate();if(!next){closeMenu();return;}
    anchor=next;
    if(source.kind==='chat'){
      expander=trigger(source.id);expander.setAttribute('aria-expanded','true');
      const busy=!!running(source.id);
      for(const button of menu.querySelectorAll('[data-idle]'))button.disabled=busy;
      menu.querySelector('.chat-menu-hint').hidden=!busy;
    }
    position();
  }
  function pointFrom(event,node){
    if(!event)return null;
    if(event.clientX||event.clientY)return {x:event.clientX,y:event.clientY};
    const rect=node.getBoundingClientRect();return {x:rect.left+12,y:rect.bottom};
  }
  function item(label,action,{idle=false,busy=false,className=''}={}){
    const button=el('button',{type:'button',role:'menuitem',text:t(label),...className?{class:className}:{}});
    if(idle){button.dataset.idle='';button.disabled=busy;}
    button.onclick=()=>{closeMenu(true);action();};
    return button;
  }
  const separator=()=>el('div',{class:'chat-menu-separator',role:'separator'});
  function display(){menu.hidden=false;position();menu.querySelector('button:not(:disabled)')?.focus();}
  function open(id,button,event){
    // The ⋯ button toggles; a repeated right-click reopens at the new pointer position.
    if(!event&&anchor===button&&!menu.hidden){closeMenu(true);return;}
    closeMenu();const chat=state.chats.find(c=>c.id===id);if(!chat)return;
    source={kind:'chat',id,via:button.classList.contains('chat-more')?'more':'row'};sourceId=id;
    anchor=button;point=pointFrom(event,button);expander=trigger(id);expander?.setAttribute('aria-expanded','true');
    const busy=!!running(id);
    const hint=el('p',{class:'chat-menu-hint',text:t('任务运行中：停止后才能重命名、更改工作目录或删除')});hint.hidden=!busy;
    menu.replaceChildren(...[
      state.chat?.id!==id?item('打开',()=>openChat(id).catch(e=>toast(e.message))):null,
      item('重命名…',()=>showRename(chat),{idle:true,busy}),
      item('移动到分组…',()=>showMove(chat)),
      item('导出对话',()=>globalThis.StarportTransfer.openExport(chat)),
      item('更改工作目录…',()=>changeWorkspace(chat),{idle:true,busy}),
      separator(),
      item('在资源管理器中打开工作目录',()=>api('/folders/open','POST',{path:chat.workspace}).catch(e=>toast(e.message))),
      item('复制工作目录路径',()=>navigator.clipboard.writeText(chat.workspace).then(()=>toast('已复制')).catch(()=>toast(chat.workspace))),
      separator(),
      item('删除对话',()=>showDelete(chat),{idle:true,busy,className:'delete-action'}),
      hint
    ].filter(Boolean));
    display();
  }
  function openGroup(group,button,event){
    closeMenu();
    source={kind:'group',id:group.id};anchor=button;point=pointFrom(event,button);
    menu.replaceChildren(
      item('在此房间新建对话',()=>newChatIn(group.id)),
      ...group.id?[
        item('伙伴进出…',()=>globalThis.StarportAgentsRoom?.openRosterManager(group.id)),
        item('工作流库…',()=>globalThis.StarportWorkflows?.openLibrary()),
        item('工作流设置…',()=>globalThis.StarportWorkflows?.openSettings()),
        separator(),
        item('重命名房间…',()=>renameGroup(group)),
        separator(),
        item('删除房间…',()=>globalThis.StarportAgentsRoom?.openDeleteRoomModal(group),{className:'delete-action'})
      ]:[]
    );
    display();
  }
  menu.onkeydown=e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMenu(true);return;}
    if(e.key==='Tab'){closeMenu(true);return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    e.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);
    items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  };
  // Any press outside a pointer-placed menu closes it, like a native context menu.
  document.addEventListener('pointerdown',e=>{if(!menu.hidden&&!menu.contains(e.target)&&(point||!anchor?.contains(e.target)))closeMenu();});
  document.addEventListener('scroll',()=>closeMenu(),true);window.addEventListener('resize',()=>closeMenu());
  // Starport's own menus replace the browser menu in the sidebar; the search field keeps copy and paste.
  $('.sidebar').addEventListener('contextmenu',e=>{if(!e.target.closest('input,textarea')&&!String(getSelection()))e.preventDefault();});
  dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});
  dialog.addEventListener('close',()=>{(trigger(sourceId)||$('#new-chat'))?.focus();});
  function show(title,chat,content,submitText,action,danger=false){
    sourceId=chat.id;
    const close=el('button',{type:'button',class:'icon-button',text:'×','aria-label':t('关闭')});
    const cancel=el('button',{type:'button',class:'secondary-button',text:t('取消')});
    close.onclick=cancel.onclick=()=>dialog.close();
    const submit=el('button',{type:'submit',class:danger?'danger-button':'primary-button',text:t(submitText)});
    const error=el('p',{class:'error-note',role:'alert'});error.hidden=true;
    const form=el('form',{},[el('div',{class:'dialog-heading'},[el('h2',{id:'chat-action-title',text:t(title)}),close]),
      el('div',{class:'dialog-body'},[el('p',{class:'chat-action-name',text:chat.title}),...content,error]),
      el('div',{class:'dialog-footer'},[cancel,submit])]);
    form.onsubmit=async e=>{
      e.preventDefault();if(saving||submit.disabled)return;saving=true;error.hidden=true;
      const inputs=[...form.querySelectorAll('button,input,select')],disabled=inputs.map(node=>node.disabled);inputs.forEach(node=>node.disabled=true);submit.textContent=t('正在保存…');
      try{await saveChain.catch(()=>{});await action();dialog.close();}
      catch(e){error.textContent=notice(e.message);error.hidden=false;}
      finally{saving=false;inputs.forEach((node,i)=>node.disabled=disabled[i]);submit.textContent=t(submitText);}
    };
    dialog.replaceChildren(form);dialog.showModal();if(danger)cancel.focus();
    return submit;
  }
  function showRename(chat){
    const input=el('input',{id:'rename-chat',type:'text',maxlength:'300',value:chat.title});
    const submit=show('重命名对话',chat,[el('label',{for:'rename-chat',text:t('对话标题')}),input],'重命名',async()=>{
      const title=input.value.trim();if(!title)throw new Error(t('请填写对话标题'));
      await api('/chats/'+chat.id,'PATCH',{title});
      await refresh();toast('已重命名对话');
    });
    const update=()=>{submit.disabled=!input.value.trim()||input.value.trim()===chat.title;};
    input.oninput=update;update();input.focus();input.select();
  }
  function showMove(chat){
    const group=el('select',{id:'move-group'},[el('option',{value:'',text:t('未分组')}),...state.groups.map(g=>el('option',{value:g.id,text:g.name})),el('option',{value:'__new__',text:t('新建分组…')})]);
    group.value=chat.group_id||'';
    const name=el('input',{type:'text',maxlength:'120',placeholder:t('新分组名称'),'aria-label':t('新分组名称')});name.hidden=true;
    const submit=show('移动对话',chat,[el('label',{for:'move-group',text:t('所属分组')}),group,name],'移动',async()=>{
      let destination=group.value||null;
      if(destination==='__new__'){
        if(!name.value.trim())throw new Error(t('请填写新分组名称'));
        const created=await api('/groups','POST',{name:name.value.trim()});
        group.insertBefore(el('option',{value:created.id,text:created.name}),group.lastElementChild);group.value=destination=created.id;name.hidden=true;
      }
      await api('/chats/'+chat.id,'PATCH',{group_id:destination});state.collapsed.delete(destination);
      await refresh();toast('已移动对话');
    });
    const update=()=>{name.hidden=group.value!=='__new__';submit.disabled=group.value==='__new__'?!name.value.trim():group.value===(chat.group_id||'');};
    group.onchange=()=>{update();if(!name.hidden)name.focus();};name.oninput=update;update();group.focus();
  }
  function changeWorkspace(chat){
    openFolderPicker(chat.workspace,async path=>{
      if(path===chat.workspace)return;
      await saveChain.catch(()=>{});await api('/chats/'+chat.id,'PATCH',{workspace:path});
      await refresh();toast('已更改工作目录');
    });
  }
  function showDelete(chat){
    show('删除对话？',chat,[el('p',{class:'muted',text:t('只删除星港中的这段对话记录，无法直接恢复。附件、工作文件、原工具对话和备份均保留；关联文件需另行确认后删除。')})],'删除对话',async()=>{
      await api('/chats/'+chat.id,'DELETE');forgetChatDraft(chat.id);
      if(state.chat?.id===chat.id)newChat();
      await refresh();toast('已删除对话');
    },true);
  }
  return {open,openGroup,closeMenu,sync};
})();

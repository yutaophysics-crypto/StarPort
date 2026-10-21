'use strict';
globalThis.StarportSharedContext=(()=>{
  const dialog=el('dialog',{id:'shared-context-dialog',class:'memory-dialog context-dialog','aria-labelledby':'context-heading'});document.body.append(dialog);
  const drafts=new Map();let requestVersion=0,searchState={query:'',scope:'global',offset:0};
  const tr=(tag,label,attrs={})=>el(tag,{...attrs,'data-i18n':label,text:t(label)});
  function shell(title){
    const close=tr('button','关闭',{type:'button',class:'secondary-button'});close.onclick=()=>{requestVersion++;dialog.close();};delete dialog.dataset.editor;
    dialog.replaceChildren(el('div',{class:'dialog-heading'},[el('div',{},[el('p',{class:'eyebrow',text:'STARPORT / CONTEXT'}),tr('h2',title,{id:'context-heading'})]),close]));
    $('#memory-dialog').close();if(!dialog.open)dialog.showModal();return el('section',{class:'memory-editor context-content'});
  }
  function error(root,message){root.replaceChildren(el('p',{class:'memory-error',role:'alert',text:notice(message)}));}
  function mount(root){
    if(root.querySelector('.context-nav'))return;const nav=el('nav',{class:'context-nav','aria-label':t('偏好、项目与历史')});
    for(const [label,action,id]of [['个人偏好',()=>preferences(),'context-preferences'],['项目要求',()=>projects(),'context-projects'],['历史检索',()=>history(),'context-history']]){const b=tr('button',label,{type:'button',id});b.onclick=action;nav.append(b);}root.querySelector('.dialog-heading').after(nav);
  }
  function editInstructions(record,projectId=null){
    const key=projectId||'global',saved=drafts.get(key);if(saved)record=saved.record;const root=shell(projectId?'项目要求':'个人偏好');dialog.dataset.editor=key;dialog.append(root);
    root.append(tr('p',projectId?'仅用于工作目录恰好是这个文件夹的对话。':'适用于所有助手和对话；当前请求优先，具体项目要求优先于一般偏好。',{class:'memory-explainer'}));
    if(projectId)root.append(el('h3',{text:state.projects.find(p=>p.id===projectId)?.name||t('项目')}));
    if(record.pending_content!==null)root.append(tr('p','这些要求从备份恢复，保存后才会生效。',{class:'memory-update'}));
    const area=el('textarea',{id:'context-instructions',maxlength:'12000',rows:'11','aria-label':t('要求内容'),value:saved?.value??record.pending_content??record.content}),errors=el('p',{class:'memory-error',role:'alert'}),save=tr('button','保存要求',{type:'submit',class:'memory-confirm'}),back=tr('button','返回列表',{type:'button',class:'secondary-button'});
    area.oninput=()=>drafts.set(key,{record,value:area.value});back.onclick=()=>{requestVersion++;dialog.close();StarportMemory.open().catch(e=>toast(e.message));};
    const form=el('form',{},[tr('label','要求内容',{for:'context-instructions',class:'memory-field'}),area,errors,el('div',{class:'memory-actions'},[save,back])]);
    form.onsubmit=async event=>{event.preventDefault();save.disabled=true;errors.textContent='';try{record=await api(projectId?'/projects/'+projectId+'/requirements':'/context/preferences','PATCH',{content:area.value,revision:record.revision});drafts.delete(key);toast('要求已保存，下一轮生效。');if(dialog.dataset.editor===key)dialog.close();}catch(e){errors.textContent=notice(e.message);}finally{save.disabled=false;}};
    root.append(form);area.focus();
  }
  async function preferences(){
    const version=++requestVersion,root=shell('个人偏好');dialog.append(root);try{const record=await api('/context/preferences');if(version===requestVersion&&dialog.open)editInstructions(record);}catch(e){if(version===requestVersion)error(root,e.message);}
  }
  // Each exact working folder is a project, created automatically when chosen for a chat.
  async function projects(projectId=null){
    const version=++requestVersion,root=shell('项目要求');dialog.append(root);root.append(tr('p','工作文件夹就是项目。同一文件夹里的对话共用项目要求和项目记忆；子文件夹各自独立。',{class:'memory-explainer'}));
    if(projectId){try{const record=await api('/projects/'+projectId+'/requirements');if(version===requestVersion&&dialog.open)editInstructions(record,projectId);}catch(e){if(version===requestVersion)error(root,e.message);}return;}
    try{const rows=await api('/projects');if(version!==requestVersion||!dialog.open)return;state.projects=rows;
      if(!rows.length)root.append(tr('p','选择对话的工作文件夹后会自动创建项目。',{class:'memory-empty'}));
      for(const p of rows)root.append(projectRow(p));
      const add=tr('button','添加项目文件夹',{type:'button',class:'secondary-button'});
      add.onclick=()=>openFolderPicker(state.chat?.workspace||state.workspace,async path=>{const result=await api('/projects','POST',{workspace:path});if(result.warning)toast(result.warning);await projects();await refresh();},'选择项目文件夹');
      root.append(add);
    }catch(e){if(version===requestVersion)error(root,e.message);}
  }
  function projectRow(p){
    const where=!p.workspace?t('没有关联文件夹，项目记忆和要求仍保留'):p.missing?t('找不到文件夹：{path}',{path:p.workspace}):p.workspace;
    const open=el('button',{type:'button',class:'project-choice'},[el('strong',{text:p.name}),el('small',{text:where})]);
    open.onclick=async()=>{const version=++requestVersion;try{const record=await api('/projects/'+p.id+'/requirements');if(version===requestVersion&&dialog.open)editInstructions(record,p.id);}catch(e){toast(e.message);}};
    const actions=el('div',{class:'project-actions'}),row=el('div',{class:'project-row'},[open,actions]);
    const attach=()=>openFolderPicker(p.workspace||state.chat?.workspace||state.workspace,async path=>{const result=await api('/projects/'+p.id+'/attach','POST',{workspace:path});if(result.warning)toast(result.warning);await projects();await refresh();},'选择项目文件夹');
    const draw=()=>{
      actions.replaceChildren();
      if(!p.workspace||p.missing){const b=tr('button','关联文件夹',{type:'button',class:'secondary-button'});b.onclick=attach;actions.append(b);}
    };
    draw();return row;
  }
  async function openCitation(citation){
    try{const data=new URLSearchParams(String(citation).replace(/^#/,'')),id=data.get('starport-chat'),message=data.get('message');if(!id||!/^[\w-]+$/.test(id))throw Error(t('历史来源无效'));dialog.close();$('#memory-dialog').close();await openChat(id);if(message){const row=[...document.querySelectorAll('[data-message-id]')].find(node=>node.dataset.messageId===message);row?.scrollIntoView({block:'center',behavior:'smooth'});if(row){row.classList.add('history-highlight');setTimeout(()=>row.classList.remove('history-highlight'),3000);}}}catch(e){toast(e.message);}
  }
  async function history(){
    requestVersion++;const root=shell('历史检索');dialog.append(root);
    const scopes=el('select',{id:'history-scope','aria-label':t('检索范围')},[tr('option','非项目对话',{value:'global'}),tr('option','所有对话（手动检索）',{value:'all'}),...state.projects.map(p=>el('option',{value:p.id,text:p.name}))]);scopes.value=searchState.scope;
    const query=el('input',{id:'history-query',type:'search',maxlength:'200',required:'',placeholder:t('查找过去的讨论与决定'),value:searchState.query,'aria-label':t('历史关键词')}),submit=tr('button','搜索',{type:'submit',class:'memory-confirm'}),form=el('form',{class:'history-query'},[scopes,query,submit]),results=el('div',{id:'history-results','aria-live':'polite'}),preview=el('div',{id:'history-preview'});
    root.append(tr('p','助手只检索当前项目；无项目时检索非项目对话。你可以在这里手动选择全部记录。',{class:'memory-explainer'}),form,results,preview);
    async function load(offset=0){
      if(!query.value.trim())return;const version=++requestVersion;searchState={query:query.value,scope:scopes.value,offset};submit.disabled=true;
      try{const all=scopes.value==='all',projectId=['global','all'].includes(scopes.value)?null:scopes.value,data=await api('/context/history/search','POST',{query:query.value,all,projectId,offset,limit:12});if(version!==requestVersion||!dialog.open)return;
        results.replaceChildren(el('p',{class:'memory-explainer',text:t('找到 {count} 条相关消息',{count:data.total})}));preview.replaceChildren();
        for(const item of data.items){const open=el('button',{type:'button',class:'history-source-title',text:item.title});open.onclick=()=>openCitation(item.citation);const read=tr('button','读取原文',{type:'button',class:'secondary-button'});let readStart=0;
          read.onclick=async()=>{read.disabled=true;try{const current=await api('/context/history/read','POST',{chatId:item.chat_id,messageId:item.id,projectId,all,start:readStart,maxChars:12000});if(version!==requestVersion||!dialog.open)return;preview.replaceChildren(el('h3',{text:current.title}),el('pre',{class:'history-original',text:current.text}));if(current.nextStart!==null){const more=tr('button','读取下一段',{type:'button',class:'secondary-button'});more.onclick=()=>{readStart=current.nextStart;read.click();};preview.append(more);}preview.scrollIntoView({block:'nearest'});}catch(e){toast(e.message);}finally{read.disabled=false;}};
          results.append(el('article',{class:'history-result'},[open,el('p',{class:'history-meta',text:(provider(item.provider)?.name||item.provider)+' · '+new Date(item.created).toLocaleDateString(i18n.locale)}),el('p',{class:'history-snippet',text:item.snippet}),read]));}
        if(data.nextOffset!==null||offset){const prev=tr('button','上一页',{type:'button',class:'secondary-button',disabled:!offset}),next=tr('button','下一页',{type:'button',class:'secondary-button',disabled:data.nextOffset===null});prev.onclick=()=>load(Math.max(0,offset-12));next.onclick=()=>load(data.nextOffset);results.append(el('div',{class:'memory-actions'},[prev,next]));}
      }catch(e){if(version===requestVersion)error(results,e.message);}finally{submit.disabled=false;}
    }
    form.onsubmit=event=>{event.preventDefault();load();};scopes.onchange=()=>load();query.focus();if(query.value)load(searchState.offset);
  }
  function translate(){for(const node of dialog.querySelectorAll('[data-i18n]'))node.textContent=t(node.dataset.i18n);for(const node of document.querySelectorAll('.context-nav [data-i18n]'))node.textContent=t(node.dataset.i18n);document.querySelector('.context-nav')?.setAttribute('aria-label',t('偏好、项目与历史'));const area=$('#context-instructions');if(area)area.setAttribute('aria-label',t('要求内容'));const scopes=$('#history-scope');if(scopes)scopes.setAttribute('aria-label',t('检索范围'));const input=$('#history-query');if(input){input.placeholder=t('查找过去的讨论与决定');input.setAttribute('aria-label',t('历史关键词'));}}
  return {mount,preferences,projects,history,openCitation,translate};
})();

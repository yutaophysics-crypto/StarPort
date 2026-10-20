'use strict';
globalThis.StarportMemory=(()=>{
  const dialog=$('#memory-dialog'),entry=$('#shared-memory'),badge=$('#memory-badge');
  const kinds={fact:'基本信息',preference:'偏好',goal:'长期目标',value:'价值观',knowledge:'共同知识'};
  const labels={confirmed:'已确认',candidate:'候选记忆',profile:'用户画像'};
  let view='confirmed',search='',offset=0,snapshot=null,sequence=0,editor=null,searchTimer,scope='all';
  const translated=(tag,source,attrs={})=>el(tag,{...attrs,text:t(source),'data-i18n':source});
  function build(){
    dialog.replaceChildren();
    const close=el('button',{type:'button',class:'icon-button','aria-label':t('关闭'),'data-i18n-aria-label':'关闭',text:'×'});close.onclick=()=>dialog.close();
    dialog.append(el('div',{class:'dialog-heading'},[el('div',{},[el('p',{class:'eyebrow',text:'STARPORT / MEMORY'}),translated('h2','共同记忆',{id:'memory-heading'}),translated('p','换一个助手，也能继续了解你。',{class:'memory-intro'})]),close]));
    const tabs=el('div',{class:'memory-tabs',role:'tablist','aria-label':t('共同记忆')});
    for(const [key,label]of Object.entries(labels)){
      const button=el('button',{type:'button',role:'tab',id:'memory-tab-'+key,'data-memory-view':key,'aria-controls':'memory-panel',text:t(label)});
      button.onclick=()=>{view=key;offset=0;load(true).catch(error=>toast(error.message));};
      button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const keys=Object.keys(labels),index=(keys.indexOf(key)+(event.key==='ArrowLeft'?2:1))%3;tabs.querySelector('[data-memory-view='+keys[index]+']').click();tabs.querySelector('[data-memory-view='+keys[index]+']').focus();};tabs.append(button);
    }
    const input=el('input',{type:'search',id:'memory-search',placeholder:t('搜索记忆'),'aria-label':t('搜索记忆'),value:search});
    input.oninput=()=>{search=input.value;offset=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>load(true).catch(error=>toast(error.message)),200);};
    const add=translated('button','添加记忆',{type:'button',class:'secondary-button'});add.onclick=()=>edit();
    const scopeSelect=el('select',{id:'memory-scope','aria-label':t('记忆范围')},[el('option',{value:'all',text:t('全部记忆')}),el('option',{value:'global',text:t('个人与共同记忆')}),...state.projects.map(p=>el('option',{value:p.id,text:p.name}))]);scopeSelect.value=scope;
    scopeSelect.onchange=()=>{scope=scopeSelect.value;offset=0;load(true).catch(error=>toast(error.message));};
    dialog.append(tabs,el('div',{class:'memory-toolbar'},[scopeSelect,el('label',{class:'memory-search'},[el('span',{'aria-hidden':'true',text:'⌕'}),input]),add]),el('section',{id:'memory-panel',class:'memory-body',role:'tabpanel','aria-labelledby':'memory-tab-confirmed'}),el('section',{id:'memory-editor',class:'memory-editor',hidden:''}),settings());
    globalThis.StarportSharedContext?.mount(dialog);
    globalThis.StarportMemorySync?.mount(dialog);
  }
  function settings(){
    const details=el('details',{class:'memory-settings'});details.append(translated('summary','记忆设置'));
    for(const [key,label]of [['enabled','跨助手共享已确认记忆'],['capture','从新对话提出候选记忆'],['search','允许助手按需检索历史对话']]){
      const input=el('input',{type:'checkbox','data-memory-setting':key,checked:snapshot?.[key]??true});
      input.onchange=async()=>{input.disabled=true;try{await api('/memories/config','PATCH',{[key]:input.checked});await refresh();}catch(error){input.checked=!input.checked;toast(error.message);}finally{input.disabled=false;}};
      details.append(el('label',{},[input,translated('span',label)]));
    }
    details.append(translated('p','记忆保存在本机。共享时，选中的已确认内容会随请求交给当前助手；修改从下一轮生效。'),translated('p','删除记忆不会删除原对话、附件、备份或原工具的历史。'));return details;
  }
  function counts(){
    const count=snapshot?.counts?.candidate||0;badge.hidden=!count;badge.textContent=String(count);badge.title=t('{count} 条候选等待确认',{count});
    for(const button of dialog.querySelectorAll('[data-memory-view]')){const key=button.dataset.memoryView;button.textContent=t(labels[key])+' · '+(snapshot?.counts?.[key]||0);button.setAttribute('aria-selected',String(view===key));button.tabIndex=view===key?0:-1;}
    for(const input of dialog.querySelectorAll('[data-memory-setting]'))if(!input.disabled)input.checked=snapshot?.[input.dataset.memorySetting]??true;
  }
  async function load(resetScroll=false){
    const request=++sequence,params=new URLSearchParams({view,search,offset:String(offset),limit:dialog.open&&!editor?'50':'1'});if(scope!=='all'&&view!=='profile')params.set('project',scope==='global'?'':scope);
    const data=await api('/memories?'+params);if(request!==sequence)return;snapshot=data;counts();if(dialog.open&&!editor){if(data.total>0&&offset>=data.total){offset=Math.floor((data.total-1)/50)*50;return load(true);}render();if(resetScroll)$('#memory-panel').scrollTop=0;}
  }
  async function refresh(){return Promise.all([load(),globalThis.StarportMemoryReceipt?.refresh()]);}
  function row(item){
    const meta=el('div',{class:'memory-meta'},[el('span',{class:'memory-kind',text:t(kinds[item.kind])}),el('time',{text:new Date(item.updated).toLocaleDateString(i18n.locale)})]);
    const copy=el('div',{class:'memory-copy'},[el('h3',{text:item.title}),el('p',{text:item.content})]);
    copy.prepend(el('p',{class:'memory-scope-label',text:item.project_id?t('仅用于项目：{name}',{name:state.projects.find(p=>p.id===item.project_id)?.name||t('项目')}):t('个人与共同记忆')}));
    if(item.supersedes){const update=el('p',{class:'memory-update',text:t('候选更新：确认后替换原记忆')});copy.append(update);api('/memories/'+item.supersedes).then(old=>{if(update.isConnected)update.textContent=t('原记忆：{content}',{content:old.content});}).catch(()=>{update.textContent=t('原记忆已改变或删除，请重新核对这项更新');});}
    const source=el('div',{class:'memory-source'});
    const origin=item.origin==='backup'?'从备份恢复，需重新确认':item.origin==='assistant'?'助手提出，引用你的原话':'你手动保存的记忆';source.append(el('span',{text:t(origin)+(item.source_provider?' · '+(provider(item.source_provider)?.name||item.source_provider):'')}));
    if(item.source_title){source.append(document.createTextNode(' · '));if(item.source_chat){const button=el('button',{type:'button',text:item.source_title});button.onclick=()=>{dialog.close();openChat(item.source_chat).catch(error=>toast(error.message));};source.append(button);}else source.append(document.createTextNode(item.source_title+' ('+t('来源对话已删除或未随备份恢复')+')'));}
    if(item.evidence)source.append(el('blockquote',{text:item.evidence}));copy.append(source);
    const actions=el('div',{class:'memory-actions'});
    async function act(button,fn){button.disabled=true;try{await fn();await load();}catch(error){toast(error.message);}finally{button.disabled=false;}}
    if(item.status==='candidate'){const accept=el('button',{type:'button',class:'memory-confirm',text:t('确认并共享')});accept.onclick=()=>act(accept,()=>api('/memories/'+item.id,'PATCH',{revision:item.revision,confirm:true}));actions.append(accept);}
    const editButton=el('button',{type:'button',class:'secondary-button',text:t('修改')});editButton.onclick=()=>edit(item);actions.append(editButton);
    const remove=el('button',{type:'button',class:'secondary-button',text:t(item.status==='candidate'?'丢弃':'删除')});
    remove.onclick=()=>{
      if(item.status==='candidate'){act(remove,()=>api('/memories/'+item.id,'DELETE',{revision:item.revision}));return;}
      const confirm=el('button',{type:'button',class:'memory-confirm',text:t('确认删除这条记忆')});confirm.onclick=()=>act(confirm,()=>api('/memories/'+item.id,'DELETE',{revision:item.revision}));
      const cancel=el('button',{type:'button',class:'secondary-button',text:t('取消')});cancel.onclick=()=>{confirm.remove();cancel.remove();remove.hidden=false;};remove.hidden=true;actions.append(confirm,cancel);confirm.focus();
    };actions.append(remove);copy.append(actions);return el('article',{class:'memory-row','data-memory-id':item.id},[meta,copy]);
  }
  function render(){
    counts();const panel=$('#memory-panel');if(!panel||editor)return;
    panel.setAttribute('aria-labelledby','memory-tab-'+view);panel.replaceChildren();
    const explanation=view==='candidate'?'这里的内容尚未共享。核对原话，可以先修改，再确认。':view==='profile'?'只包含你确认过的基本信息、偏好、长期目标和价值观。':'四个助手共用已确认的个人记忆；项目记忆仅用于对应项目。每轮选择相关内容加入上下文。';
    panel.append(el('p',{class:'memory-explainer',text:t(explanation)}));
    const items=snapshot?.items||[];
    if(items.length)for(const item of items)panel.append(row(item));
    else panel.append(el('div',{class:'memory-empty'},[el('strong',{text:t(search?'没有找到相关记忆':view==='candidate'?'等待下一次发现':'从一条你愿意分享的记忆开始')}),el('span',{text:t(view==='candidate'?'助手在新对话中提出候选后，会显示在这里。你确认之前不会用于其他对话。':'你可以添加偏好、目标或共同知识，也可以在对话中告诉助手希望它记住什么。')})]));
    if(snapshot?.total){const total=snapshot.total,prev=el('button',{type:'button',class:'secondary-button',text:t('上一页'),disabled:offset===0}),next=el('button',{type:'button',class:'secondary-button',text:t('下一页'),disabled:offset+50>=total});prev.onclick=()=>{offset=Math.max(0,offset-50);load(true).catch(error=>toast(error.message));};next.onclick=()=>{offset+=50;load(true).catch(error=>toast(error.message));};panel.append(el('div',{class:'memory-pagination'},[el('span',{text:t('第 {start}–{end} 条，共 {total} 条',{start:offset+1,end:Math.min(offset+50,total),total})}),el('div',{},[prev,next])]));}
  }
  function finishEdit(){editor=null;$('#memory-editor').hidden=true;for(const selector of ['.memory-tabs','.memory-toolbar','#memory-panel','.memory-settings'])dialog.querySelector(selector).hidden=false;load().catch(error=>toast(error.message));}
  function edit(item=null){
    editor={item};const root=$('#memory-editor');root.hidden=false;root.replaceChildren();for(const selector of ['.memory-tabs','.memory-toolbar','#memory-panel','.memory-settings'])dialog.querySelector(selector).hidden=true;
    const form=el('form');form.append(translated('h3',item?'修改记忆':'添加记忆'));
    const kind=el('select',{name:'kind',id:'memory-edit-kind'});for(const [value,label]of Object.entries(kinds))kind.append(el('option',{value,text:t(label)}));kind.value=item?.kind||'preference';
    const title=el('input',{name:'title',id:'memory-edit-title',maxlength:'120',required:'',value:item?.title||''}),content=el('textarea',{name:'content',id:'memory-edit-content',maxlength:'2000',required:'',value:item?.content||''});
    for(const [label,input]of [['类型',kind],['标题',title],['记忆内容',content]])form.append(el('label',{class:'memory-field'},[translated('span',label),input]));
    const error=el('p',{class:'memory-error',role:'alert'}),save=translated('button',item?.status==='candidate'?'保存修改（仍待确认）':'保存并共享',{type:'submit',class:'memory-confirm'}),cancel=translated('button','返回列表',{type:'button',class:'secondary-button'});cancel.onclick=finishEdit;
    form.append(error,el('div',{class:'memory-actions'},[save,cancel]));
    const scopeInput=el('select',{id:'memory-edit-scope',name:'project_id',disabled:!!item},[el('option',{value:'',text:t('个人与共同记忆')}),...state.projects.map(p=>el('option',{value:p.id,text:p.name}))]);scopeInput.value=item?.project_id||(scope==='all'||scope==='global'?'':scope);form.insertBefore(el('label',{class:'memory-field'},[translated('span','记忆范围'),scopeInput]),form.children[1]);
    form.onsubmit=async event=>{event.preventDefault();save.disabled=true;error.textContent='';try{const data=Object.fromEntries(new FormData(form));if(item)await api('/memories/'+item.id,'PATCH',{...data,revision:item.revision});else await api('/memories','POST',{...data,project_id:data.project_id||null,confirmed:true});finishEdit();}catch(e){error.textContent=notice(e.message);}finally{save.disabled=false;}};
    root.append(form);title.focus();
  }
  async function open(next='confirmed'){
    if(!dialog.childElementCount)build();const scopeSelect=$('#memory-scope');if(scopeSelect){scopeSelect.replaceChildren(el('option',{value:'all',text:t('全部记忆')}),el('option',{value:'global',text:t('个人与共同记忆')}),...state.projects.map(p=>el('option',{value:p.id,text:p.name})));scopeSelect.value=scope;}
    view=next;offset=0;if(!dialog.open)dialog.showModal();if(!editor)await load(true);else counts();
  }
  async function showReceipt(memory,context){return globalThis.StarportMemoryReceipt.open(memory,context);}
  function translate(){
    globalThis.StarportMemoryReceipt?.translate();
    globalThis.StarportSharedContext?.translate();
    globalThis.StarportMemorySync?.translate();
    counts();for(const node of dialog.querySelectorAll('[data-i18n]'))node.textContent=t(node.dataset.i18n);
    dialog.querySelector('.memory-tabs')?.setAttribute('aria-label',t('共同记忆'));
    const searchInput=$('#memory-search');if(searchInput){searchInput.placeholder=t('搜索记忆');searchInput.setAttribute('aria-label',t('搜索记忆'));}
    const scopeInput=$('#memory-scope');if(scopeInput){scopeInput.setAttribute('aria-label',t('记忆范围'));scopeInput.options[0].text=t('全部记忆');scopeInput.options[1].text=t('个人与共同记忆');}
    if(editor){for(const option of dialog.querySelectorAll('#memory-edit-kind option'))option.textContent=t(kinds[option.value]);}else if(dialog.open)render();
  }
  entry.onclick=()=>open().catch(error=>toast(error.message));
  $('.data-actions')?.append(translated('p','记忆与候选也包含在备份中；恢复后需重新确认。',{class:'muted'}));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh().catch(()=>{});});
  refresh().catch(()=>{});
  return {open,refresh,translate,showReceipt};
})();

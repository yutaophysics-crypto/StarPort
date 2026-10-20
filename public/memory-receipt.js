'use strict';
globalThis.StarportMemoryReceipt=(()=>{
  const dialog=$('#memory-receipt-dialog');
  const kinds={fact:'基本信息',preference:'偏好',goal:'长期目标',value:'价值观',knowledge:'共同知识'};
  let selected=null,entries=new Map(),loading=false,sequence=0,view='used';
  const views=['used','candidates','browsed'];
  const ids=memory=>[...new Set([...(memory.ids||[]),...(memory.candidates||[])])];
  dialog.addEventListener('close',()=>{if(dialog.open)return;sequence++;selected=null;entries.clear();});
  function card(id,index){
    const entry=entries.get(id),item=entry?.item;
    if(!item)return el('article',{class:'memory-receipt-item memory-receipt-unavailable','data-memory-id':id},[
      el('h4',{text:t('记忆条目 {number}',{number:index+1})}),
      el('p',{text:t(entry?.missing?'此记忆已删除，原记录仍保留这条记忆的使用计数。':'暂时无法读取这条记忆，请重试。')})
    ]);
    const scope=item.project_id?t('仅用于项目：{name}',{name:state.projects.find(p=>p.id===item.project_id)?.name||t('项目')}):t('个人与共同记忆');
    const article=el('article',{class:'memory-receipt-item','data-memory-id':id},[
      el('div',{class:'memory-receipt-meta'},[el('span',{text:t(kinds[item.kind]||'共同知识')}),el('span',{text:t(item.status==='candidate'?'待确认':'已确认')})]),
      el('h4',{text:item.title}),el('p',{class:'memory-scope-label',text:scope}),el('p',{class:'memory-receipt-content',text:item.content})
    ]);
    const reading=selected.memory.reads?.findLast(row=>row.id===id);
    if(reading?.reason)article.append(el('p',{class:'memory-explainer',text:t('读取理由（模型提供）：{reason}',{reason:reading.reason})}));
    if(item.source_title||item.evidence){
      const source=el('div',{class:'memory-source'},[el('span',{text:t('来源')+' · '})]);
      if(item.source_title){
        if(item.source_chat){const link=el('button',{type:'button',text:item.source_title});link.onclick=()=>{dialog.close();openChat(item.source_chat).catch(error=>toast(error.message));};source.append(link);}
        else source.append(document.createTextNode(item.source_title+' ('+t('来源对话已删除或未随备份恢复')+')'));
      }
      if(item.evidence)source.append(el('blockquote',{text:item.evidence}));article.append(source);
    }
    return article;
  }
  function section(key,label,items,empty){
    const root=el('section',{id:'receipt-'+key+'-panel',role:'tabpanel',tabindex:'0',class:'memory-receipt-section','data-receipt-section':key,'aria-labelledby':'receipt-'+key+'-tab'});
    root.hidden=key!==view;
    root.append(el('p',{class:'memory-receipt-section-note',text:t(label)}));
    if(loading&&items.length)root.append(el('p',{class:'memory-explainer',text:t('正在读取记忆详情…')}));
    else if(items.length)items.forEach((id,index)=>{
      if(key!=='browsed'){root.append(card(id,index));return;}
      const row=selected.memory.browsed.find(item=>item.id===id);
      root.append(el('article',{class:'memory-receipt-item','data-memory-id':id},[el('h4',{text:row?.title||t('记忆条目 {number}',{number:index+1})}),el('p',{class:'memory-explainer',text:t(selected.memory.ids.includes(id)?'随后已读取正文。':'本轮只浏览过索引或摘要，没有通过记忆工具读取正文。')})]));
    });
    else root.append(el('p',{class:'memory-receipt-empty',text:t(empty)}));
    return root;
  }
  function selectView(key,focus=false){
    view=key;render();
    if(focus)dialog.querySelector('#receipt-'+key+'-tab')?.focus();
  }
  function tabs(memory){
    return el('div',{class:'memory-tabs memory-receipt-tabs',role:'tablist','aria-label':t('本轮记忆详情')},views.map((key,index)=>{
      const button=el('button',{id:'receipt-'+key+'-tab',type:'button',role:'tab','aria-selected':String(view===key),'aria-controls':'receipt-'+key+'-panel',tabindex:view===key?'0':'-1','data-receipt-tab':key},[
        el('span',{text:t(key==='used'?'共同记忆':key==='candidates'?'新候选':'检索浏览')}),
        el('span',{class:'memory-receipt-count',text:String((key==='used'?memory.ids:key==='candidates'?memory.candidates:memory.browsed||[]).length)})
      ]);
      button.onclick=()=>selectView(key);
      button.onkeydown=event=>{
        const next=event.key==='Home'?0:event.key==='End'?views.length-1:event.key==='ArrowRight'?(index+1)%views.length:event.key==='ArrowLeft'?(index+views.length-1)%views.length:null;
        if(next===null)return;event.preventDefault();selectView(views[next],true);
      };
      return button;
    }));
  }
  function render(){
    if(!selected)return;
    const previous=dialog.querySelector('.memory-body'),scroll=previous?.dataset.receiptView===view?previous.scrollTop:0;
    const focusId=dialog.contains(document.activeElement)?document.activeElement.id:null;
    const {memory,context}=selected,close=el('button',{id:'receipt-close',type:'button',class:'icon-button','aria-label':t('关闭'),text:'×'});close.onclick=()=>dialog.close();
    const metadata=[context.chatTitle,context.providerName];if(context.created)metadata.push(new Date(context.created).toLocaleString(i18n.locale));
    const heading=el('div',{class:'dialog-heading'},[el('div',{},[
      el('p',{class:'eyebrow',text:'STARPORT / MEMORY'}),el('h2',{id:'memory-receipt-heading',text:t('本轮记忆详情')}),
      el('p',{class:'memory-receipt-context',text:metadata.filter(Boolean).join(' · ')}),
      el('p',{class:'memory-intro',text:t('共同记忆计数包含本轮实际读取的正文；检索浏览单独列出，命中不等于采用。正文及确认状态显示当前版本。')})
    ]),close]);
    const body=el('div',{class:'memory-body','data-receipt-view':view,'aria-busy':String(loading)},[
      section('used','本轮带入的记忆',memory.ids||[],'这轮没有带入共同记忆。'),
      section('candidates','本轮产生的新候选',memory.candidates||[],'这轮没有产生新的候选记忆。'),
      section('browsed','模型检索时浏览过的索引或摘要',memory.browsed?.map(row=>row.id)||[],'这轮没有检索浏览记录。')
    ]);
    const manage=el('button',{id:'receipt-manage',type:'button',class:'secondary-button',text:t('管理全部记忆')});manage.onclick=()=>{dialog.close();globalThis.StarportMemory?.open().catch(error=>toast(error.message));};
    const back=el('button',{id:'receipt-back',type:'button',class:'primary-button',text:t('返回对话')});back.onclick=()=>dialog.close();
    const footer=el('div',{class:'dialog-footer'},[manage]);
    if(!loading&&[...entries.values()].some(entry=>entry.failed)){const retry=el('button',{id:'receipt-retry',type:'button',class:'secondary-button',text:t('重试')});retry.onclick=()=>refresh();footer.append(retry);}
    footer.append(back);dialog.replaceChildren(heading,tabs(memory),body,footer);body.scrollTop=scroll;
    if(focusId)dialog.querySelector('#'+CSS.escape(focusId))?.focus({preventScroll:true});
  }
  async function fetchEntries(){
    const request=++sequence,memory=selected.memory;loading=!entries.size;render();
    const rows=await Promise.all(ids(memory).map(async id=>{
      try{return [id,{item:await api('/memories/'+encodeURIComponent(id))}];}
      catch(error){return [id,error.message==='记忆不存在'?{missing:true}:{failed:true}];}
    }));
    if(request!==sequence||!selected)return;
    entries=new Map(rows);loading=false;render();
  }
  function copy(memory){return {...memory,ids:[...(memory.ids||[])],candidates:[...(memory.candidates||[])],browsed:[...(memory.browsed||[])],reads:[...(memory.reads||[])]};}
  async function open(memory,context={}){
    selected={memory:copy(memory),context:{...context}};view=selected.memory.ids.length?'used':selected.memory.candidates.length?'candidates':selected.memory.browsed.length?'browsed':'used';entries.clear();dialog.replaceChildren();
    const pending=fetchEntries();if(!dialog.open)dialog.showModal();await pending;
  }
  async function refresh(){
    if(!dialog.open||!selected)return;
    const {chatId,messageId}=selected.context;
    if(chatId===state.chat?.id){const message=state.messages.find(row=>row.id===messageId);if(message?.details?.memory)selected.memory=copy(message.details.memory);}
    await fetchEntries();
  }
  return {open,refresh,translate:render};
})();

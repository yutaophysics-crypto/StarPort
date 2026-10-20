'use strict';
globalThis.StarportFiles=(()=>{
  const extensions='md|mdx|txt|pdf|docx?|odt|rtf|xlsx?|ods|csv|pptx?|odp|png|jpe?g|gif|webp|bmp|svg|ico|mp3|wav|mp4|mov|mkv|html?|json|ya?ml|toml|tex|ipynb|py|m?js|tsx?|jsx|css|rs|go|cpp|c|h|sql|log|zip|cmd|bat|ps1|sh';
  const suffix=new RegExp('\\.(?:'+extensions+')(?:#L?\\d+(?:[-:]L?\\d+)*|:\\d+(?::\\d+)?)?$','i');
  function isReference(value){
    if(typeof value!=='string'||!value.trim()||value.length>8192||/[\x00-\x1f]/.test(value))return false;
    const ref=value.trim();
    if(ref.startsWith('#')||/^https?:|^mailto:|^\/\//i.test(ref))return false;
    if(/^file:\/\/\//i.test(ref)||/^[a-z]:[/\\]/i.test(ref))return true;
    if(/^[a-z][\w+.-]*:/i.test(ref))return false;
    return suffix.test(ref)||/^(?:\.{1,2}[/\\]|\/)/.test(ref)||/^(?:README|LICENSE)$/i.test(ref);
  }
  function plainReferences(text){
    const source=String(text),matches=[];
    const pattern=new RegExp('https?://[^\\s<>]+|(?:file:///|[A-Za-z]:[/\\\\])[^\\n<>"`|]*?\\.(?:'+extensions+')(?:#L?\\d+|:\\d+(?::\\d+)?)?(?=$|[\\s，。！？；：、)\\]}>.,;!?:])|(?:[\\p{L}\\p{N}_.-]+[/\\\\])*[\\p{L}\\p{N}_-][\\p{L}\\p{N}_.-]*\\.(?:'+extensions+')(?:#L?\\d+|:\\d+(?::\\d+)?)?(?=$|[^\\p{L}\\p{N}_.-])','giu');
    for(const match of source.matchAll(pattern)){
      if(/^https?:/i.test(match[0])||/[\p{L}\p{N}_@/\\]/u.test(source[match.index-1]||''))continue;
      matches.push({index:match.index,text:match[0],reference:match[0]});
    }
    return matches;
  }
  let menu=null,anchor=null;
  const pending=new Set();
  let cancelChoice=null;
  function closeMenu(restore=false){if(menu)menu.hidden=true;if(restore&&anchor?.isConnected)anchor.focus();anchor=null;}
  function chooseFile(result){
    cancelChoice?.();
    return new Promise(resolve=>{
      const previous=document.activeElement,dialog=el('dialog',{class:'file-choice-dialog','aria-labelledby':'file-choice-heading'});
      let settled=false;
      const finish=file=>{if(settled)return;settled=true;cancelChoice=null;dialog.close();dialog.remove();if(previous?.isConnected)previous.focus();resolve(file);};
      cancelChoice=()=>finish(null);
      const title=result.searchIncomplete?'请确认文件路径':'找到多个匹配文件';
      const close=el('button',{type:'button',class:'icon-button','aria-label':t('取消'),text:'×'});close.onclick=()=>finish(null);
      dialog.append(el('div',{class:'dialog-heading'},[el('h2',{id:'file-choice-heading',text:t(title)}),close]));
      const body=el('div',{class:'dialog-body'});
      body.append(el('p',{class:'muted',text:t(result.searchIncomplete?'部分目录未能检查，请根据完整路径选择文件。':'请选择要打开的文件，星港不会自动选择同名文件。')}));
      body.append(el('p',{class:'file-choice-reference',text:result.reference}));
      const list=el('div',{class:'file-choice-list'});
      for(const file of result.candidates){
        const button=el('button',{type:'button',class:'file-choice-item',text:file.relativePath||file.path,title:file.path});
        button.onclick=()=>finish(file);list.append(button);
      }
      body.append(list);dialog.append(body);
      const cancel=el('button',{type:'button',class:'secondary-button',text:t('取消')});cancel.onclick=()=>finish(null);
      dialog.append(el('div',{class:'dialog-footer'},[cancel]));
      dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});dialog.addEventListener('close',()=>finish(null));
      document.body.append(dialog);dialog.showModal();list.querySelector('button')?.focus();
    });
  }
  async function perform(reference,context,action){
    const key=(context.chatId||'')+'\0'+reference;if(pending.has(key))return;
    pending.add(key);
    try{
      const result=await api('/files/'+action,'POST',{reference,chatId:context.chatId||null});
      if(result.ambiguous){const selected=await chooseFile(result);if(selected)await api('/files/'+action,'POST',{reference:encodeURIComponent(selected.path),chatId:context.chatId||null});}
    }
    catch(error){toast(error.message);}
    finally{pending.delete(key);}
  }
  function ensureMenu(){
    if(menu)return;
    menu=el('div',{id:'file-actions-menu',class:'chat-actions-menu file-actions-menu',role:'menu',hidden:'','aria-label':t('文件操作')});document.body.append(menu);
    document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!anchor?.contains(event.target))closeMenu();});
    document.addEventListener('scroll',()=>closeMenu(),true);window.addEventListener('resize',()=>closeMenu());
    menu.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);return;}
      if(event.key==='Tab'){closeMenu(true);return;}
      if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      event.preventDefault();const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);
      buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
    };
  }
  function showMenu(node,reference,context,x,y){
    ensureMenu();closeMenu();anchor=node;menu.setAttribute('aria-label',t('文件操作'));
    let display=reference;
    if(/^file:\/\/\//i.test(display))try{display=decodeURIComponent(new URL(display).pathname).replace(/^\/([a-z]:)/i,'$1').replaceAll('/','\\');}catch{}
    const name=display.split(/[\\/]/).pop(),caption=el('div',{class:'file-menu-path',title:display},[el('strong',{text:name}),display!==name?el('small',{text:display}):null]);
    menu.replaceChildren(caption,...[['open','打开文件'],['reveal','在资源管理器中查看'],['open-with','打开方式']].map(([action,label])=>{
      const button=el('button',{type:'button',role:'menuitem',text:t(label)});
      button.onclick=()=>{closeMenu(true);perform(reference,context,action);};return button;
    }));
    menu.hidden=false;
    menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';
    menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
    menu.querySelector('button').focus();
  }
  function bindMenu(node,reference,context={}){
    node.setAttribute('aria-haspopup','menu');
    node.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();const box=node.getBoundingClientRect();showMenu(node,reference,context,event.clientX||box.left,event.clientY||box.bottom);};
    node.addEventListener('keydown',event=>{
      if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();const box=node.getBoundingClientRect();showMenu(node,reference,context,box.left,box.bottom);}
    });
    return node;
  }
  function bind(node,reference,context={}){
    node.removeAttribute('target');node.removeAttribute('rel');node.setAttribute('href','#');node.setAttribute('role','button');
    node.classList.add('local-file-link');node.dataset.fileReference=reference;
    node.title=reference+'\n'+t('点击打开，右键查看更多操作');
    node.setAttribute('aria-label',t('打开文件 {name}',{name:node.textContent||reference}));
    node.onclick=event=>{event.preventDefault();perform(reference,context,'open');};
    node.addEventListener('keydown',event=>{if(event.key===' '){event.preventDefault();perform(reference,context,'open');}});
    return bindMenu(node,reference,context);
  }
  function decorate(root,context={}){
    // Single inline-code file names are useful; commands and fenced code stay literal.
    for(const code of root.querySelectorAll('code')){
      if(code.closest('pre,a,.katex,.math-source')||!isReference(code.textContent))continue;
      if(/\s/.test(code.textContent)&&!/^file:\/\/\/|^[a-z]:[/\\]/i.test(code.textContent))continue;
      const link=el('a',{text:code.textContent});code.replaceChildren(bind(link,code.textContent,context));
    }
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let node;
    while(node=walker.nextNode())if(!node.parentElement?.closest('a,pre,code,.katex,.math-source,script,style'))nodes.push(node);
    for(const textNode of nodes){
      const refs=plainReferences(textNode.data);if(!refs.length)continue;
      const fragment=document.createDocumentFragment();let start=0;
      for(const ref of refs){fragment.append(document.createTextNode(textNode.data.slice(start,ref.index)),bind(el('a',{text:ref.text}),ref.reference,context));start=ref.index+ref.text.length;}
      fragment.append(document.createTextNode(textNode.data.slice(start)));textNode.replaceWith(fragment);
    }
    return root;
  }
  return {isReference,plainReferences,bind,bindMenu,decorate,closeMenu};
})();

'use strict';
globalThis.StarportContext=(()=>{
  const button=$('#context-indicator'),dialog=$('#context-dialog');
  const number=value=>value.toLocaleString(i18n.locale,{maximumFractionDigits:1});
  const names={starportTokens:'星港历史交接预算',modelWindowTokens:'模型窗口（原工具报告）',nativeWindowTokens:'原工具配置的窗口',nativeAutoCompactTokens:'原工具压缩参考上限'};
  const pending=new Map();let lastKey=null;
  const binding=()=>{const options=opts();return JSON.stringify([currentId(),state.chat?.workspace||state.workspace,options.worktree||false,options.model||'',options.provider||'']);};
  const key=()=>JSON.stringify([state.chat?.id,binding()]);
  async function refresh(force=false){
    if(!state.chat)return;
    const requestKey=key(),chatId=state.chat.id;if(pending.has(requestKey))return pending.get(requestKey);
    const request=(async()=>{
      try{
        const data=await api('/chats/'+encodeURIComponent(chatId)+'/context'+(force?'?refresh=1':''));
        if(requestKey===key())state.context=data;
      }catch(error){if(force&&requestKey===key())toast(error.message);}
      finally{pending.delete(requestKey);render();}
    })();pending.set(requestKey,request);render();return request;
  }
  function current(){
    return state.chat&&state.context?.binding===binding()?state.context:{status:['codex','claude'].includes(currentId())?'waiting':'unavailable',percent:null,usedTokens:null,windowTokens:null};
  }
  function label(data){
    if(data.status==='compacting')return t('正在压缩…');
    if(data.status==='unavailable')return t('暂不支持');
    if(data.usedTokens==null)return t('待获取');
    return data.percent==null?number(data.usedTokens)+' tokens':number(data.percent)+'%';
  }
  function details(data){
    const body=$('#context-body');body.replaceChildren();
    body.append(el('p',{class:'context-summary',text:(currentProvider()?.name||currentId())+' · '+label(data)}));
    if(data.model)body.append(el('p',{class:'muted',text:data.model}));
    const list=el('dl',{class:'context-facts'});
    const limits=data.limits||{};
    for(const [name,value]of [['最近一次占用',data.usedTokens],['计算百分比的上限',data.windowTokens],...Object.entries(names).map(([key,name])=>[name,limits[key]])])
      list.append(el('dt',{text:t(name)}),el('dd',{text:value==null?t('未提供'):number(value)+' tokens'}));
    body.append(list);
    if(data.limitSources?.length)body.append(el('p',{text:t('取已知上限中的最小值；本次采用：{limits}',{limits:data.limitSources.map(key=>t(names[key])).join(' / ')})}));
    body.append(el('p',{class:'muted',text:t('星港预算用于新会话交接历史，不限制原工具的连续会话；因此占比可能超过 100%。原工具压缩参考上限包含其设置或压缩策略，并不保证恰在此值触发压缩。')}));
    if(limits.autoCompactScope==='body_after_prefix')body.append(el('p',{class:'muted',text:t('原工具的压缩线只计算前缀之后的新增内容，与当前总占用口径不同，未纳入最小值。')}));
    if(limits.status==='waiting')body.append(el('p',{class:'muted',text:t('正在读取原工具的上下文限制…')}));
    if(['error','unavailable'].includes(limits.status))body.append(el('p',{class:'muted',text:t('原工具限制暂未取得，当前只采用其他已知上限。')}));
    if(limits.status==='ready'&&limits.nativeAutoCompactTokens==null)body.append(el('p',{class:'muted',text:t('原工具未提供明确的压缩线，默认值不作猜测。')}));
    body.append(el('p',{class:'muted',text:t('读取的是当前配置；正在运行的任务是否立即采用新设置，由原工具决定。')}));
    const explanation=data.status==='unavailable'?'当前接入方式尚未提供可核对的上下文占用，暂不估算百分比。':data.status==='compacting'?'原工具正在压缩上下文，完成后等待新的用量报告。':data.usedTokens==null?'发送消息后，等待原工具报告。旧记录、导入的对话或重置后的会话可能暂时没有数据。':data.basis==='claude-input'?'采用 Claude Code 状态栏口径：最近一次请求的输入，包含缓存读写，不包含输出。':'采用 Codex 最近一次请求的 Token 总数与原工具报告的窗口容量；不使用累计消耗。';
    body.append(el('p',{text:t(explanation)}),el('p',{class:'muted',text:t('随原工具事件更新。尚未发送的文字和待转入的历史未计入；这不是账号剩余额度，也不是自动压缩倒计时。')}));
    if(data.updatedAt)body.append(el('p',{class:'muted',text:t('最后报告：{time}',{time:new Date(data.updatedAt).toLocaleString(i18n.locale)})}));
    const reload=el('button',{class:'secondary-button',text:t('刷新上下文限制')});reload.disabled=pending.has(key());reload.onclick=()=>refresh(true);body.append(reload);
  }
  function render(){
    const data=current(),text=t('上下文')+' · '+label(data);
    button.title=text+(data.windowTokens?' · '+t('计算百分比的上限')+': '+number(data.windowTokens)+' tokens':'');button.setAttribute('aria-label',button.title);button.classList.toggle('context-high',data.percent>=80);
    const track=el('span',{class:'context-track','aria-hidden':'true'}),fill=el('span');
    if(data.percent!=null){fill.style.width=Math.min(100,Math.max(0,data.percent))+'%';track.append(fill);}
    button.replaceChildren(track,el('span',{text}));
    if(dialog.open)details(data);
    const selected=key();if(state.chat&&selected!==lastKey){lastKey=selected;Promise.resolve().then(()=>refresh());}
  }
  button.onclick=()=>{
    const close=el('button',{class:'icon-button',text:'×','aria-label':t('关闭')});close.onclick=()=>dialog.close();
    dialog.replaceChildren(el('div',{class:'dialog-heading'},[el('h2',{id:'context-heading',text:t('上下文占用')}),close]),el('div',{id:'context-body',class:'dialog-body'}));
    details(current());dialog.showModal();refresh(true);
  };
  setInterval(()=>{if(!document.hidden&&state.chat)refresh();},30000);
  render();return {render,refresh};
})();

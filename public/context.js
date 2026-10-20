'use strict';
globalThis.StarportContext=(()=>{
  const button=$('#context-indicator'),dialog=$('#context-dialog');
  const number=value=>value.toLocaleString(i18n.locale,{maximumFractionDigits:1});
  function current(){
    const options=opts(),binding=JSON.stringify([currentId(),state.chat?.workspace||state.workspace,options.worktree||false,options.model||'',options.provider||'']);
    return state.chat&&state.context?.binding===binding?state.context:{status:['codex','claude'].includes(currentId())?'waiting':'unavailable',percent:null,usedTokens:null,windowTokens:null};
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
    for(const [name,value]of [['最近一次占用',data.usedTokens],['上下文窗口',data.windowTokens]])list.append(el('dt',{text:t(name)}),el('dd',{text:value==null?t('待获取'):number(value)+' tokens'}));
    body.append(list);
    const explanation=data.status==='unavailable'?'当前接入方式尚未提供可核对的上下文占用，暂不估算百分比。':data.status==='compacting'?'原工具正在压缩上下文，完成后等待新的用量报告。':data.usedTokens==null?'发送消息后，等待原工具报告。旧记录、导入的对话或重置后的会话可能暂时没有数据。':data.basis==='claude-input'?'采用 Claude Code 状态栏口径：最近一次请求的输入，包含缓存读写，不包含输出。':'采用 Codex 最近一次请求的 Token 总数与原工具报告的窗口容量；不使用累计消耗。';
    body.append(el('p',{text:t(explanation)}),el('p',{class:'muted',text:t('随原工具事件更新。尚未发送的文字和待转入的历史未计入；这不是账号剩余额度，也不是自动压缩倒计时。')}));
    if(data.updatedAt)body.append(el('p',{class:'muted',text:t('最后报告：{time}',{time:new Date(data.updatedAt).toLocaleString(i18n.locale)})}));
  }
  function render(){
    const data=current(),text=t('上下文')+' · '+label(data);
    button.title=text;button.setAttribute('aria-label',text);button.classList.toggle('context-high',data.percent>=80);
    const track=el('span',{class:'context-track','aria-hidden':'true'}),fill=el('span');
    if(data.percent!=null){fill.style.width=Math.min(100,Math.max(0,data.percent))+'%';track.append(fill);}
    button.replaceChildren(track,el('span',{text}));
    if(dialog.open)details(data);
  }
  button.onclick=()=>{
    const close=el('button',{class:'icon-button',text:'×','aria-label':t('关闭')});close.onclick=()=>dialog.close();
    dialog.replaceChildren(el('div',{class:'dialog-heading'},[el('h2',{id:'context-heading',text:t('上下文占用')}),close]),el('div',{id:'context-body',class:'dialog-body'}));
    details(current());dialog.showModal();
  };
  render();return {render};
})();

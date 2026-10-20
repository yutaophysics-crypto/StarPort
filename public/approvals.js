(() => {
  const drafts=new Map();
  function remember(root){for(const card of root.querySelectorAll('form[data-approval-key]')){drafts.set(card.dataset.approvalKey,card.approvalDraft?.());if(drafts.size>64)drafts.delete(drafts.keys().next().value);}}
  function render(request,{el,t,answer,onError,scope=''}){
    const params=request.params||{},question=request.kind==='question';
    const key=scope+':'+request.id,card=el('form',{class:'approval native-approval native-'+(request.provider||'codex'),'data-approval-id':request.id,'data-approval-key':key});
    card.append(el('div',{class:'approval-heading'},[el('span',{'aria-hidden':'true',text:question?'?':'◇'}),el('h3',{text:params.title||t(question?'需要你补充信息':'需要你的批准')})]));
    if(params.description||params.reason)card.append(el('p',{text:params.description||params.reason}));
    const fields=[];let submitting=false;
    if(question)for(const q of params.questions||[]){
      const field=el('fieldset',{class:'approval-question'},[el('legend',{text:q.question})]);
      if(q.header)field.append(el('small',{text:q.header}));
      const choices=[];
      for(const [index,raw] of (q.options||[]).entries()){
        const option=typeof raw==='string'?{label:raw}:raw;
        if(!option||typeof option.label!=='string')continue;
        const input=el('input',{type:q.multiSelect?'checkbox':'radio',name:q.id,value:option.label,id:request.id+':'+q.id+':'+index});choices.push(input);
        field.append(el('label',{class:'approval-option'},[input,el('span',{},[el('b',{text:option.label}),option.description?el('small',{text:option.description}):null])]));
      }
      const free=el('textarea',{rows:2,'aria-label':q.question,placeholder:t('输入回答或补充说明')});
      free.oninput=()=>{if(!q.multiSelect&&free.value)for(const choice of choices)choice.checked=false;};
      if(!q.multiSelect)for(const choice of choices)choice.onchange=()=>{free.value='';};
      field.append(free);card.append(field);fields.push({q,choices,free});
    }else{
      if(params.toolName)card.append(el('strong',{class:'approval-tool',text:params.toolName}));
      const input=params.input??params.command??params.changes??params;
      card.append(el('pre',{text:typeof input==='string'?input:JSON.stringify(input,null,2)}));
      if(params.blockedPath||params.cwd)card.append(el('p',{class:'approval-path',text:params.blockedPath||params.cwd}));
    }
    const draft=drafts.get(key);
    for(const {q,choices,free} of fields){for(const choice of choices)choice.checked=!!draft?.[q.id]?.choices.includes(choice.value);free.value=draft?.[q.id]?.free||'';}
    card.approvalDraft=()=>Object.fromEntries(fields.map(({q,choices,free})=>[q.id,{choices:choices.filter(choice=>choice.checked).map(choice=>choice.value),free:free.value}]));
    const buttons=el('div',{class:'approval-actions'}),status=el('p',{class:'approval-submit-status',role:'status'});
    async function submit(decision){
      if(submitting||params.submitDisabled&&decision!=='skip')return;
      const answers={};
      if(question&&decision==='accept')for(const {q,choices,free} of fields){
        const values=choices.filter(choice=>choice.checked).map(choice=>choice.value);if(free.value.trim())values.push(free.value.trim());
        if(!values.length){free.focus();status.textContent=t('请输入问题的回答');return;}
        answers[q.id]=q.multiSelect?values:values.join('；');
      }
      for(const button of buttons.querySelectorAll('button'))button.disabled=true;
      submitting=true;
      status.textContent=t('正在提交…');
      try{await answer({id:request.id,decision,answers});status.textContent=t('已提交，等待原工具继续');}
      catch(error){submitting=false;status.textContent=error.message;onError(error);for(const button of buttons.querySelectorAll('button'))button.disabled=button===accept&&!!params.submitDisabled;}
    }
    const accept=el('button',{class:'primary-button',type:'submit',text:t(question?'提交回答':'允许这一次')});
    const deny=el('button',{class:'secondary-button',type:'button',text:t(question?'取消回答':'拒绝')});deny.onclick=()=>submit('decline');
    if(params.defaultToNo&&!question)buttons.append(deny,accept);else {buttons.append(accept);if(!question)buttons.append(deny);}
    if(question){const skip=el('button',{class:'secondary-button',type:'button',text:t('跳过'),title:t('跳过本次提问，不选择任何答案')});skip.onclick=()=>submit('skip');buttons.append(skip);}
    if(params.submitDisabled){accept.disabled=true;status.textContent=t('当前任务暂不接收补充消息；输入已保留，请稍后再试。');}
    if(!question&&request.provider==='codex'){
      const native=params.availableDecisions;
      if(!native||native.some(value=>value==='acceptForSession'||value?.decision==='acceptForSession')){
        const session=el('button',{class:'secondary-button',type:'button',text:t('本次原生会话内允许')});session.onclick=()=>submit('acceptForSession');buttons.append(session);
      }
    }
    card.onsubmit=event=>{event.preventDefault();submit('accept');};card.append(buttons,status);return card;
  }
  globalThis.StarportApprovals={render,remember};
})();

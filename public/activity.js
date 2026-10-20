(() => {
  const model=StarportActivityModel,views=new model.DisclosureState();let focus=null;
  const names={running:'正在执行',pending:'等待批准',paused:'已暂停',complete:'已完成',error:'失败',denied:'已拒绝',interrupted:'已停止',unknown:'未确认结束'};
  const glyphs={running:'◌',pending:'?',paused:'‖',complete:'✓',error:'×',denied:'⊘',interrupted:'⊘',unknown:'·'};
  const text=value=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
  const firstLine=value=>text(value).split('\n').find(line=>line.trim())?.replace(/^[#*\s]+|\*+$/g,'').slice(0,180)||'';
  function remember(root){
    for(const node of root.querySelectorAll('details[data-disclosure-key]'))views.set(node.dataset.disclosureKey,node.open);
    const node=document.activeElement?.closest('[data-activity-focus]');
    focus=node&&root.contains(node)?{key:node.dataset.activityFocus,root:node.closest('.native-workflow')?.dataset.disclosureKey}:null;
  }
  function restoreFocus(root){
    if(!focus)return;
    const nodes=[...root.querySelectorAll('[data-activity-focus]')];
    const node=nodes.find(node=>node.dataset.activityFocus===focus.key&&node.getClientRects().length)||nodes.find(node=>node.dataset.activityFocus===focus.root);
    node?.focus({preventScroll:true});focus=null;
  }
  function render(message,{el,t,markdown,chatId}){
    const scope=chatId+':'+message.id,level=model.level,answer=model.answer(message),entries=model.entries(message);
    const root=el('div',{class:'native-activity native-'+message.provider,'data-provider':message.provider});
    const progress=message.details?.contextCompaction;
    const compacting=message.status==='running'&&progress?.status==='running';
    // Visible even when the user hides the detailed execution trace.
    if(compacting)root.append(el('div',{class:'context-compaction-status',role:'status','aria-live':'polite'},[
      el('span',{class:'native-glyph running',text:'◌','aria-hidden':'true'}),
      el('div',{},[
        el('strong',{text:t('正在压缩上下文…')}),
        el('small',{text:t('正在整理较早的对话，保留最近消息；完成后继续回答。')}),
        progress.parts>1?el('small',{text:t('第 {part} / {parts} 段',{part:progress.part,parts:progress.parts})}):null
      ])
    ]));
    function disclosure(key,attrs,summary,populate,open=false){
      const node=el('details',{...attrs,'data-disclosure-key':key});node.open=open;
      summary.dataset.activityFocus=key;node.append(summary);let populated=false;
      const fill=()=>{if(node.open&&!populated){populated=true;populate(node);}};fill();
      node.ontoggle=()=>{if(node.isConnected){views.set(key,node.open);fill();}};return node;
    }
    function shortInput(item){
      let input=item.input;try{if(typeof input==='string'&&input.startsWith('{'))input=JSON.parse(input);}catch{}
      return String(input?.command||input?.CommandLine||input?.file_path||input?.path||input?.query||(typeof input==='string'?input:'')||'').replace(/\s+/g,' ').slice(0,160);
    }
    const titles={commandExecution:'运行命令',fileChange:'文件更改',webSearch:'搜索网页',contextCompaction:'压缩上下文',enteredReviewMode:'开始审查',exitedReviewMode:'结束审查',checkpoint:'检查点'};
    function record(item,groupScope=scope){
      const current=model.status(item,message),kind=item.kind||'tool';
      const label=t(kind==='thinking'?(message.provider==='codex'?'思考摘要':'思考过程'):kind==='text'?'过程说明':kind==='plan'?'计划':kind==='diff'?'本轮文件差异':titles[item.nativeType]||item.name||item.nativeType||'工具');
      const preview=kind==='thinking'||kind==='text'?firstLine(item.text):shortInput(item)||firstLine(item.text);
      const title=el('summary',{class:'workflow-row-heading'},[
        el('span',{class:'native-glyph '+current,text:glyphs[current]||'·','aria-hidden':'true'}),
        el('span',{class:'native-name',text:label}),el('span',{class:'native-preview',text:preview}),
        el('small',{class:'native-status '+current,text:t(current==='running'&&kind==='thinking'?'正在思考':names[current]||names.unknown)})]);
      const key=groupScope+':'+level+':'+item.id;
      return disclosure(key,{class:'native-item native-'+kind,'data-status':current,'data-activity-id':item.id},title,node=>{
        const body=el('div',{class:'native-item-body'});
        if(item.text)body.append(markdown(item.text));
        if(item.cwd)body.append(el('div',{class:'native-cwd',text:item.cwd}));
        const input=text(item.inputPartial||item.input),output=text(item.output);
        if(input)body.append(el('pre',{class:'native-input',text:input}));
        if(output)body.append(el('pre',{class:'native-output',text:output}));
        for(const change of item.changes||[])if(change.diff)body.append(el('div',{class:'native-file-diff'},[el('b',{text:change.path||''}),el('pre',{class:'native-diff',text:change.diff})]));
        if(item.plan)body.append(el('ol',{class:'native-plan-list'},item.plan.map(step=>el('li',{'data-status':step.status},[el('span',{'aria-hidden':'true',text:step.status==='completed'?'✓':step.status==='inProgress'?'◌':'○'}),el('span',{text:step.step})]))));
        if(item.meta){const details=el('details',{class:'native-meta'},[el('summary',{text:t('原生工具详情')}),el('pre',{text:text(item.meta)})]);details.open=level==='full';body.append(details);}
        const info=[];
        if(item.exitCode!=null)info.push(t('退出代码：{code}',{code:item.exitCode}));
        if(item.durationMs!=null)info.push(t('耗时 {seconds} 秒',{seconds:(item.durationMs/1000).toFixed(1)}));
        if(info.length)body.append(el('small',{class:'native-result-meta',text:info.join(' · ')}));
        if(!body.childNodes.length)body.append(el('p',{class:'native-empty',text:t('原工具未提供更多详情')}));
        globalThis.StarportCodeCopy?.decorate(body);
        node.append(body);
      },views.get(key,level==='full'));
    }
    function duration(agent){
      if(!Number.isFinite(agent.startedAt))return null;
      return el('span',{class:'subagent-duration','data-start':agent.startedAt,'data-end':agent.endedAt??agent.updatedAt??agent.startedAt,'data-status':agent.status});
    }
    function agentView(agent){
      const key=scope+':'+level+':agent:'+agent.id;
      const title=el('summary',{class:'workflow-row-heading'},[
        el('span',{class:'native-glyph '+agent.status,text:glyphs[agent.status]||'·','aria-hidden':'true'}),
        el('span',{class:'native-name',text:agent.name||t('子代理')}),
        el('span',{class:'native-preview',text:firstLine(agent.task||agent.activity)}),
        el('small',{class:'native-status '+agent.status,text:t(agent.status==='running'?'正在思考':names[agent.status]||names.unknown)}),duration(agent)]);
      return disclosure(key,{class:'native-item workflow-agent','data-subagent-id':agent.id,'data-status':agent.status},title,node=>{
        const body=el('div',{class:'workflow-agent-body'});
        if(agent.depth>0)body.append(el('small',{class:'subagent-parent',text:t('由子任务派发')}));
        if(agent.task)body.append(el('p',{class:'subagent-task',text:agent.task}));
        if(agent.activity)body.append(el('p',{class:'subagent-activity',text:t('最新操作：{activity}',{activity:agent.activity})}));
        if(agent.updatedAt)body.append(el('small',{class:'subagent-updated','data-updated':agent.updatedAt}));
        if(agent.status==='unknown')body.append(el('p',{class:'native-empty',text:t('未收到明确的完成状态')}));
        if(!agent.records.length)body.append(el('p',{class:'native-empty',text:t('原工具未提供该子任务的详细过程。')}));
        for(const item of agent.records)body.append(record(item,scope+':agent:'+agent.id));
        for(const child of agent.children)body.append(agentView(child));
        node.append(body);
      },views.get(key,level==='full'));
    }
    // Track terminal transitions even while the workflow is hidden.
    const workflowKey=scope+':workflow',open=views.root(workflowKey,message.status);
    if(level!=='hidden'&&(entries.length||message.status==='running')&&(!compacting||entries.length)){
      const agentCount=agent=>1+agent.children.reduce((total,child)=>total+agentCount(child),0);
      const running=message.status==='running',waiting=running&&model.rows(message).some(row=>model.status(row,message)==='pending'),count=entries.filter(entry=>entry.type==='record').length,agents=entries.filter(entry=>entry.type==='agent').reduce((total,entry)=>total+agentCount(entry.agent),0);
      const summary=el('summary',{class:'workflow-heading'},[
        el('span',{class:'native-glyph '+(running?'running':message.status==='error'?'error':''),text:running?'◌':'◇','aria-hidden':'true'}),
        el('span',{class:'workflow-label',text:t(waiting?'等待批准':compacting?'正在压缩上下文…':running?'正在思考':'查看任务过程')}),
        el('span',{class:'workflow-count',text:[count?t('{count} 个步骤',{count}):'',agents?t('{count} 个子任务',{count:agents}):''].filter(Boolean).join(' · ')}),
        el('span',{class:'workflow-duration','data-start':Date.parse(message.created),'data-end':message.details?.endedAt,'data-status':message.status})]);
      root.append(disclosure(workflowKey,{class:'native-workflow','data-level':level,'data-status':message.status},summary,node=>{
        const body=el('div',{class:'workflow-body'});
        const modes=el('div',{class:'workflow-view-switch','aria-label':t('执行过程显示')});
        for(const [value,label]of [['overview','概览'],['full','完整']]){
          const button=el('button',{type:'button',text:t(label),'aria-pressed':String(level===value),'data-activity-focus':workflowKey+':'+value});
          button.onclick=()=>{setLevel(value);views.set(workflowKey,true);renderMessages();};modes.append(button);
        }
        body.append(modes);
        for(const entry of entries)body.append(entry.type==='agent'?agentView(entry.agent):record(entry.record));
        if(running&&!entries.some(entry=>entry.type==='agent'?entry.agent.status==='running':['running','pending','paused'].includes(model.status(entry.record,message))))
          body.append(el('p',{class:'workflow-thinking',role:'status'},[el('span',{class:'native-glyph running',text:'◌','aria-hidden':'true'}),t(compacting?'正在压缩上下文…':'正在思考')]));
        if(!message.details?.activity?.length&&message.details?.tools?.length)body.append(el('small',{class:'native-history-note',text:t('旧记录未保存完整过程，显示已有工具记录。')}));
        node.append(body);
      },open));
    }
    if(answer.text)root.append(el('div',{class:'native-final-answer'},[markdown(answer.text)]));
    return root;
  }
  function preference(){
    const root=document.querySelector('#activity-preference');if(!root)return;
    root.replaceChildren(el('span',{class:'activity-preference-label',text:t('执行过程显示')}));
    const group=el('div',{class:'activity-levels',role:'group','aria-label':t('执行过程显示')});
    for(const [value,label]of [['hidden','隐藏'],['overview','概览'],['full','完整']]){
      const button=el('button',{type:'button','data-activity-level':value,text:t(label),'aria-pressed':String(model.level===value)});
      button.onclick=()=>{setLevel(value);renderMessages();root.querySelector('[data-activity-level="'+value+'"]').focus();};group.append(button);
    }
    root.append(group,el('small',{text:t('运行时展开，完成后收起。')}));
  }
  function setLevel(value){model.setLevel(value);preference();}
  function tick(){
    for(const node of document.querySelectorAll('.workflow-duration')){
      const start=Number(node.dataset.start),end=node.dataset.status==='running'?Date.now():Number(node.dataset.end);
      node.textContent=Number.isFinite(start)&&Number.isFinite(end)&&end>=start?formatDuration((end-start)/1000):'';
    }
  }
  globalThis.StarportActivity={render,remember,restoreFocus,preference,setLevel,tick,status:model.status};
})();

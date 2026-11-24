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
  // Each drawn process remembers what it shows, so update() can change only what differs: a long
  // running reply then redraws the rows a push changed instead of thousands of rows each time.
  const drawn=new WeakMap(),objectIds=new WeakMap();let lastId=0;
  // Rows that did not change stay the same objects between pushes (StarportLive.applyPatch).
  const oid=value=>{let id=objectIds.get(value);if(id===undefined){id=++lastId;objectIds.set(value,id);}return id;};
  // Puts nodes in order without moving the ones that stay; moving one makes the browser restyle it.
  function place(parent,nodes){
    if(!parent.firstChild){parent.append(...nodes);return;}
    const keep=new Set(nodes);let cursor=parent.firstChild;
    for(const node of nodes){
      while(cursor&&!keep.has(cursor)){const next=cursor.nextSibling;cursor.remove();cursor=next;}
      if(node===cursor)cursor=cursor.nextSibling;else parent.insertBefore(node,cursor);
    }
    while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  }
  // The node drawn for key last time when it showed the same thing (sig), else a new one.
  function keyed(previous,next,key,sig,build){
    const old=previous.get(key),entry=old&&old.sig===sig?old:{sig,node:build()};
    next.set(key,entry);return entry.node;
  }
  const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
  const setData=(node,name,value)=>{value=String(value);if(node.dataset[name]!==value)node.dataset[name]=value;};
  // A companion's turn in a run card (workflow-process.js) uses the same view with a few options:
  // answer:false leaves the answer to the card, autoOpen:false keeps it closed until opened, lead()
  // adds rows above the steps, pending shows it before the turn has loaded, onOpen() loads it.
  function render(message,options){
    const view={options,scope:options.chatId+':'+message.id,level:model.level,parts:new Map(),rows:new Map(),workflow:null};
    view.root=options.el('div',{class:'native-activity native-'+message.provider,'data-provider':message.provider});
    drawn.set(view.root,view);draw(view,message);return view.root;
  }
  // Brings a process drawn by render() up to a newer copy of the same reply. False when the view
  // changed in a way it does not follow (level, extra rows, loading), and the caller draws anew.
  function update(root,message,options){
    const view=drawn.get(root),before=view?.options;
    if(!view||view.scope!==options.chatId+':'+message.id||view.level!==model.level||before.lead||options.lead||!!before.pending!==!!options.pending
      ||(before.answer??true)!==(options.answer??true)||(before.autoOpen??true)!==(options.autoOpen??true)
      ||!!before.collapseButton!==!!options.collapseButton)return false;
    view.options=options;draw(view,message);return true;
  }
  function draw(view,message){
    const {el,t,markdown,answer:showAnswer=true,autoOpen=true,lead=null,pending=false}=view.options,level=view.level;
    const answer=model.answer(message),entries=model.entries(message);
    view.message=message;view.entries=entries;
    const progress=message.details?.contextCompaction;
    const compacting=message.status==='running'&&progress?.status==='running';
    const parts=new Map(),nodes=[];
    // Visible even when the user hides the detailed execution trace.
    if(compacting)nodes.push(keyed(view.parts,parts,'compaction',JSON.stringify(progress),()=>el('div',{class:'context-compaction-status',role:'status','aria-live':'polite'},[
      el('span',{class:'native-glyph running',text:'◌','aria-hidden':'true'}),
      el('div',{},[
        el('strong',{text:t('正在压缩上下文…')}),
        el('small',{text:t('正在整理较早的对话，保留最近消息；完成后继续回答。')}),
        progress.parts>1?el('small',{text:t('第 {part} / {parts} 段',{part:progress.part,parts:progress.parts})}):null
      ])
    ])));
    // Track terminal transitions even while the workflow is hidden.
    const workflowKey=view.scope+':workflow',open=autoOpen?views.root(workflowKey,message.status):views.get(workflowKey,false);
    if(level!=='hidden'&&(entries.length||message.status==='running'||pending||lead)&&(!compacting||entries.length))nodes.push(workflow(view,message,workflowKey,open,compacting));
    else view.workflow=null;
    if(showAnswer&&answer.text)nodes.push(keyed(view.parts,parts,'answer',answer.text,()=>el('div',{class:'native-final-answer'},[markdown(answer.text)])));
    view.parts=parts;place(view.root,nodes);
  }
  function disclosure(view,key,attrs,summary,populate,open=false){
    const node=view.options.el('details',{...attrs,'data-disclosure-key':key});node.open=open;
    summary.dataset.activityFocus=key;node.append(summary);let populated=false;
    const fill=()=>{if(node.open&&!populated){populated=true;populate(node);}};fill();
    node.ontoggle=()=>{if(node.isConnected){views.set(key,node.open);fill();}};return node;
  }
  // The argument that says what a step works on; tools name it differently (agy: Path, CommandLine).
  const subjects=['command','commandline','file_path','path','absolutepath','targetfile','directorypath','query','url'];
  function shortInput(item){
    let input=item.input;try{if(typeof input==='string'&&input.startsWith('{'))input=JSON.parse(input);}catch{}
    let value=typeof input==='string'?input:'';
    if(input&&typeof input==='object'){
      const keys=Object.keys(input);
      for(const name of subjects){const key=keys.find(key=>key.toLowerCase()===name);if(typeof input[key]==='string'&&input[key]){value=input[key];break;}}
    }
    return value.replace(/\s+/g,' ').slice(0,160);
  }
  const titles={commandExecution:'运行命令',fileChange:'文件更改',webSearch:'搜索网页',contextCompaction:'压缩上下文',enteredReviewMode:'开始审查',exitedReviewMode:'结束审查',checkpoint:'检查点'};
  function record(view,item,groupScope=view.scope){
    const {el,t,markdown}=view.options,message=view.message,level=view.level;
    const current=model.status(item,message),kind=item.kind||'tool';
    const label=t(kind==='thinking'?(['codex','antigravity'].includes(message.provider)?'思考摘要':'思考过程'):kind==='text'?'过程说明':kind==='plan'?'计划':kind==='diff'?'本轮文件差异':titles[item.nativeType]||item.name||item.nativeType||'工具');
    const preview=kind==='thinking'||kind==='text'?firstLine(item.text):shortInput(item)||firstLine(item.text);
    const title=el('summary',{class:'workflow-row-heading'},[
      el('span',{class:'native-glyph '+current,text:glyphs[current]||'·','aria-hidden':'true'}),
      el('span',{class:'native-name',text:label}),el('span',{class:'native-preview',text:preview}),
      el('small',{class:'native-status '+current,text:t(current==='running'&&kind==='thinking'?'正在思考':names[current]||names.unknown)})]);
    const key=groupScope+':'+level+':'+item.id;
    return disclosure(view,key,{class:'native-item native-'+kind,'data-status':current,'data-activity-id':item.id},title,node=>{
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
  function duration(view,agent){
    if(!Number.isFinite(agent.startedAt))return null;
    return view.options.el('span',{class:'subagent-duration','data-start':agent.startedAt,'data-end':agent.endedAt??agent.updatedAt??agent.startedAt,'data-status':agent.status});
  }
  // What an agent's row shows: its own fields and the rows and agents inside it.
  function agentSig(agent,message){
    const {records,children,order,...own}=agent;
    return JSON.stringify([own,records.map(item=>oid(item)+':'+model.status(item,message)),children.map(child=>agentSig(child,message))]);
  }
  function agentView(view,agent){
    const {el,t}=view.options,key=view.scope+':'+view.level+':agent:'+agent.id;
    const title=el('summary',{class:'workflow-row-heading'},[
      el('span',{class:'native-glyph '+agent.status,text:glyphs[agent.status]||'·','aria-hidden':'true'}),
      el('span',{class:'native-name',text:agent.name||t('子代理')}),
      el('span',{class:'native-preview',text:firstLine(agent.task||agent.activity)}),
      el('small',{class:'native-status '+agent.status,text:t(agent.status==='running'?'正在思考':names[agent.status]||names.unknown)}),duration(view,agent)]);
    return disclosure(view,key,{class:'native-item workflow-agent','data-subagent-id':agent.id,'data-status':agent.status},title,node=>{
      const body=el('div',{class:'workflow-agent-body'});
      if(agent.depth>0)body.append(el('small',{class:'subagent-parent',text:t('由子任务派发')}));
      if(agent.task)body.append(el('p',{class:'subagent-task',text:agent.task}));
      if(agent.activity)body.append(el('p',{class:'subagent-activity',text:t('最新操作：{activity}',{activity:agent.activity})}));
      if(agent.updatedAt)body.append(el('small',{class:'subagent-updated','data-updated':agent.updatedAt}));
      if(agent.status==='unknown')body.append(el('p',{class:'native-empty',text:t('未收到明确的完成状态')}));
      if(!agent.records.length)body.append(el('p',{class:'native-empty',text:t('原工具未提供该子任务的详细过程。')}));
      for(const item of agent.records)body.append(record(view,item,view.scope+':agent:'+agent.id));
      for(const child of agent.children)body.append(agentView(view,child));
      node.append(body);
    },views.get(key,view.level==='full'));
  }
  // The process itself: a heading kept in place and changed as the reply runs, and its rows, drawn
  // once it is open.
  function workflow(view,message,key,open,compacting){
    const {el,t}=view.options;
    const agentCount=agent=>1+agent.children.reduce((total,child)=>total+agentCount(child),0);
    const entries=view.entries,running=message.status==='running',waiting=running&&model.rows(message).some(row=>model.status(row,message)==='pending'),count=entries.filter(entry=>entry.type==='record').length,agents=entries.filter(entry=>entry.type==='agent').reduce((total,entry)=>total+agentCount(entry.agent),0);
    const glyph='native-glyph '+(running?'running':message.status==='error'?'error':''),sign=running?'◌':'◇';
    const label=t(waiting?'等待批准':compacting?'正在压缩上下文…':running?'正在思考':'查看任务过程');
    const counts=[count?t('{count} 个步骤',{count}):'',agents?t('{count} 个子任务',{count:agents}):''].filter(Boolean).join(' · ');
    const start=Date.parse(message.created),end=message.details?.endedAt;
    let flow=view.workflow;
    if(!flow){
      flow={glyph:el('span',{class:glyph,text:sign,'aria-hidden':'true'}),label:el('span',{class:'workflow-label',text:label}),count:el('span',{class:'workflow-count',text:counts}),
        duration:el('span',{class:'workflow-duration','data-start':start,'data-end':end,'data-status':message.status}),body:null};
      const summary=el('summary',{class:'workflow-heading'},[flow.glyph,flow.label,flow.count,flow.duration]);summary.dataset.activityFocus=key;
      flow.node=el('details',{class:'native-workflow','data-level':view.level,'data-status':message.status,'data-disclosure-key':key},[summary]);
      if(view.options.collapseButton){
        flow.collapse=el('button',{type:'button',class:'room-text-action workflow-collapse',text:t('收起'),
          'aria-label':t('收起详细工作流程'),'data-activity-focus':key+':collapse'});
        flow.collapse.onclick=()=>{
          views.set(key,false);
          flow.node.open=false;
          summary.focus();
        };
      }
      flow.node.ontoggle=()=>{if(flow.node.isConnected){views.set(key,flow.node.open);if(flow.node.open&&view.workflow===flow)fill(view);}};
      view.workflow=flow;
    }else{
      if(flow.glyph.className!==glyph)flow.glyph.className=glyph;
      setText(flow.glyph,sign);setText(flow.label,label);setText(flow.count,counts);
      setData(flow.duration,'start',start);setData(flow.duration,'end',end);setData(flow.duration,'status',message.status);
      setData(flow.node,'status',message.status);
    }
    flow.compacting=compacting;
    if(flow.node.open!==open)flow.node.open=open;
    // Rows of a closed process are drawn again when it opens.
    if(flow.node.open)fill(view);else if(flow.body){flow.body.remove();flow.body=null;view.rows=new Map();}
    return flow.node;
  }
  function fill(view){
    const flow=view.workflow;if(!flow)return;
    const {el,t,lead,pending,onOpen}=view.options,message=view.message,entries=view.entries,running=message.status==='running',workflowKey=view.scope+':workflow';
    if(!flow.body){
      onOpen?.();
      flow.body=el('div',{class:'workflow-body'});
      const modes=el('div',{class:'workflow-view-switch','aria-label':t('执行过程显示')});
      for(const [value,label]of [['overview','概览'],['full','完整']]){
        const button=el('button',{type:'button',text:t(label),'aria-pressed':String(view.level===value),'data-activity-focus':workflowKey+':'+value});
        button.onclick=()=>{setLevel(value);views.set(workflowKey,true);renderMessages();};modes.append(button);
      }
      flow.head=[modes,...lead?.()||[]];
      flow.node.append(flow.body);
    }
    const rows=new Map(),nodes=[...flow.head];
    if(pending)nodes.push(keyed(view.rows,rows,'pending','',()=>el('p',{class:'workflow-thinking',role:'status'},[el('span',{class:'native-glyph running',text:'◌','aria-hidden':'true'}),t('正在读取…')])));
    else for(const entry of entries)nodes.push(entry.type==='agent'
      ?keyed(view.rows,rows,'agent:'+entry.agent.id,agentSig(entry.agent,message),()=>agentView(view,entry.agent))
      :keyed(view.rows,rows,'record:'+entry.record.id,oid(entry.record)+':'+model.status(entry.record,message),()=>record(view,entry.record)));
    if(lead&&!pending&&!running&&!entries.length)nodes.push(keyed(view.rows,rows,'empty','',()=>el('p',{class:'native-empty',text:t('这一轮没有工具调用或思考记录。')})));
    if(running&&!pending&&!entries.some(entry=>entry.type==='agent'?entry.agent.status==='running':['running','pending','paused'].includes(model.status(entry.record,message))))
      nodes.push(keyed(view.rows,rows,'thinking',String(flow.compacting),()=>el('p',{class:'workflow-thinking',role:'status'},[el('span',{class:'native-glyph running',text:'◌','aria-hidden':'true'}),t(flow.compacting?'正在压缩上下文…':'正在思考')])));
    if(!message.details?.activity?.length&&message.details?.tools?.length)nodes.push(keyed(view.rows,rows,'history','',()=>el('small',{class:'native-history-note',text:t('旧记录未保存完整过程，显示已有工具记录。')})));
    if(flow.collapse)nodes.push(flow.collapse);
    view.rows=rows;place(flow.body,nodes);
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
      setText(node,Number.isFinite(start)&&Number.isFinite(end)&&end>=start?formatDuration((end-start)/1000):'');
    }
  }
  globalThis.StarportActivity={render,update,remember,restoreFocus,preference,setLevel,tick,status:model.status};
})();

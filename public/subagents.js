'use strict';
globalThis.StarportSubagents=(()=>{
  const expanded=new Map();
  const labels={running:'进行中',complete:'已完成',error:'失败',interrupted:'已停止',unknown:'状态未确认'};
  function rows(message){return (message?.details?.subagents||[]).map(row=>row.status==='running'&&message.status!=='running'?{...row,status:message.status==='interrupted'?'interrupted':'unknown',endedAt:row.endedAt??row.updatedAt}:row);}
  function summary(items){
    const count=status=>items.filter(row=>row.status===status).length;
    const parts=[t('子任务 · 运行中 {running} · 已完成 {done}',{running:count('running'),done:count('complete')})];
    for(const status of ['error','interrupted','unknown'])if(count(status))parts.push(t(labels[status])+' '+count(status));
    return parts.join(' · ');
  }
  function duration(row){
    const end=row.status==='running'?Date.now():row.endedAt??row.updatedAt??row.startedAt;
    return t(row.status==='running'?'已运行 {time}':'耗时 {time}',{time:formatDuration(Math.max(0,(end-row.startedAt)/1000))});
  }
  function render(message){
    const items=rows(message);if(!items.length)return null;
    const section=el('section',{class:'message-subagents','aria-label':t('子任务')},[
      el('h3',{class:'subagent-summary',text:summary(items)})]);
    for(const row of items){
      const key=message.id+':'+row.id;
      const details=el('details',{class:'subagent-row','data-subagent-id':row.id,...((expanded.get(key)??row.status==='running')?{open:true}:{})});
      const head=el('summary',{class:'subagent-heading'},[
        el('span',{class:'subagent-name',text:row.name||t('子任务')}),
        el('span',{class:'subagent-status '+row.status,text:t(labels[row.status]||labels.unknown)}),
        el('span',{class:'subagent-duration',text:duration(row),'data-start':row.startedAt,'data-end':row.endedAt??row.updatedAt??row.startedAt,'data-status':row.status})]);
      details.append(head);
      if(row.depth>0)details.append(el('small',{class:'subagent-parent',text:t('由子任务派发')}));
      details.append(el('p',{class:'subagent-task',text:row.task||t('尚未收到任务说明')}));
      if(row.activity)details.append(el('p',{class:'subagent-activity',text:t('最新操作：{activity}',{activity:row.activity})}));
      const updated=el('small',{class:'subagent-updated','data-updated':row.updatedAt});details.append(updated);
      if(row.status==='unknown')details.append(el('small',{class:'subagent-uncertain',text:t('未收到明确的完成状态')}));
      details.addEventListener('toggle',()=>expanded.set(key,details.open));
      section.append(details);
    }
    return section;
  }
  function tick(){
    globalThis.StarportActivity?.tick();globalThis.StarportWorkflows?.tick();
    for(const span of document.querySelectorAll('.subagent-duration'))span.textContent=duration({startedAt:Number(span.dataset.start),endedAt:Number(span.dataset.end),status:span.dataset.status});
    for(const span of document.querySelectorAll('.subagent-updated'))span.textContent=t('最后活动：{time}',{time:new Date(Number(span.dataset.updated)).toLocaleTimeString(i18n.locale)});
    if(state.run)$('#run-status').textContent=runStatusLine(state.run);
  }
  setInterval(tick,1000);
  return {render,summary,rows,tick};
})();

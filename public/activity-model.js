'use strict';
globalThis.StarportActivityModel=(()=>{
  const levels=['hidden','overview','full'],key='starport-activity-level';
  let level='overview';try{const saved=localStorage.getItem(key);if(levels.includes(saved))level=saved;}catch{}
  function setLevel(value){if(!levels.includes(value))return;level=value;try{localStorage.setItem(key,value);}catch{}}
  function status(item,message){
    let value=item.status;
    if(item.kind==='plan'&&item.plan?.length)value=item.plan.some(step=>step.status==='inProgress')?'running':item.plan.every(step=>step.status==='completed')?'complete':'unknown';
    return ['running','pending','paused'].includes(value)&&message.status!=='running'?(message.status==='interrupted'?'interrupted':'unknown'):value||'unknown';
  }
  const normalize=value=>String(value||'').replace(/\s+/g,' ').trim();
  function rows(message){return message.details?.activity?.length?message.details.activity:message.details?.tools||[];}
  function answer(message){
    const all=rows(message),texts=all.filter(row=>row.kind==='text'&&!row.scope&&row.text);
    if(message.status!=='running'&&typeof message.details?.finalAnswer==='string')
      return {text:message.details.finalAnswer,ids:texts.filter(row=>normalize(row.text)===normalize(message.details.finalAnswer)).map(row=>row.id)};
    const explicit=texts.filter(row=>row.phase==='final_answer');
    if(explicit.length){
      const last=explicit.at(-1);let final=explicit;
      if(last.turnId)final=explicit.filter(row=>row.turnId===last.turnId);
      else{
        const end=all.indexOf(last);let start=end;
        while(start>0&&(all[start-1].scope||all[start-1].kind==='text'&&all[start-1].phase==='final_answer'))start--;
        final=all.slice(start,end+1).filter(row=>row.kind==='text'&&!row.scope&&row.phase==='final_answer');
      }
      return {text:final.map(row=>row.text).join('\n\n'),ids:final.map(row=>row.id)};
    }
    if(!texts.length)return {text:message.content||'',ids:[]};
    const saved=normalize(message.content),combined=texts.map(row=>row.text);
    // Honor an authoritative replacement, which may differ from commentary.
    if(saved&&saved!==normalize(combined.join('\n\n'))&&saved!==normalize(combined.join('')))
      return {text:message.content,ids:texts.filter(row=>normalize(row.text)===saved).map(row=>row.id)};
    let boundary=-1;
    all.forEach((row,index)=>{if(!row.scope&&row.kind!=='text')boundary=index;});
    let tail=all.slice(boundary+1).filter(row=>row.kind==='text'&&!row.scope&&row.text);
    // Late tool metadata may follow a multi-block final response. Preserve
    // the saved text when a legacy record has no reliable final boundary.
    if(boundary>=0&&!tail.length)return {text:message.content||combined.join('\n\n'),ids:texts.map(row=>row.id)};
    if(boundary<0||!tail.length)tail=texts.slice(-1);
    return {text:tail.map(row=>row.text).join('\n\n'),ids:tail.map(row=>row.id)};
  }
  function entries(message){
    const all=rows(message),final=new Set(answer(message).ids),agents=new Map(),scopes=new Map();
    for(const original of message.details?.subagents||[]){
      const agent={...original,status:status(original,message),records:[],children:[],order:Infinity};
      agents.set(agent.id,agent);scopes.set(agent.id,agent.id);if(agent.scope)scopes.set(agent.scope,agent.id);
    }
    const main=[];
    all.forEach((record,index)=>{
      let id=record.scope?scopes.get(record.scope)||record.scope:null;
      if(!id)for(const agent of agents.values())if(record.id==='claude-task:'+agent.id||record.id===agent.scope){id=agent.id;break;}
      if(id){
        if(!agents.has(id)){agents.set(id,{id,status:message.status==='running'?'running':message.status==='interrupted'?'interrupted':'unknown',records:[],children:[],order:index});scopes.set(id,id);}
        const agent=agents.get(id);agent.order=Math.min(agent.order,index);agent.records.push(record);
      }else if(!final.has(record.id))main.push({type:'record',record,order:index,key:record.id});
    });
    const children=new Set();
    for(const agent of agents.values()){
      const parent=agents.get(agent.parentId)||agents.get(scopes.get(agent.parentId));
      let cursor=parent,visited=new Set([agent.id]);
      while(cursor&&!visited.has(cursor.id)){visited.add(cursor.id);cursor=agents.get(cursor.parentId);}
      if(parent&&!cursor){parent.children.push(agent);children.add(agent.id);}
    }
    return [...main,...[...agents.values()].filter(agent=>!children.has(agent.id)).map(agent=>({type:'agent',agent,key:'agent:'+agent.id,order:agent.order}))].sort((a,b)=>a.order-b.order);
  }
  class DisclosureState {
    constructor(){this.opened=new Map();this.running=new Map();}
    root(key,messageStatus){
      const running=messageStatus==='running',previous=this.running.get(key);
      if(previous===true&&!running)this.opened.set(key,false);
      this.running.set(key,running);return this.opened.get(key)??running;
    }
    set(key,value){this.opened.set(key,!!value);}
    get(key,fallback=false){return this.opened.get(key)??fallback;}
  }
  return {rows,answer,entries,status,setLevel,get level(){return level;},DisclosureState};
})();

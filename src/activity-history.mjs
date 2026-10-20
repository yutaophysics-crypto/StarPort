import { mergeActivity, settleActivity } from './activity.mjs';

// Recovery requires a unique match inside the already-bound native session.
// Text and tool ids are anchors only; historical approvals are never replayed.
export function recoverActivity(message,source) {
  const groups=[];let group=[];
  for(const row of source.messages||[]){
    if(row.role==='user'){if(group.length)groups.push(group);group=[];}
    else group.push(row);
  }
  if(group.length)groups.push(group);
  const ids=new Set((message.details.tools||[]).map(row=>row.id));
  const normalize=text=>String(text||'').replace(/\s+/g,' ').trim();
  const candidates=groups.filter(rows=>{
    if(rows.some(row=>(row.details.activity||[]).some(item=>ids.has(item.id))))return true;
    return !!normalize(message.content)&&rows.some(row=>normalize(row.content)===normalize(message.content));
  });
  if(candidates.length!==1)return null;
  const activity=[];
  for(const row of candidates[0])for(const item of row.details.activity||[])mergeActivity(activity,{type:'activity',item});
  settleActivity({activity},message.status);return activity.length?activity:null;
}

export class ActivityHistory {
  constructor(importer){this.importer=importer;this.cache=new Map();}
  async read(provider,id){
    const key=provider+':'+id,old=this.cache.get(key);
    if(old&&Date.now()-old.time<60000)return old.promise;
    const promise=this.importer.read(provider,id);this.cache.set(key,{time:Date.now(),promise});
    // Bound cached transcript copies; the native source and Starport record remain intact.
    if(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
}

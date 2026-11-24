// A running reply grows a little at a time, but a long one runs to megabytes, and pushing it whole
// on every step kept the page parsing and redrawing it all the time. Once pages have the reply,
// pushes carry only what changed since the last push: new or changed process rows, the added text
// and the other fields that changed. A page applies a push to the copy it has (public/live.js) and
// reads the whole reply again when its copy is older than the push's starting point.
const LISTS=['activity','tools'];

export class LivePatch {
  constructor(message){this.message=message;this.base=null;this.dirty={activity:new Set(),tools:new Set()};this.reset=false;}
  // A process row the runner added or changed.
  touch(list,id){if(id!=null)this.dirty[list]?.add(id);}
  // The text was replaced rather than added to, so the next push carries all of it.
  replaced(){this.reset=true;}
  // The whole reply went out: later pushes describe changes from here.
  sent(){
    const {details}=this.message,keys=new Map();
    for(const [key,value] of Object.entries(details))if(!LISTS.includes(key))keys.set(key,JSON.stringify(value));
    this.base={revision:details.liveRevision,content:this.message.content,keys,ids:Object.fromEntries(LISTS.map(name=>[name,(details[name]||[]).map(row=>row.id)]))};
    for(const set of Object.values(this.dirty))set.clear();
    this.reset=false;
  }
  // What changed since the last push, or null before the reply first went out. Reading it changes
  // nothing, so /api/live can answer a page from it too.
  diff(){
    const base=this.base;if(!base)return null;
    const {details,content}=this.message,{details:_,content:__,...fields}=this.message,changed={},unset=[],lists={};
    for(const [key,value] of Object.entries(details))if(!LISTS.includes(key)&&base.keys.get(key)!==JSON.stringify(value))changed[key]=value;
    for(const key of base.keys.keys())if(!Object.hasOwn(details,key))unset.push(key);
    for(const name of LISTS){
      const rows=details[name]||[],before=base.ids[name],dirty=this.dirty[name];
      // Rows are mostly added at the end; one put in front of another sends the new order too.
      const appended=before.length<=rows.length&&before.every((id,index)=>rows[index].id===id);
      const known=appended?null:new Set(before);
      const list=rows.filter((row,index)=>dirty.has(row.id)||(appended?index>=before.length:!known.has(row.id)));
      if(list.length||rows.length!==before.length||!appended)lists[name]={n:rows.length,rows:list,...appended?{}:{ids:rows.map(row=>row.id)}};
    }
    const added=!this.reset&&content.startsWith(base.content);
    return {id:this.message.id,base:base.revision,revision:details.liveRevision,fields,
      content:added?{at:base.content.length,text:content.slice(base.content.length)}:{at:0,text:content},
      ...Object.keys(changed).length?{details:changed}:{},...unset.length?{unset}:{},...Object.keys(lists).length?{lists}:{}};
  }
  // The push to send now; the whole reply when pages have not had it yet.
  next(){const patch=this.diff();this.sent();return patch;}
}

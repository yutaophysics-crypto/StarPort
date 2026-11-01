import { redact } from './process.mjs';

// Stable native ids reconcile streamed deltas with authoritative final items.
// Never infer tool success merely because the surrounding turn has ended.
// event.before: a new row goes in front of that row, for a record that arrives after its step.
export function mergeActivity(rows, event) {
  const source=event.type==='tool'?{...event,kind:event.kind==='step'?'step':'tool'}:event.item;
  if(!source?.id)return;
  const item=JSON.parse(redact(JSON.stringify(source)));delete item.type;delete item.before;
  let row=rows.find(value=>value.id===item.id);
  if(!row){
    row={id:item.id};
    const at=event.before?rows.findIndex(value=>value.id===event.before):-1;
    if(at<0)rows.push(row);else rows.splice(at,0,row);
  }
  if(row.status==='denied'&&item.status==='error')item.status='denied';
  for(const [key,value] of Object.entries(item))if(value!==undefined)row[key]=value;
  if(typeof event.delta==='string'){
    const field=event.field||'text';
    row[field]=(row[field]||'')+redact(event.delta);
  }
  return row;
}

export function settleActivity(details,status) {
  for(const rows of [details.activity||[],details.tools||[]])for(const row of rows){
    if(['running','pending','paused'].includes(row.status))row.status=status==='interrupted'?'interrupted':'unknown';
  }
}

export function nativeStatus(value,done=false,failed=false) {
  const status=String(value||'').toLowerCase();
  if(failed||['failed','error','failure'].includes(status))return 'error';
  if(['declined','denied','rejected'].includes(status))return 'denied';
  if(['interrupted','cancelled','canceled','aborted','stopped','killed'].includes(status))return 'interrupted';
  if(['pending','paused','unknown'].includes(status))return status;
  if(['completed','complete','done','success','succeeded'].includes(status))return 'complete';
  return done?'complete':'running';
}

export function blockText(content) {
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return content==null?'':JSON.stringify(content,null,2);
  return content.map(block=>block.type==='text'?block.text||'':block.type==='image'?'[image]':JSON.stringify(block,null,2)).join('\n');
}

// Small helpers shared by the workflow modules.
import { randomUUID } from 'node:crypto';

export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const now=()=>new Date().toISOString();
export const newId=prefix=>prefix+randomUUID().replace(/-/g,'').slice(0,12);
export const clip=(value,max)=>{const text=String(value??'');return text.length>max?text.slice(0,max)+'…':text;};
export const tail=(value,max)=>{const text=String(value??'');return text.length>max?'…'+text.slice(-max):text;};
export const oneLine=value=>String(value??'').replace(/```[\s\S]*?```/g,' ').replace(/[#>*`_|]/g,'').replace(/\s+/g,' ').trim();
export const sleep=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.();});
export const localTime=value=>new Date(value).toLocaleString('zh-CN',{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

// A user-supplied text field: trimmed, length-checked, optionally required.
export function text(value,max,label,required=false){
  if(value==null)value='';
  if(typeof value!=='string'||value.length>max)throw fail(`${label}格式无效（最多 ${max} 字）`);
  value=value.trim();if(required&&!value)throw fail(`请填写${label}`);
  return value;
}
export const slug=(value,prefix)=>typeof value==='string'&&/^[\w-]{1,40}$/.test(value)?value:newId(prefix);

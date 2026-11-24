import { randomUUID } from 'node:crypto';
import { contextSample } from '../context.mjs';

// Ollama runs on this machine and keeps no conversation state between requests:
// every turn is one /api/chat call, and Starport's own record supplies earlier context.
export function ollamaHost(env){
  let host=String(env?.OLLAMA_HOST||process.env.OLLAMA_HOST||'').trim();
  if(!host)return 'http://127.0.0.1:11434';
  if(!/^https?:\/\//i.test(host))host='http://'+host;
  const url=new URL(host);
  // A server bound to every interface is still reached through loopback.
  if(['0.0.0.0','[::]'].includes(url.hostname))url.hostname='127.0.0.1';
  if(!url.port&&url.protocol==='http:')url.port='11434';
  return url.origin;
}

const unreachable=()=>Object.assign(new Error('连不上本机 Ollama 服务。请先打开 Ollama 应用，或在终端运行 ollama serve。'),{status:503});
export async function ollamaRequest(host,path,{body,signal,timeout=15000}={}){
  const timer=AbortSignal.timeout(timeout),combined=signal?AbortSignal.any([signal,timer]):timer;
  let response;
  try{response=await fetch(host+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:combined});}
  catch(error){if(signal?.aborted)throw error;throw unreachable();}
  if(!response.ok){
    let message='';try{message=(await response.json()).error||'';}catch{}
    throw ollamaError(message||`Ollama 返回 HTTP ${response.status}`);
  }
  return response.json();
}
export function ollamaError(message){
  const missing=/model ['"]?([^'"]+?)['"]? not found/i.exec(message);
  if(missing)return new Error(`本机 Ollama 里没有模型 ${missing[1]}。请先在终端运行 ollama pull ${missing[1]}。`);
  return new Error('Ollama：'+message);
}

// Thinking models take on/off; gpt-oss also takes a level.
export function ollamaEffortLevels(name,capabilities=[]){
  if(!capabilities.includes('thinking'))return [];
  return /gpt-oss/i.test(name)?['low','medium','high']:['off','on'];
}
export function ollamaThink(effort){
  if(!effort)return undefined;
  return effort==='off'?false:effort==='on'?true:effort;
}
export function contextLength(info){
  for(const [key,value] of Object.entries(info?.model_info||{}))if(key.endsWith('.context_length')&&Number.isSafeInteger(value)&&value>0)return value;
  return null;
}
// Fixed steps, so a conversation rarely makes Ollama reload the model with a new window.
export function contextWindow(prompt,limit){
  const estimate=Math.ceil(Buffer.byteLength(prompt)/3)+4096;
  let size=8192;while(size<estimate)size*=2;
  return limit?Math.min(size,limit):size;
}

export async function ollamaModels(host,signal){
  const {models=[]}=await ollamaRequest(host,'/api/tags',{signal});
  return Promise.all(models.map(async row=>{
    let capabilities=[];
    try{capabilities=(await ollamaRequest(host,'/api/show',{body:{model:row.name},signal})).capabilities||[];}catch{}
    const size=row.details?.parameter_size,levels=ollamaEffortLevels(row.name,capabilities);
    return {id:row.name,label:size?`${row.name} · ${size}`:row.name,effortLevels:levels};
  }));
}

export async function runOllama({runtime,options,prompt,images=[],signal,emit,setControl}){
  const host=ollamaHost(runtime?.env),controller=new AbortController();
  let canceled=false;
  const stop=async()=>{canceled=true;controller.abort();};
  const onAbort=()=>{stop();};
  signal?.addEventListener('abort',onAbort,{once:true});
  setControl?.({stop});
  try{
    if(signal?.aborted)throw Object.assign(new Error('已停止'),{canceled:true});
    let model=options.model;
    if(!model){
      const {models=[]}=await ollamaRequest(host,'/api/tags',{signal:controller.signal});
      model=models[0]?.name;
      if(!model)throw new Error('本机 Ollama 里还没有模型。请先在终端运行 ollama pull <模型名>，例如 ollama pull qwen3:4b。');
    }
    const info=await ollamaRequest(host,'/api/show',{body:{model},signal:controller.signal});
    const think=info.capabilities?.includes('thinking')?ollamaThink(options.effort):undefined;
    const num_ctx=contextWindow(prompt,contextLength(info));
    emit({type:'session',id:'ollama-'+randomUUID(),model});
    const message={role:'user',content:prompt,...images.length?{images:images.map(image=>image.data)}:{}};
    let response;
    try{
      response=await fetch(host+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,
        body:JSON.stringify({model,messages:[message],stream:true,...think===undefined?{}:{think},options:{num_ctx}})});
    }catch(error){if(canceled)throw error;throw unreachable();}
    if(!response.ok){let text='';try{text=(await response.json()).error||'';}catch{}throw ollamaError(text||`Ollama 返回 HTTP ${response.status}`);}
    let answer='',thinking='',buffer='',done=null;const decoder=new TextDecoder(),thoughtId='ollama-thinking';
    const handle=line=>{
      if(!line.trim())return;
      const chunk=JSON.parse(line);
      if(chunk.error)throw ollamaError(chunk.error);
      const part=chunk.message||{};
      if(part.thinking){thinking+=part.thinking;emit({type:'activity',item:{id:thoughtId,kind:'thinking',text:thinking,status:'running'}});}
      if(part.content){answer+=part.content;emit({type:'delta',text:part.content});}
      if(chunk.done)done=chunk;
    };
    for await(const bytes of response.body){
      buffer+=decoder.decode(bytes,{stream:true});
      const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines)handle(line);
    }
    handle(buffer+decoder.decode());
    if(thinking)emit({type:'activity',item:{id:thoughtId,kind:'thinking',text:thinking,status:'complete'}});
    if(!done)throw new Error('Ollama 回复意外中断');
    const input=done.prompt_eval_count??null,output=done.eval_count??null;
    if(input!==null||output!==null){
      emit({type:'usage',usage:{input_tokens:input,output_tokens:output}});
      if(input!==null)emit({type:'context',context:contextSample({usedTokens:input+(output||0),windowTokens:num_ctx,model,basis:'ollama-request'})});
    }
    emit({type:'final-answer',text:answer});
  }catch(error){if(canceled||signal?.aborted)error.canceled=true;throw error;}
  finally{signal?.removeEventListener('abort',onAbort);}
}

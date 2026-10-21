import { connectCodex } from './adapters/codex.mjs';
import { claudeControl } from './claude-control.mjs';

const positive=value=>Number.isSafeInteger(value)&&value>0?value:null;

// Read only native metadata: no model prompt, transcript resume, or config writes.
export async function readContextLimits(provider,runtime,cwd,model,{connect=connectCodex,control=claudeControl}={}){
  if(provider==='codex'){
    const rpc=await connect(runtime,cwd,{env:runtime.env,initializeTimeoutMs:12000});
    try{
      const {config={}}=await rpc.request('config/read',{cwd,includeLayers:false},12000);
      return {nativeWindowTokens:positive(config.model_context_window),
        nativeAutoCompactTokens:positive(config.model_auto_compact_token_limit),
        autoCompactScope:config.model_auto_compact_token_limit_scope||'total'};
    }finally{await rpc.close();}
  }
  if(provider==='claude')return control(runtime,cwd,async session=>{
    if(typeof session.getContextUsage!=='function')throw new Error('Context metadata unavailable');
    // Summary avoids token-count API calls. This NEW metadata session's usage
    // must never replace the real conversation's per-request input counters.
    const report=await session.getContextUsage({detail:'summary'});
    if(!positive(report.rawMaxTokens))throw new Error('Context metadata unavailable');
    return {nativeWindowTokens:null,nativeAutoCompactTokens:report.rawMaxTokens,autoCompactScope:'total'};
  },undefined,15000,{model});
  return {};
}

export class ContextLimits {
  constructor({read=readContextLimits,now=Date.now,ttl=30000}={}){this.read=read;this.now=now;this.ttl=ttl;this.cache=new Map();}
  key(provider,runtime,cwd,model){return JSON.stringify([provider,runtime,cwd,model||'']);}
  peek(provider,runtime,cwd,model){return this.cache.get(this.key(provider,runtime,cwd,model))?.value||{status:'waiting'};}
  get(provider,runtime,cwd,model,refresh=false){
    if(!runtime||!['codex','claude'].includes(provider))return Promise.resolve({status:'unavailable'});
    const key=this.key(provider,runtime,cwd,model),saved=this.cache.get(key);
    if(saved?.pending)return saved.pending;
    if(!refresh&&saved&&this.now()-saved.at<this.ttl)return Promise.resolve(saved.value);
    const entry={...saved};this.cache.delete(key);this.cache.set(key,entry);
    entry.pending=(async()=>{
      try{entry.value={...await this.read(provider,runtime,cwd,model),status:'ready'};}
      catch{entry.value={status:'error'};} // Do not expose native config/errors containing secrets.
      entry.at=this.now();entry.pending=null;
      while(this.cache.size>64){const victim=[...this.cache].find(([id,row])=>id!==key&&!row.pending);if(!victim)break;this.cache.delete(victim[0]);}
      return entry.value;
    })();return entry.pending;
  }
}

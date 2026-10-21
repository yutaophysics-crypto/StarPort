import { createHash } from 'node:crypto';
import { MEMORY_RECALL_POLICY } from './memory-relevance.mjs';
import { HISTORY_CONTEXT_POLICY } from './history-context.mjs';

const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
export function contextSample({usedTokens,windowTokens,model=null,basis,status='ready'}) {
  const used=count(usedTokens),capacity=count(windowTokens);
  return {status:status==='ready'&&used===null?'waiting':status,usedTokens:used,modelWindowTokens:capacity>0?capacity:null,windowTokens:capacity>0?capacity:null,
    percent:used!==null&&capacity>0?used/capacity*100:null,model,basis,updatedAt:new Date().toISOString()};
}
// Project raw native counters onto the current limits. Never persist the
// effective denominator as if it were the native model's physical window.
export function effectiveContext(sample,starportTokens,native={status:'unavailable'}){
  const positive=value=>count(value)>0?value:null;
  const modelWindowTokens=positive(Object.hasOwn(sample,'modelWindowTokens')?sample.modelWindowTokens:sample.windowTokens);
  const limits={starportTokens:positive(starportTokens),modelWindowTokens,
    nativeWindowTokens:positive(native.nativeWindowTokens),nativeAutoCompactTokens:positive(native.nativeAutoCompactTokens),
    autoCompactScope:native.autoCompactScope||'total',status:native.status||'unavailable'};
  const comparable=Object.entries(limits).filter(([key,value])=>key.endsWith('Tokens')&&positive(value)&&
    (key!=='nativeAutoCompactTokens'||limits.autoCompactScope==='total'));
  const windowTokens=comparable.length?Math.min(...comparable.map(([,value])=>value)):null;
  return {...sample,modelWindowTokens,windowTokens,limits,
    limitSources:comparable.filter(([,value])=>value===windowTokens).map(([key])=>key),
    percent:sample.usedTokens!=null&&windowTokens&&sample.status==='ready'?sample.usedTokens/windowTokens*100:null};
}
export function codexContext(usage,model) {
  // `total` is cumulative billing usage. `last` describes the latest request.
  return contextSample({usedTokens:usage?.last?.totalTokens,windowTokens:usage?.modelContextWindow,model,basis:'codex-last'});
}
export function claudeContext(usage,windowTokens,model) {
  // Same input-only formula as Claude Code's native status-line used_percentage.
  const input=count(usage?.input_tokens),read=count(usage?.cache_read_input_tokens??0),write=count(usage?.cache_creation_input_tokens??0);
  return contextSample({usedTokens:input!==null&&read!==null&&write!==null?input+read+write:null,windowTokens,model,basis:'claude-input'});
}
export function sessionFingerprint(runtime,chat,options,memoryEpoch=0,instructionFingerprint='') {
  return createHash('sha256').update(JSON.stringify({runtime,workspace:chat.workspace,worktree:options.worktree||false,memoryPolicy:MEMORY_RECALL_POLICY,historyPolicy:HISTORY_CONTEXT_POLICY,...memoryEpoch?{memoryEpoch}:{},...instructionFingerprint?{projectId:chat.project_id||null,instructionFingerprint}:{}})).digest('hex');
}
export function contextBinding(chat,options) {
  return JSON.stringify([chat.provider,chat.workspace,options.worktree||false,options.model||'',options.provider||'']);
}
export function emptyContext(provider) {
  return {status:['codex','claude'].includes(provider)?'waiting':'unavailable',usedTokens:null,windowTokens:null,percent:null};
}

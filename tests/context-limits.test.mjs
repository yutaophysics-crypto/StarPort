import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {contextSample,effectiveContext} from '../src/context.mjs';
import {ContextLimits,readContextLimits} from '../src/context-limits.mjs';
import {claudeControl} from '../src/claude-control.mjs';
import {createHub} from '../src/server.mjs';

test('percentage uses the reported model window independently of handoff and compaction settings',()=>{
  const sample=contextSample({usedTokens:203000,windowTokens:1000000,basis:'claude-input'});
  const native={status:'ready',nativeAutoCompactTokens:300000,nativeWindowTokens:500000};
  const value=effectiveContext(sample,400000,native);
  assert.equal(value.percent,20.3);assert.equal(value.windowTokens,1000000);
  assert.equal(value.modelWindowTokens,1000000);assert.deepEqual(value.limitSources,['modelWindowTokens']);
  const smaller=effectiveContext(value,100000,native);
  assert.equal(smaller.percent,20.3);assert.equal(smaller.modelWindowTokens,1000000);
  assert.equal(smaller.limits.starportTokens,100000);
  assert.ok(Math.abs(sample.percent-20.3)<1e-10); // Original persisted sample is untouched.
  assert.equal(effectiveContext(sample,800000,{nativeWindowTokens:200000}).windowTokens,1000000);
  assert.equal(effectiveContext(sample,2000000,native).windowTokens,1000000);
  assert.equal(effectiveContext({...sample,windowTokens:123,modelWindowTokens:0},null,{}).percent,null);
});

test('unknown limits, scoped growth, compacting and zero usage do not invent a percentage',()=>{
  const sample=contextSample({usedTokens:0,windowTokens:1000000});
  assert.equal(effectiveContext(sample,100000,{nativeAutoCompactTokens:0}).percent,0);
  const growth=effectiveContext({...sample,usedTokens:50000},200000,{nativeAutoCompactTokens:100000,autoCompactScope:'body_after_prefix'});
  assert.equal(growth.percent,5);assert.equal(growth.limits.nativeAutoCompactTokens,100000);
  assert.equal(effectiveContext(contextSample({status:'compacting'}),100000).percent,null);
  assert.equal(effectiveContext(contextSample({usedTokens:5}),NaN,{nativeWindowTokens:'100000'}).windowTokens,null);
  const unknown=effectiveContext(contextSample({usedTokens:50000}),200000,{nativeWindowTokens:500000,nativeAutoCompactTokens:300000});
  assert.equal(unknown.usedTokens,50000);assert.equal(unknown.windowTokens,null);assert.equal(unknown.percent,null);
  const transport=effectiveContext(contextSample({status:'unavailable'}),200000,{},184000);
  assert.equal(transport.percent,null);assert.equal(transport.limits.starportBytes,184000);
});

test('inconsistent raw usage is retained for diagnosis without displaying an impossible percentage',()=>{
  const sample=contextSample({usedTokens:200001,windowTokens:200000});
  assert.equal(sample.status,'inconsistent');assert.equal(sample.percent,null);assert.equal(sample.usedTokens,200001);
  const legacy=effectiveContext({...sample,status:'ready',percent:100.0005},80000);
  assert.equal(legacy.status,'inconsistent');assert.equal(legacy.percent,null);
  assert.equal(effectiveContext({...legacy,modelWindowTokens:1000000},80000).status,'ready');
});

test('Codex reads effective layered settings in the chat workspace and only returns allowed numeric fields',async()=>{
  let closed=0;const calls=[];
  const connect=async(runtime,cwd,options)=>{assert.equal(cwd,'fictional-workspace');assert.equal(options.initializeTimeoutMs,12000);return{
    request:async(method,params)=>{calls.push({method,params});return {config:{model_context_window:900000,model_auto_compact_token_limit:250000,secret:'fictional-secret'}};},
    close:async()=>closed++};};
  const value=await readContextLimits('codex',{command:'fake'},'fictional-workspace','test',{connect});
  assert.deepEqual(value,{nativeWindowTokens:900000,nativeAutoCompactTokens:250000,autoCompactScope:'total',compactionKind:'threshold'});
  assert.deepEqual(calls,[{method:'config/read',params:{cwd:'fictional-workspace',includeLayers:false}}]);assert.equal(closed,1);
  await assert.rejects(readContextLimits('codex',{},'',null,{connect:async()=>({request:async()=>{throw Error('fail');},close:async()=>closed++})}));
  assert.equal(closed,2);
});

test('Claude obtains resolved compaction policy for the selected model without using the metadata session usage',async()=>{
  let options,closed=0;
  const query=({options:opts})=>{options=opts;return {getContextUsage:async opts=>{assert.deepEqual(opts,{detail:'summary'});return{totalTokens:999999,rawMaxTokens:300000,maxTokens:267000,model:'test-model'};},close:()=>closed++};};
  const control=(runtime,cwd,read,_query,timeout,opts)=>claudeControl(runtime,cwd,read,query,timeout,opts);
  const result=await readContextLimits('claude',{command:'fake',prefixArgs:[]},process.cwd(),'test-model',{control});
  assert.deepEqual(result,{nativeWindowTokens:null,nativeAutoCompactTokens:300000,autoCompactScope:'total',compactionKind:'window'});
  assert.equal(options.model,'test-model');assert.equal(options.persistSession,false);assert.deepEqual(options.tools,[]);assert.equal(closed,1);
});

test('native cache refreshes changed limits, coalesces probes, isolates model/workspace and clears stale caps on failure',async()=>{
  let now=0,limit=300000,calls=0,fail=false;
  const reader=new ContextLimits({now:()=>now,ttl:30,read:async()=>{calls++;if(fail)throw Error('credential secret');return{nativeAutoCompactTokens:limit};}});
  const args=['codex',{command:'fake'},'folder','model'];
  assert.equal(reader.peek(...args).status,'waiting');
  const [a,b]=await Promise.all([reader.get(...args),reader.get(...args)]);assert.deepEqual(a,b);assert.equal(calls,1);
  limit=200000;assert.equal((await reader.get(...args)).nativeAutoCompactTokens,300000);
  now=31;assert.equal((await reader.get(...args)).nativeAutoCompactTokens,200000);assert.equal(calls,2);
  await reader.get(...args.slice(0,3),'another');assert.equal(calls,3);
  await reader.get(...args.slice(0,2),'elsewhere','model');assert.equal(calls,4);
  fail=true;assert.deepEqual(await reader.get(...args,true),{status:'error'});assert.deepEqual(reader.peek(...args),{status:'error'});
  assert.equal((await reader.get('antigravity',{},'folder')).status,'unavailable');assert.equal(calls,5);
});

test('context API recalculates saved usage after settings/native changes without sending, resetting, or writing a conversation',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'sp-cap-'));let limit=300000,refresh=false;
  const reader=new ContextLimits({read:async()=>({nativeAutoCompactTokens:limit})});
  const runtime={command:process.execPath,prefixArgs:[]};
  const registry={resolve:()=>runtime,probe:async()=>({}),record:()=>{},verifications:()=>({}),list:async()=>[],
    contextLimits:(id,cwd,model,force)=>{refresh=force;return reader.get(id,runtime,cwd,model,force);},
    cachedContextLimits:(id,cwd,model)=>reader.peek(id,runtime,cwd,model)};
  const hub=createHub({dataDir,port:0,registry,implementations:{codex:async({emit})=>{
    emit({type:'session',id:'fictional-session'});emit({type:'context',context:contextSample({usedTokens:150000,windowTokens:1000000,model:'fictional-model'})});emit({type:'replace',text:'fictional answer'});
  }}});
  try{
    const base='http://127.0.0.1:'+await hub.listen(),html=await (await fetch(base)).text();
    const headers={'X-Hub-Token':html.match(/name="hub-token" content="([^"]+)"/)[1]};
    const chat=hub.store.newChat({workspace:process.cwd()});hub.store.setSetting('context.settings',{budgets:{codex:500}});
    await hub.runner.start(chat.id,'fictional question');await hub.runner.active.get(chat.id).done;
    const messages=hub.store.messages(chat.id),session=hub.store.session(chat.id,'codex');
    const read=async suffix=>(await fetch(base+'/api/chats/'+chat.id+'/context'+suffix,{headers})).json();
    assert.equal((await read('')).percent,15);
    limit=200000;const refreshed=await read('?refresh=1');assert.equal(refreshed.percent,15);assert.equal(refresh,true);
    assert.equal(refreshed.limits.nativeAutoCompactTokens,200000);
    hub.store.setSetting('context.settings',{budgets:{codex:100}});const adjusted=await read('');assert.equal(adjusted.percent,15);
    assert.equal(adjusted.limits.starportTokens,100000);
    assert.deepEqual(hub.store.messages(chat.id),messages);assert.deepEqual(hub.store.session(chat.id,'codex'),session);
    assert.equal((await fetch(base+'/api/chats/'+chat.id+'/context')).status,401);
    assert.equal((await fetch(base+'/api/chats/missing/context',{headers})).status,404);
  }finally{await hub.close();await rm(dataDir,{recursive:true,force:true});}
});

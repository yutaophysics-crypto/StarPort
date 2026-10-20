import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import { codexContext, claudeContext, contextSample } from '../src/context.mjs';
import { parseEvent } from '../src/adapters/cli.mjs';
import { runCodex } from '../src/adapters/codex.mjs';
import { resolve } from 'node:path';

test('context uses native per-request counters; unknown, zero, caches and invalid capacity remain distinct',()=>{
  assert.equal(codexContext({last:{totalTokens:25000},total:{totalTokens:950000},modelContextWindow:100000}).percent,25);
  assert.equal(codexContext({total:{totalTokens:950000},modelContextWindow:100000}).usedTokens,null);
  assert.equal(claudeContext({input_tokens:100,cache_read_input_tokens:10000,cache_creation_input_tokens:9900,output_tokens:3000},200000).percent,10);
  assert.equal(claudeContext({input_tokens:0},100).percent,0);
  assert.equal(contextSample({usedTokens:5,windowTokens:0}).percent,null);
  assert.equal(contextSample({usedTokens:-1,windowTokens:100}).usedTokens,null);
  assert.equal(contextSample({usedTokens:5,windowTokens:'100'}).windowTokens,null);
});
test('Claude streaming input stays separate from result totals, sidechains and other model windows',()=>{
  const state={},feed=e=>parseEvent('claude',e,state).filter(e=>e.type==='context').at(-1)?.context;
  feed({type:'system',subtype:'init',model:'claude-test'});
  assert.equal(feed({type:'stream_event',event:{type:'message_start',message:{model:'claude-test',usage:{input_tokens:500,cache_read_input_tokens:4500}}}}).usedTokens,5000);
  assert.equal(feed({type:'assistant',parent_tool_use_id:'task',message:{model:'other',usage:{input_tokens:90000}}}),undefined);
  assert.equal(feed({type:'result',usage:{input_tokens:100000},modelUsage:{other:{contextWindow:1000000}}}),undefined);
  const result=feed({type:'result',modelUsage:{'claude-test':{contextWindow:200000,inputTokens:300000}}});
  assert.equal(result.usedTokens,5000);assert.equal(result.percent,2.5);
  assert.equal(feed({type:'system',subtype:'status',status:'compacting'}).status,'compacting');
  const compact=feed({type:'system',subtype:'compact_boundary',compact_metadata:{pre_tokens:180000}});
  assert.equal(compact.usedTokens,null);assert.equal(compact.percent,null);
  assert.equal(feed({type:'assistant',message:{model:'claude-test',usage:{input_tokens:4000},content:[]}}).percent,2);
  const reroute=feed({type:'assistant',message:{model:'new-model',usage:{input_tokens:3000},content:[]}});
  assert.equal(reroute.windowTokens,null);assert.equal(reroute.usedTokens,3000);
});
test('Codex adapter forwards latest context and capacity independently of cumulative usage',async()=>{
  const events=[];await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/codex-rpc.mjs')]},options:{mode:'chat',sandbox:'read-only'},prompt:'test',cwd:process.cwd(),signal:new AbortController().signal,emit:e=>events.push(e),setControl:()=>{}});
  const context=events.find(e=>e.type==='context')?.context;assert.equal(context?.usedTokens,1234);assert.equal(context?.windowTokens,100000);
  assert.equal(events.find(e=>e.type==='usage').usage.total.totalTokens,999999);
});
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),record:()=>{}};
test('context persists per native session, streams during execution, and invalidates on model, workspace, failure or reset',async()=>{
  const store=new Store(':memory:'),chat=store.newChat({workspace:process.cwd()}),events=[];
  let fail=false;
  const fake=async({provider,emit})=>{emit({type:'session',id:provider+'-native'});emit({type:'context',context:contextSample({usedTokens:provider==='codex'?300:900,windowTokens:1000,basis:'test'})});emit({type:'replace',text:'answer'});if(fail)throw new Error('failed');};
  const runner=new Runner(store,registry,(type,data)=>events.push({type,data}),{codex:fake,claude:fake});
  const run=async()=>{await runner.start(chat.id,'hello');await runner.active.get(chat.id).done;};
  try{
    assert.equal(runner.context(chat.id).usedTokens,null);await run();
    assert.equal(runner.context(chat.id).percent,30);
    assert.equal(events.filter(e=>e.type==='message').at(-1).data.context.percent,30);
    store.updateChat(chat.id,{provider:'claude'});assert.equal(runner.context(chat.id).usedTokens,null);await run();assert.equal(runner.context(chat.id).percent,90);
    store.updateChat(chat.id,{provider:'codex'});assert.equal(runner.context(chat.id).percent,30);
    store.updateChat(chat.id,{options:{codex:{model:'changed'}}});assert.equal(runner.context(chat.id).usedTokens,null);
    store.updateChat(chat.id,{options:{codex:{}}});assert.equal(runner.context(chat.id).percent,30);
    store.updateChat(chat.id,{workspace:resolve('tests')});assert.equal(runner.context(chat.id).usedTokens,null);
    store.updateChat(chat.id,{workspace:process.cwd()});assert.equal(runner.context(chat.id).percent,30);
    fail=true;await run();assert.equal(runner.context(chat.id).usedTokens,null);
    fail=false;await run();assert.equal(runner.context(chat.id).percent,30);
    store.clearSession(chat.id,'codex');assert.equal(runner.context(chat.id).usedTokens,null);
    const copy=store.import(store.export());assert.ok(copy.chats);for(const c of store.list().chats.filter(c=>c.id!==chat.id))assert.equal(runner.context(c.id).usedTokens,null);
  }finally{store.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseEvent } from '../src/adapters/cli.mjs';
import { parseDeepseekEvent } from '../src/adapters/deepseek.mjs';
import { runCodex } from '../src/adapters/codex.mjs';

test('Antigravity steps use authoritative native state, index and tool_info without inferred success',()=>{
  const state={};
  let out=parseEvent('antigravity',{event:'step_update',step_update:{id:'s1',tool_call:{id:'tc1',name:'bash',arguments:{cmd:'ls'}}}},state);
  assert.equal(out[0].id,'agy:s1');assert.equal(out[0].name,'bash');assert.equal(out[0].status,'running');assert.deepEqual(out[0].input,{cmd:'ls'});
  out=parseEvent('antigravity',{event:'step_update',step_update:{id:'s1',tool_call:{id:'tc1',name:'bash'},text_delta:'done'}},state);
  assert.equal(out.find(e=>e.type==='tool').output,'done');
  assert.equal(out.find(e=>e.type==='tool').status,'running');
  // A new step does not prove the previous step completed.
  out=parseEvent('antigravity',{event:'step_update',step_update:{id:'s2',step_type:'read_file'}},state);
  assert.ok(!out.some(e=>e.id==='agy:s1'));
  assert.equal(out.find(e=>e.type==='activity').item.name,'read_file');
  assert.equal(out.find(e=>e.type==='activity').item.status,'running');
  // A step with no id at all still shows up, keyed by its type.
  out=parseEvent('antigravity',{event:'step_update',step_update:{step_type:'plan',text_delta:'plan text'}},state);
  assert.equal(out.find(e=>e.type==='activity').item.id,'agy:plan');
  assert.equal(out.find(e=>e.type==='activity').item.status,'running');
  out=parseEvent('antigravity',{event:'step_update',step_update:{step_index:4,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'echo hello'},output:'hello'},duration_seconds:1.2}},state);
  assert.equal(out[0].id,'agy:4');assert.equal(out[0].name,'run_command');assert.equal(out[0].status,'complete');assert.equal(out[0].durationMs,1200);
});

test('Claude tool blocks pair running calls with their results',()=>{
  const state={};
  const call=parseEvent('claude',{type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'ls'}}]}},state);
  assert.equal(call[0].id,'t1');assert.equal(call[0].name,'Bash');assert.equal(call[0].status,'running');assert.deepEqual(call[0].input,{command:'ls'});
  const done=parseEvent('claude',{type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:[{type:'text',text:'ok'}]}]}},state);
  assert.equal(done[0].id,'t1');assert.equal(done[0].status,'complete');assert.match(done[0].output,/ok/);
});

test('DeepSeek session events produce step and tool rows',()=>{
  const start=parseDeepseekEvent({type:'step/start',data:{turn:1,step:2}});
  assert.deepEqual(start[0],{type:'tool',id:'step-1-2',kind:'step',name:'步骤 2',status:'running'});
  const end=parseDeepseekEvent({type:'step/end',data:{turn:1,step:2}});
  assert.equal(end[0].status,'complete');
  const call=parseDeepseekEvent({type:'tool/call',data:{callId:'c1',name:'todo',arguments:'["a"]'}});
  assert.deepEqual(call[0],{type:'tool',id:'c1',kind:'tool',name:'todo',input:'["a"]',status:'running'});
  // Real SDK shape captured from a live session: the call id lives on the
  // nested tool-result block (and on message.source.callId), the text is one
  // level deeper, and isError sits on the block — not on message itself.
  const result=parseDeepseekEvent({type:'tool/result',data:{message:{source:{kind:'tool',callId:'c1'},
    content:[{type:'tool-result',toolCallId:'c1',content:[{type:'text',text:'r'}],isError:false}]}}});
  assert.equal(result[0].id,'c1');assert.equal(result[0].status,'complete');assert.equal(result[0].output,'r');
  const failed=parseDeepseekEvent({type:'tool/result',data:{message:{source:{kind:'tool',callId:'c2'},
    content:[{type:'tool-result',toolCallId:'c2',content:[],isError:true}]}}});
  assert.equal(failed[0].id,'c2');assert.equal(failed[0].status,'error');
  // Empty meta-less output falls back to a serialized meta block.
  const withMeta=parseDeepseekEvent({type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'c3',content:[],isError:false}]},meta:{shape:'paths',paths:['a']}}});
  assert.equal(withMeta[0].id,'c3');assert.match(withMeta[0].output,/"paths"/);
  // Legacy flat shape stays supported.
  const legacy=parseDeepseekEvent({type:'tool/result',data:{message:{toolCallId:'c4',isError:false,content:[{type:'text',text:'x'}]}}});
  assert.equal(legacy[0].id,'c4');assert.equal(legacy[0].status,'complete');assert.equal(legacy[0].output,'x');
});

test('Codex items map tool names, statuses and sub-agent steps',async()=>{
  const events=[];
  await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/codex-items-rpc.mjs')]},options:{mode:'chat'},prompt:'Start',cwd:process.cwd(),signal:new AbortController().signal,emit:e=>events.push(structuredClone(e)),setControl:()=>{}});
  const tools=events.filter(e=>e.type==='tool');
  const bash=tools.filter(t=>t.id==='a');
  assert.equal(bash.length,2);assert.equal(bash[0].name,'bash');assert.equal(bash[0].status,'running');assert.equal(bash[1].status,'complete');assert.equal(bash[1].output,'ok');
  const sub=tools.filter(t=>t.id==='b');
  assert.equal(sub.length,2);assert.equal(sub[0].kind,'step');assert.equal(sub[0].name,'planner');assert.equal(sub[0].note,'started');assert.equal(sub[1].status,'complete');
});

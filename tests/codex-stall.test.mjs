import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {runCodex} from '../src/adapters/codex.mjs';
import {JsonRpc} from '../src/process.mjs';
async function run(scenario,options={mode:'chat',sandbox:'read-only'}){
  const controller=new AbortController(),events=[];
  let control;
  const timer=setTimeout(()=>controller.abort(),2500);
  try{
    await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/codex-stall-rpc.mjs'),scenario]},options,prompt:'Fixture',cwd:process.cwd(),signal:controller.signal,emit:event=>events.push({...event,...event.type==='input-state'?{ready:control?.canSend(),answer:events.filter(e=>e.type==='replace').at(-1)?.text}:{}}),setControl:value=>{control=value;},reconcileIntervalMs:20,reconcileAfterMs:0});
    return {events};
  }catch(error){return {events,error};}
  finally{clearTimeout(timer);}
}
test('fatal native error ends the turn and preserves partial output without manual stop',async()=>{
  const {events,error}=await run('fatal');assert.match(error?.message||'',/Native stream failed/);assert.ok(!error.canceled);assert.equal(events.find(e=>e.type==='replace')?.text,'Partial answer');
});
test('broken stdout ends a resident process connection without waiting forever',async()=>{
  let receive;const partial=new Promise(resolve=>{receive=resolve;});
  const rpc=new JsonRpc(process.execPath,[resolve('tests/fixtures/codex-stall-rpc.mjs'),'resident'],{cwd:process.cwd(),onEvent:(method,params)=>{if(method==='item/agentMessage/delta')receive(params.delta);}});
  let timeout;
  try{
    await rpc.request('initialize');await rpc.request('thread/start');await rpc.request('turn/start');assert.equal(await partial,'Partial answer');assert.equal(rpc.child.exitCode,null);
    // Break this isolated fixture's actual readable pipe while its process lives.
    rpc.child.stdout.destroy();
    const error=await Promise.race([rpc.closed,new Promise(resolve=>{timeout=setTimeout(()=>resolve(Error('Fixture transport never ended')),1500);})]);
    assert.match(error.message,/输出连接已关闭/);assert.equal(rpc.pending.size,0);
  }finally{clearTimeout(timeout);await rpc.close();}
});
test('retryable native errors leave the same turn alive until its final answer',async()=>{
  const {events,error}=await run('retry');assert.ifError(error);assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'Complete answer');
});
test('lost terminal notification recovers full answer from the exact native turn',async()=>{
  const {events,error}=await run('recover');assert.ifError(error);assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'Recovered complete answer');
});
test('late deltas from a finished turn do not append to the recovered answer',async()=>{
  const {events,error}=await run('late',{mode:'goal',sandbox:'read-only'});assert.ifError(error);assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'Recovered complete answer');
});
test('native in-progress status never stops a healthy long-running turn',async()=>{
  const {events,error}=await run('active');assert.ifError(error);assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'Complete answer');
});
test('late completion for a previous turn cannot truncate the active answer',async()=>{
  const {events,error}=await run('stale');assert.ifError(error);assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'Complete answer');assert.ok(!events.some(e=>e.type==='input-state'&&e.ready===false&&e.answer==='Partial answer'));
});
test('ordinary nonzero process exit keeps its exit-code diagnosis',async()=>{
  const {error}=await run('exit');assert.match(error?.message||'',/进程已退出 \(7\)/);assert.ok(!error.canceled);
});

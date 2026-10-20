import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DeepseekLifecycle} from '../src/adapters/deepseek-lifecycle.mjs';
import {runDeepseek} from '../src/adapters/deepseek.mjs';
import {Runner} from '../src/runner.mjs';
import {Store} from '../src/storage.mjs';

const runtime={command:process.execPath,prefixArgs:[resolve('tests/fixtures/deepseek-lifecycle-rpc.mjs')]};
const options={provider:'fixture',model:'fixture'};
function feed(life,id,type,data={}){life.observe('session.event',{sessionId:id,event:{type,data}});}
function idle(life,id='parent'){life.observe('session.status',{sessionId:id,status:'idle'});}
function ended(life,id='parent',reason='completed'){feed(life,id,'turn/end',{reason:{kind:reason}});idle(life,id);}
function started(life,id='parent'){life.observe('session.status',{sessionId:id,status:'running'});feed(life,id,'turn/start');}
function child(life,id,parentId='parent',mode='continuable'){
  life.observe('subagent.started',{parentSessionId:parentId,childSessionId:id});
  feed(life,id,'subagent/descriptor',{mode});
}
function finish(life,id,parentId='parent'){life.observe('subagent.finished',{parentSessionId:parentId,childSessionId:id,status:'ok',stopReason:'completed'});}
function notice(life,id,parentId='parent'){feed(life,parentId,'user/message',{source:{kind:'subagent-settled',senderSessionId:id}});}
async function run(t,prompt,emit=()=>{}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);timer.unref();
  t.after(()=>{clearTimeout(timer);controller.abort();});
  const events=[];
  await runDeepseek({runtime,options,prompt,cwd:process.cwd(),signal:controller.signal,emit:event=>{events.push(event);emit(event);},setControl:()=>{}});
  return events;
}

test('DeepSeek completion requires native parent idle; turn/end is not whole-agent idle',()=>{
  const life=new DeepseekLifecycle('parent');started(life);feed(life,'parent','turn/end',{reason:'completed'});
  assert.equal(life.completion(),null);
  started(life);ended(life);assert.equal(life.completion().kind,'completed');
});

test('DeepSeek waits for every child, nested settlement and consumed result notices',()=>{
  const life=new DeepseekLifecycle('parent');started(life);child(life,'a');child(life,'b');child(life,'grandchild','a');ended(life);
  ended(life,'a');idle(life,'grandchild');assert.equal(life.completion(),null);
  started(life,'a');notice(life,'grandchild','a');finish(life,'grandchild','a');ended(life,'a');
  started(life);notice(life,'a');finish(life,'a');ended(life);
  assert.equal(life.completion(),null,'another child remains live');
  finish(life,'b');assert.equal(life.completion(),null,'finished is not consumed result');
  started(life);notice(life,'b');ended(life);assert.equal(life.completion().kind,'completed');
});

test('DeepSeek does not confuse early child messages with a settlement notice',()=>{
  const life=new DeepseekLifecycle('parent');started(life);child(life,'a');
  feed(life,'parent','user/message',{source:{kind:'agent-message',senderSessionId:'a'}});finish(life,'a');ended(life);
  assert.equal(life.completion(),null);
  started(life);notice(life,'a');ended(life);assert.equal(life.completion().kind,'completed');
});

test('DeepSeek accepts a consumed settlement before the terminal notification without demanding an extra model turn',()=>{
  const life=new DeepseekLifecycle('parent');started(life);child(life,'a');notice(life,'a');ended(life);
  assert.equal(life.completion(),null);finish(life,'a');assert.equal(life.completion().kind,'completed');
});

test('DeepSeek duplicate terminal notifications cannot postpone an already processed handoff',()=>{
  const life=new DeepseekLifecycle('parent');started(life);child(life,'a','parent','one-shot');ended(life);
  finish(life,'a');started(life);ended(life);assert.equal(life.completion().kind,'completed');
  finish(life,'a');assert.equal(life.completion().kind,'completed');
});

test('DeepSeek revives a cold-resumed child and ignores unrelated session outcomes',()=>{
  const life=new DeepseekLifecycle('parent');started(life);child(life,'a');notice(life,'a');finish(life,'a');
  life.observe('session.status',{sessionId:'a',status:'running'});ended(life);
  finish(life,'foreign');ended(life,'foreign');assert.equal(life.completion(),null);
  started(life);notice(life,'a');finish(life,'a');ended(life);assert.equal(life.completion().kind,'completed');
});

for(const mode of ['no-children','continuable','nested','one-shot','resumed','child-error']){
  test('DeepSeek SDK waits for final parent output: '+mode,{timeout:10000},async t=>{
    const events=await run(t,mode);
    assert.match(events.filter(event=>event.type==='delta').map(event=>event.text).join(''),/Final answer/);
    assert.ok(!events.some(event=>event.type==='delta'&&event.text.startsWith('Child result')));
    if(mode!=='no-children')assert.ok(events.some(event=>event.type==='subagent'&&event.status===(mode==='child-error'?'error':'complete')));
  });
}

test('DeepSeek preserves native parent failure even with running children',{timeout:10000},async t=>{
  await assert.rejects(run(t,'parent-error'),/native parent failure/);
});
test('DeepSeek reports unexpected process exit while children are running',{timeout:10000},async t=>{
  await assert.rejects(run(t,'exit'),/fixture connection lost/);
});
test('DeepSeek stop remains responsive while parent is waiting for children',{timeout:10000},async t=>{
  const controller=new AbortController();let control;
  t.after(()=>controller.abort());
  await assert.rejects(runDeepseek({runtime,options,prompt:'cancel',cwd:process.cwd(),signal:controller.signal,
    emit:event=>{if(event.type==='delta')controller.abort();},setControl:value=>{control=value;}}),error=>error.canceled===true);
  await control.stop();
});

test('Starport retains running task and rejects a second send until DeepSeek finishes its child handoff',{timeout:10000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'starport-deepseek-lifecycle-')),store=new Store(join(directory,'hub.sqlite'));
  const registry={resolve:()=>runtime,probe:async()=>({}),record:()=>{}};
  let reached;const preliminary=new Promise(resolve=>{reached=resolve;});
  const runner=new Runner(store,registry,(type,data)=>{
    if(type==='message'&&data.message.content.includes('I will return'))reached(data.message);
  },{deepseek:args=>runDeepseek({...args,options})});
  t.after(async()=>{await runner.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const chat=store.newChat({provider:'deepseek',workspace:process.cwd()});
  await runner.start(chat.id,'continuable');const done=runner.active.get(chat.id).done;
  const message=await preliminary;
  assert.equal(message.status,'running');assert.ok(runner.active.has(chat.id));
  await assert.rejects(runner.start(chat.id,'second message'),/运行|执行|正在/);
  await done;assert.equal(runner.active.has(chat.id),false);
  const saved=store.messages(chat.id).at(-1);
  assert.equal(saved.status,'complete');assert.match(saved.content,/Final answer/);
  assert.equal(saved.details.subagents[0].status,'complete');
});

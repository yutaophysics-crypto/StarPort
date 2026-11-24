import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runCodex} from '../src/adapters/codex.mjs';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {HistoryImporter} from '../src/history.mjs';
import {fixtureHistoryConnect} from './fixtures/history.mjs';
import {createHub} from '../src/server.mjs';
import {Attachments} from '../src/attachments.mjs';

function nativeFixture(scenario='success'){
  const workspace=mkdtempSync(join(tmpdir(),'sp-writer-')),scenarioFile=join(workspace,'scenario.txt'),logFile=join(workspace,'rpc.jsonl');
  writeFileSync(logFile,'');const set=value=>writeFileSync(scenarioFile,value);set(scenario);
  return {workspace,set,runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/codex-writer-rpc.mjs'),scenarioFile,logFile]},
    calls:()=>readFileSync(logFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
function runnerFixture(t,scenario='success'){
  const f=nativeFixture(scenario),store=new Store(':memory:');t.after(()=>store.close());
  const records=[],registry={resolve:()=>f.runtime,probe:async()=>({nativeGoal:true,nativePlan:true}),record:(...args)=>records.push(args),list:async()=>[]};
  const runner=new Runner(store,registry,()=>{});t.after(()=>runner.close());
  const chat=store.newChat({provider:'codex',title:'Fictional project',workspace:f.workspace});
  return {...f,store,runner,chat,registry,records};
}
const execute=async(f,text)=>{const run=await f.runner.start(f.chat.id,text);await run.done;return f.store.lastAssistant(f.chat.id);};
async function occupied(t){
  const f=runnerFixture(t);await execute(f,'Earlier request');
  const original={...f.store.session(f.chat.id,'codex')};f.set('conflict');
  const failure=await execute(f,'New request not delivered');return {...f,original,failure};
}

test('only an exact resume writer refusal is recoverable; nothing is resent or interrupted',async()=>{
  for(const scenario of ['conflict','mismatched','turn-error']){
    const f=nativeFixture(scenario),events=[];
    await assert.rejects(()=>runCodex({runtime:f.runtime,options:{mode:'chat'},session:'desktop-thread',prompt:'Private wrapper must never become a title',threadName:'StarPort · Fictional project',cwd:f.workspace,signal:AbortSignal.timeout(8000),emit:e=>events.push(e),setControl(){}}),error=>{
      assert.equal(!!error.codexWriterConflict,scenario==='conflict');return true;
    });
    const methods=f.calls().map(c=>c.method);
    assert.equal(methods.filter(m=>m==='thread/resume').length,1);
    assert.ok(!methods.some(m=>['thread/fork','thread/start','turn/interrupt','thread/goal/set'].includes(m)));
    if(scenario!=='turn-error'){assert.ok(!methods.includes('turn/start'));assert.ok(!events.some(e=>e.type==='session'));}
  }
});

test('writer conflict preserves native identity, cursor and an unsent receipt without marking the provider offline',async t=>{
  const f=await occupied(t);
  assert.deepEqual({...f.store.session(f.chat.id,'codex')},f.original);
  assert.equal(f.failure.status,'error');assert.equal(f.failure.details.nativeConflict.delivery,'not-delivered');
  assert.equal(f.failure.details.nativeConflict.nativeId,f.original.native_id);
  assert.equal(f.store.messages(f.chat.id).filter(m=>m.role==='user').length,2);
  assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1);
  assert.equal(f.records.filter(([,ok])=>ok===false).length,0);
});

test('retry reuses the original user and cursor; stale or concurrent recovery cannot resend',async t=>{
  const f=await occupied(t);f.set('success');
  const run=await f.runner.recoverNativeSession(f.chat.id,{messageId:f.failure.id,action:'retry'});
  assert.throws(()=>f.runner.recoverNativeSession(f.chat.id,{messageId:f.failure.id,action:'retry'}));
  await run.done;
  assert.equal(f.store.messages(f.chat.id).filter(m=>m.role==='user').length,2);
  const resumed=f.calls().filter(c=>c.method==='thread/resume').at(-1);assert.equal(resumed.params.threadId,f.original.native_id);
  const prompt=f.calls().filter(c=>c.method==='turn/start').at(-1).params.input[0].text;
  assert.equal(prompt.split('New request not delivered').length-1,1);assert.ok(!prompt.includes('Earlier request'));
  assert.ok(!prompt.includes('底层会话正被'));assert.equal(f.store.lastAssistant(f.chat.id).status,'complete');
  assert.throws(()=>f.runner.recoverNativeSession(f.chat.id,{messageId:f.failure.id,action:'retry'}),/失效/);
});

test('independent continuation rebuilds saved history and tools without deleting or resuming the occupied source',async t=>{
  const f=await occupied(t);const start=f.calls().length;
  const run=await f.runner.recoverNativeSession(f.chat.id,{messageId:f.failure.id,action:'independent'});await run.done;
  const calls=f.calls().slice(start),thread=calls.find(c=>c.method==='thread/start'),turn=calls.find(c=>c.method==='turn/start');
  assert.ok(thread.params.dynamicTools.length);assert.equal(thread.params.sandbox,'read-only');
  assert.ok(!calls.some(c=>['thread/resume','thread/delete','thread/archive','turn/interrupt','thread/fork'].includes(c.method)));
  assert.match(turn.params.input[0].text,/Earlier request/);assert.match(turn.params.input[0].text,/Fixture answer/);
  assert.equal(turn.params.input[0].text.split('New request not delivered').length-1,1);
  assert.equal(f.store.messages(f.chat.id).filter(m=>m.role==='user').length,2);
  assert.notEqual(f.store.session(f.chat.id,'codex').native_id,f.original.native_id);
  assert.equal(calls.find(c=>c.method==='thread/name/set').params.name,'StarPort · Fictional project');
});

test('changed bindings block Retry; repeated refusals keep the original message and session',async t=>{
  const f=await occupied(t);
  let run=await f.runner.recoverNativeSession(f.chat.id,{messageId:f.failure.id,action:'retry'});await run.done;
  const again=f.store.lastAssistant(f.chat.id);assert.equal(again.details.nativeConflict.userId,f.failure.details.nativeConflict.userId);
  assert.deepEqual({...f.store.session(f.chat.id,'codex')},f.original);
  assert.equal(f.store.messages(f.chat.id).filter(m=>m.role==='user').length,2);
  f.store.db.prepare('UPDATE sessions SET native_id=? WHERE chat_id=?').run('replacement-native',f.chat.id);
  const count=f.calls().length;
  await assert.rejects(()=>f.runner.recoverNativeSession(f.chat.id,{messageId:again.id,action:'retry'}),/独立/);
  assert.equal(f.calls().length,count);assert.equal(f.store.lastAssistant(f.chat.id).id,again.id);
});

test('errors after turn submission stay uncertain and never offer recovery',async t=>{
  const f=runnerFixture(t);await execute(f,'Earlier request');f.set('turn-error');
  const failure=await execute(f,'Uncertain request');
  assert.equal(failure.details.nativeConflict,undefined);assert.equal(f.store.session(f.chat.id,'codex'),undefined);
  assert.throws(()=>f.runner.recoverNativeSession(f.chat.id,{messageId:failure.id,action:'independent'}),/失效/);
});

test('recovery retains original file and image attachments and disabled context tools',async t=>{
  const f=runnerFixture(t);f.runner.attachments=new Attachments(f.store,f.workspace);await execute(f,'Before');
  const image=await f.runner.attachments.upload({name:'fictional.png',data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')}),
    file=await f.runner.attachments.upload({name:'fictional.txt',data:Buffer.from('Fictional attachment text').toString('base64')});
  f.set('conflict');let run=await f.runner.start(f.chat.id,'Read attachments',[image.id,file.id],{disableContextTools:true});await run.done;
  const failure=f.store.lastAssistant(f.chat.id);f.set('success');
  run=await f.runner.recoverNativeSession(f.chat.id,{messageId:failure.id,action:'independent'});await run.done;
  const calls=f.calls(),thread=calls.filter(c=>c.method==='thread/start').at(-1),turn=calls.filter(c=>c.method==='turn/start').at(-1);
  assert.equal(thread.params.dynamicTools,undefined);
  assert.equal(turn.params.input.find(p=>p.type==='localImage').path,image.path);
  assert.match(turn.params.input[0].text,/Fictional attachment text/);
  const users=f.store.messages(f.chat.id).filter(m=>m.role==='user');assert.equal(users.length,2);
  assert.deepEqual(users[1].details.attachments.map(a=>a.id),[image.id,file.id]);
});

test('import reads the source only; first continuation gets its own named native session and full saved text',async t=>{
  const f=runnerFixture(t),calls=[];
  const history=new HistoryImporter(f.store,f.registry,f.workspace,fixtureHistoryConnect(calls));
  const imported=await history.import('codex',{id:'history-0'});
  f.store.updateChat(imported.chatId,{workspace:f.workspace,title:'Imported fictional chat'});
  const run=await f.runner.start(imported.chatId,'Continue imported work');await run.done;
  assert.ok(calls.every(c=>['thread/read','thread/turns/list','close'].includes(c.method)));
  assert.ok(!f.calls().some(c=>c.method==='thread/resume'));
  assert.notEqual(f.store.session(imported.chatId,'codex').native_id,'history-0');
  assert.match(f.calls().find(c=>c.method==='turn/start').params.input[0].text,/Second page answer/);
  assert.equal(f.calls().find(c=>c.method==='thread/name/set').params.name,'StarPort · Imported fictional chat');
});

test('names never use the wrapped prompt; custom names survive and old servers can continue',async()=>{
  for(const scenario of ['success','custom-name','old-server']){
    const f=nativeFixture(scenario),events=[];
    await runCodex({runtime:f.runtime,options:{mode:'chat'},session:scenario==='custom-name'?'existing':undefined,threadName:'StarPort · Fictional title',prompt:'Internal memory preamble and private history',cwd:f.workspace,signal:AbortSignal.timeout(8000),emit:e=>events.push(e),setControl(){}});
    const name=f.calls().find(c=>c.method==='thread/name/set');
    if(scenario==='custom-name')assert.equal(name,undefined);else assert.equal(name.params.name,'StarPort · Fictional title');
    assert.ok(events.some(e=>e.type==='replace'));if(scenario==='old-server')assert.ok(events.some(e=>e.type==='notice'));
  }
});

test('ephemeral desk threads stay unnamed and are never probed for turns they cannot list',async()=>{
  // The plain run is the control: on the same slow turn its status check does read the thread.
  for(const ephemeral of [true,false]){
    const f=nativeFixture('slow'),events=[];
    await runCodex({runtime:f.runtime,options:{mode:'chat'},threadName:'StarPort · [工位] 压缩',ephemeral,prompt:'Fixture',cwd:f.workspace,signal:AbortSignal.timeout(8000),emit:e=>events.push(e),setControl(){},reconcileIntervalMs:20,reconcileAfterMs:0});
    const calls=f.calls();
    assert.equal(calls.find(c=>c.method==='thread/start').params.ephemeral,ephemeral?true:undefined);
    assert.equal(calls.some(c=>c.method==='thread/name/set'),!ephemeral);
    assert.equal(calls.some(c=>c.method==='thread/read'),!ephemeral);
    assert.equal(events.find(e=>e.type==='session').ephemeral,ephemeral?true:undefined);
    assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'Fixture answer');
  }
});

test('a Codex that ignores the ephemeral option keeps a named, resumable thread',async()=>{
  const f=nativeFixture('no-ephemeral'),events=[];
  await runCodex({runtime:f.runtime,options:{mode:'chat'},threadName:'StarPort · [工位] 压缩',ephemeral:true,prompt:'Fixture',cwd:f.workspace,signal:AbortSignal.timeout(8000),emit:e=>events.push(e),setControl(){}});
  assert.equal(f.calls().find(c=>c.method==='thread/name/set').params.name,'StarPort · [工位] 压缩');
  assert.equal(events.find(e=>e.type==='session').ephemeral,undefined);
});

test('only one-off desks get ephemeral threads, and they save no session to resume',async t=>{
  const f=runnerFixture(t);
  const desk=meta=>f.store.newChat({provider:'codex',title:'[工位] Fictional',workspace:f.workspace,options:{codex:{},desk:{parentChatId:f.chat.id,...meta}}});
  const cases=[['conversation',f.chat,false],['@companion desk',desk({companionId:'fictional',persistent:true}),false],
    ['compaction',desk({compact:true}),true],['call',desk({companionId:'fictional',runId:'run',call:true}),true],['exam seat',desk({companionId:'fictional',runId:'run',exam:true}),true]];
  for(const [label,chat,ephemeral] of cases){
    const before=f.calls().length;
    const run=await f.runner.start(chat.id,'Fixture request',[],chat===f.chat?{}:{desk:true,memory:{}});await run.done;
    assert.equal(f.store.lastAssistant(chat.id).status,'complete',label);
    assert.equal(f.calls().slice(before).find(c=>c.method==='thread/start').params.ephemeral,ephemeral?true:undefined,label);
    assert.equal(!!f.store.session(chat.id,'codex'),!ephemeral,label);
  }
});

test('recovery HTTP uses authentication, same-origin checks and receipt validation',async t=>{
  const f=nativeFixture(),registry={resolve:()=>f.runtime,probe:async()=>({}),record(){},list:async()=>[]};
  const hub=createHub({port:0,dataDir:join(f.workspace,'hub'),registry});const port=await hub.listen();t.after(()=>hub.close());
  const chat=hub.store.newChat({workspace:f.workspace,provider:'codex'});
  let run=await hub.runner.start(chat.id,'Before');await run.done;f.set('conflict');run=await hub.runner.start(chat.id,'After');await run.done;
  const failure=hub.store.lastAssistant(chat.id),url=`http://127.0.0.1:${port}/api/chats/${chat.id}/recover-session`,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'},body=JSON.stringify({messageId:failure.id,action:'retry'});
  assert.equal((await fetch(url,{method:'POST',body})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({messageId:failure.id,action:'steal-lock'})})).status,409);
  f.set('success');assert.equal((await fetch(url,{method:'POST',headers,body})).status,202);
  await hub.runner.active.get(chat.id)?.done;
  assert.equal(hub.store.messages(chat.id).filter(m=>m.role==='user').length,2);
  assert.equal(hub.store.lastAssistant(chat.id).status,'complete');
});

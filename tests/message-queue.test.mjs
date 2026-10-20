import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {Store,buildContext} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {createHub} from '../src/server.mjs';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture did not reach expected state');};
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),list:async()=>[],record:()=>{}};
function fixture(provider='codex',failure=false){
  const store=new Store(':memory:'),release=gate(),calls=[],steered=[];
  const runner=new Runner(store,registry,()=>{},{[provider]:async({emit,setControl,prompt,session,signal})=>{
    calls.push({prompt,session});emit({type:'session',id:'resident'});setControl({inputMode:['codex','claude'].includes(provider)?'steer':'queue',steer:async text=>{steered.push(text);return {delivery:'accepted'};},stop:release.resolve});
    if(calls.length===1){await release.promise;if(signal.aborted)throw Object.assign(Error('stopped'),{canceled:true});if(failure)throw Error('native failure');}
    emit({type:'replace',text:'Final '+calls.length});
  }});
  const chat=store.newChat({provider,workspace:process.cwd()});
  return {store,runner,chat,release,calls,steered,async close(){release.resolve();await runner.close();store.close();}};
}
const add=(f,text,id=randomUUID())=>f.runner.enqueue(f.chat.id,{text,clientId:id,runId:f.runner.state(f.chat.id)?.id}).queued;

for(const provider of ['codex','claude','antigravity','deepseek'])test(provider+' queue is editable, never reaches live native input and drains FIFO after completion',async()=>{
  const f=fixture(provider);
  try{
    await f.runner.start(f.chat.id,'initial');await until(()=>f.calls.length===1);
    const one=add(f,'one'),deleted=add(f,'delete me'),three=add(f,'third');
    f.runner.editQueued(f.chat.id,one.id,{revision:one.revision,text:'edited'});f.runner.deleteQueued(f.chat.id,deleted.id,{revision:deleted.revision});
    assert.deepEqual(f.steered,[]);assert.equal(f.calls.length,1);assert.equal(f.store.messages(f.chat.id).length,2);
    assert.doesNotMatch(buildContext(f.store.messages(f.chat.id)).text,/edited|delete me|third/);
    f.release.resolve();await until(()=>f.calls.length===3&&!f.runner.active.has(f.chat.id));
    assert.match(f.calls[1].prompt,/edited$/);assert.match(f.calls[2].prompt,/third$/);
    if(provider!=='deepseek')assert.equal(f.calls[1].session,'resident');
    assert.equal(f.store.queue.list(f.chat.id).length,0);assert.doesNotMatch(JSON.stringify(f.store.messages(f.chat.id)),/delete me/);
    assert.equal(f.store.messages(f.chat.id).filter(row=>row.role==='user').length,3);assert.ok(three.id);
  }finally{await f.close();}
});

test('editing pauses dispatch at the current task boundary until the changed text is saved',async()=>{
  const f=fixture();
  try{
    await f.runner.start(f.chat.id,'initial');await until(()=>f.calls.length);const row=add(f,'original');
    f.runner.beginQueuedEdit(f.chat.id,row.id,{revision:row.revision});const editing=f.store.queue.get(f.chat.id,row.id);
    assert.equal(editing.state,'editing');await assert.rejects(()=>f.runner.steerQueued(f.chat.id,row.id,{revision:editing.revision,runId:f.runner.state(f.chat.id).id}),/保存或取消/);
    f.release.resolve();await f.runner.active.get(f.chat.id).done;
    assert.equal(f.calls.length,1);await f.runner.dispatchQueue(f.chat.id);assert.equal(f.calls.length,1);
    assert.throws(()=>f.runner.editQueued(f.chat.id,row.id,{revision:row.revision,text:'stale'}),/改变/);
    f.runner.editQueued(f.chat.id,row.id,{revision:editing.revision,text:'confirmed edit'});
    await until(()=>f.calls.length===2&&!f.runner.active.has(f.chat.id));assert.match(f.calls[1].prompt,/confirmed edit$/);assert.doesNotMatch(f.calls[1].prompt,/original/);
  }finally{await f.close();}
});

for(const provider of ['codex','claude'])test('only explicit steer sends a queued message to the same running '+provider+' task',async()=>{
  const f=fixture(provider);
  try{
    const initial=await f.runner.start(f.chat.id,'initial');await until(()=>f.runner.state(f.chat.id).inputReady);const row=add(f,'now');
    assert.deepEqual(f.steered,[]);assert.equal(f.store.queue.list(f.chat.id).length,1);
    await assert.rejects(()=>f.runner.steerQueued(f.chat.id,row.id,{revision:row.revision,runId:'stale'}),/暂不/);
    await f.runner.steerQueued(f.chat.id,row.id,{revision:row.revision,runId:initial.id});
    assert.deepEqual(f.steered,['now']);assert.equal(f.runner.state(f.chat.id).id,initial.id);assert.equal(f.calls.length,1);assert.equal(f.store.queue.list(f.chat.id).length,0);
    assert.equal(f.store.messages(f.chat.id).at(-1).content,'now');assert.equal(f.store.messages(f.chat.id).at(-1).details.guidance.state,'accepted');
    assert.equal(f.runner.enqueue(f.chat.id,{text:'now',clientId:row.client_id,runId:initial.id}).queued.state,'delivered');assert.deepEqual(f.steered,['now']);assert.equal(f.store.queue.list(f.chat.id).length,0);
  }finally{await f.close();}
});

test('removing a paused queue head resumes remaining ready messages after completion',async()=>{
  const f=fixture();
  try{
    await f.runner.start(f.chat.id,'initial');await until(()=>f.calls.length);const head=add(f,'paused');add(f,'next');
    f.runner.beginQueuedEdit(f.chat.id,head.id,{revision:0});f.release.resolve();await f.runner.active.get(f.chat.id).done;assert.equal(f.calls.length,1);
    const editing=f.store.queue.get(f.chat.id,head.id);f.runner.deleteQueued(f.chat.id,head.id,{revision:editing.revision});
    await until(()=>f.calls.length===2&&!f.runner.active.has(f.chat.id));assert.match(f.calls[1].prompt,/next$/);assert.doesNotMatch(f.calls[1].prompt,/paused/);assert.equal(f.store.queue.list(f.chat.id).length,0);
  }finally{await f.close();}
});

test('in-flight steering is protected against delete/edit while a completion races the acknowledgement',async()=>{
  const store=new Store(':memory:'),release=gate(),ack=gate();let calls=0;
  const runner=new Runner(store,registry,()=>{},{codex:async({setControl,emit})=>{
    calls++;setControl({inputMode:'steer',steer:async()=>{await ack.promise;return {delivery:'accepted'};},stop:release.resolve});
    if(calls===1)await release.promise;emit({type:'replace',text:'done'});
  }});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()}),initial=await runner.start(chat.id,'initial');await until(()=>runner.state(chat.id).inputReady);
    const one=runner.enqueue(chat.id,{text:'steer',clientId:'one',runId:initial.id}).queued;
    runner.enqueue(chat.id,{text:'next',clientId:'two',runId:initial.id});
    const steering=runner.steerQueued(chat.id,one.id,{revision:0,runId:initial.id});await until(()=>store.messages(chat.id).some(row=>row.details.guidance));
    const row=store.queue.get(chat.id,one.id);assert.equal(row.state,'steering');assert.throws(()=>runner.deleteQueued(chat.id,one.id,{revision:row.revision}),/正在发送/);
    release.resolve();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
    ack.resolve();await steering;await until(()=>calls===2&&!runner.active.has(chat.id));assert.equal(store.queue.list(chat.id).length,0);
    assert.equal(store.messages(chat.id).filter(row=>row.content==='steer').length,1);assert.equal(store.messages(chat.id).filter(row=>row.content==='next').length,1);
  }finally{ack.resolve();release.resolve();await runner.close();store.close();}
});

for(const failure of [false,true])test((failure?'failure':'stop')+' holds queued drafts instead of starting more work',async()=>{
  const f=fixture('codex',failure);
  try{
    await f.runner.start(f.chat.id,'initial');await until(()=>f.calls.length);const row=add(f,'keep queued');const run=f.runner.active.get(f.chat.id);
    if(failure)f.release.resolve();else await f.runner.stop(f.chat.id);await run.done;
    assert.equal(f.calls.length,1);assert.equal(f.store.queue.get(f.chat.id,row.id).state,'held');assert.equal(f.store.messages(f.chat.id).length,2);
    await f.runner.dispatchQueue(f.chat.id);assert.equal(f.calls.length,1);
    const held=f.store.queue.get(f.chat.id,row.id);await f.runner.dispatchQueue(f.chat.id,row.id,held.revision);await until(()=>f.calls.length===2&&!f.runner.active.has(f.chat.id));assert.equal(f.store.queue.list(f.chat.id).length,0);
  }finally{await f.close();}
});

test('stop while editing keeps the updated draft held and never resumes it implicitly',async()=>{
  const f=fixture();
  try{
    await f.runner.start(f.chat.id,'initial');await until(()=>f.calls.length);const row=add(f,'old');f.runner.beginQueuedEdit(f.chat.id,row.id,{revision:0});
    const run=f.runner.active.get(f.chat.id);await f.runner.stop(f.chat.id);await run.done;const held=f.store.queue.get(f.chat.id,row.id);
    assert.equal(held.details.editingFrom,undefined);
    f.runner.beginQueuedEdit(f.chat.id,row.id,{revision:held.revision});const editing=f.store.queue.get(f.chat.id,row.id);assert.equal(editing.details.editingFrom,'held');
    f.runner.editQueued(f.chat.id,row.id,{revision:editing.revision,text:'saved after stop'});assert.equal(f.store.queue.get(f.chat.id,row.id).state,'held');assert.equal(f.calls.length,1);
  }finally{await f.close();}
});

test('queue survives reopening and backups while cancelled drafts and unrelated chats stay separate',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'starport-queue-')),file=join(folder,'hub.sqlite');let store=new Store(file);
  const chat=store.newChat({provider:'codex',workspace:process.cwd()}),other=store.newChat({provider:'claude',workspace:process.cwd()});
  const row=store.queue.add(chat.id,{text:'retained draft',clientId:'id'}),otherRow=store.queue.add(other.id,{text:'other draft',clientId:'other'});
  store.close();store=new Store(file);const restored=new Store(':memory:');
  try{
    assert.equal(store.queue.get(chat.id,row.id).state,'held');assert.equal(store.queue.get(other.id,row.id),null);
    restored.import(store.export());assert.equal(restored.queue.db.prepare('SELECT count(*) AS n FROM queued_messages').get().n,2);
    assert.ok(restored.queue.db.prepare("SELECT count(*) AS n FROM queued_messages WHERE state!='held'").get().n===0);
    store.queue.remove(chat.id,row.id,store.queue.get(chat.id,row.id).revision);assert.equal(store.queue.get(other.id,otherRow.id).content,'other draft');
    store.deleteChat(other.id);assert.equal(store.queue.list(other.id).length,0);assert.equal(store.queue.snapshot(other.id).queueVersion,0);
  }finally{store.close();restored.close();}
});

test('an edited queued request is idempotent even after automatic delivery',async()=>{
  const f=fixture();
  try{
    const initial=await f.runner.start(f.chat.id,'initial');await until(()=>f.calls.length);const data={text:'original',clientId:'retry',runId:initial.id},one=f.runner.enqueue(f.chat.id,data).queued;
    f.runner.editQueued(f.chat.id,one.id,{revision:0,text:'edited'});assert.equal(f.runner.enqueue(f.chat.id,data).queued.id,one.id);
    f.release.resolve();await until(()=>f.calls.length===2&&!f.runner.active.has(f.chat.id));
    assert.equal(f.runner.enqueue(f.chat.id,data).queued.state,'delivered');assert.equal(f.calls.length,2);assert.equal(f.store.queue.list(f.chat.id).length,0);
    assert.throws(()=>f.runner.enqueue(f.chat.id,{...data,text:'another'}),/标识/);
  }finally{await f.close();}
});

test('dispatch failure retains a queued draft and a changed provider cannot silently receive it',async()=>{
  const store=new Store(':memory:'),localRegistry={...registry,probe:async()=>{throw Error('offline');}},runner=new Runner(store,localRegistry,()=>{},{});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()}),row=store.queue.add(chat.id,{text:'keep',clientId:'keep'});
    await assert.rejects(()=>runner.dispatchQueue(chat.id),/offline/);assert.equal(store.queue.get(chat.id,row.id).state,'held');assert.equal(store.messages(chat.id).length,0);
    store.updateChat(chat.id,{provider:'claude'});const held=store.queue.get(chat.id,row.id);await runner.dispatchQueue(chat.id,row.id,held.revision);assert.equal(store.messages(chat.id).length,0);assert.equal(store.queue.get(chat.id,row.id).provider,'codex');
  }finally{await runner.close();store.close();}
});

test('queue HTTP actions enforce token, chat, revision and native steer capability',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'starport-queue-api-')),release=gate();let steers=0;
  const hub=createHub({port:0,dataDir:folder,registry,implementations:{codex:async({setControl})=>{setControl({inputMode:'steer',steer:async()=>{steers++;return {delivery:'accepted'};},stop:release.resolve});await release.promise;}}});
  try{
    const port=await hub.listen(),base='http://127.0.0.1:'+port,chat=hub.store.newChat({provider:'codex',workspace:process.cwd()}),other=hub.store.newChat({provider:'codex',workspace:process.cwd()}),initial=await hub.runner.start(chat.id,'initial');
    await until(()=>hub.runner.state(chat.id).inputReady);const url=base+'/api/chats/'+chat.id+'/queue',headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
    const send=(path,method,data,head=headers)=>fetch(path,{method,headers:head,body:data?JSON.stringify(data):undefined});
    assert.equal((await send(url,'POST',{text:'test',clientId:'one',runId:initial.id},{})).status,401);
    assert.equal((await send(url,'POST',{text:'test',clientId:'one',runId:initial.id},{...headers,Origin:'https://evil.example'})).status,403);
    const response=await send(url,'POST',{text:'test',clientId:'one',runId:initial.id});assert.equal(response.status,202);const row=(await response.json()).queued;assert.equal(steers,0);
    assert.equal((await send(base+'/api/chats/'+other.id+'/queue/'+row.id,'DELETE',{revision:0})).status,404);
    assert.equal((await send(url+'/'+row.id,'PATCH',{text:'edited',revision:99})).status,409);
    const edit=await send(url+'/'+row.id,'PATCH',{text:'edited',revision:0});assert.equal(edit.status,200);
    assert.equal((await send(url+'/'+row.id+'/steer','POST',{revision:1,runId:initial.id})).status,200);assert.equal(steers,1);assert.equal(hub.runner.state(chat.id).id,initial.id);
    assert.equal((await send(url,'GET')).status,200);
  }finally{release.resolve();await hub.close();}
});

test('late queue snapshots cannot restore deleted entries and queued question answers reappear after removal',async()=>{
  const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/live.js',import.meta.url),'utf8'),context);vm.runInContext(await readFile(new URL('../public/questions.js',import.meta.url),'utf8'),context);
  const question='Which mode?\n- A\n- B',message={id:'assistant',role:'assistant',status:'complete',content:question,details:{}},questions=context.StarportQuestions.extract(question),state={chat:{id:'chat'},messages:[message],queue:[],queueVersion:0,run:null,active:[]};
  const row={id:'q',details:{replyTo:{messageId:message.id,questions:[questions[0].id]}}};
  context.StarportLive.applyUpdate(state,{chatId:'chat',queue:[row],queueVersion:1});assert.equal(context.StarportQuestions.latest(state).questions.length,0);
  context.StarportLive.applyUpdate(state,{chatId:'chat',queue:[],queueVersion:2});context.StarportLive.applyUpdate(state,{chatId:'chat',queue:[row],queueVersion:1});
  assert.equal(state.queue.length,0);assert.equal(context.StarportQuestions.latest(state).questions.length,1);
});

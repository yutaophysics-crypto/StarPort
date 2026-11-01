import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage.mjs';
import { createHub } from '../src/server.mjs';
import { unfinishedReply } from '../src/message-trace.mjs';

const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true,nativeAutoReview:true}),models:async()=>({models:[]}),record(){},list:async()=>[]};
const big='x'.repeat(20000);
const log=()=>({
  activity:[
    {id:'t1',kind:'thinking',text:'私下的思考',status:'complete'},
    {id:'c1',kind:'tool',name:'Read',nativeType:'Read',status:'complete',input:{file_path:'a.txt'},output:big},
    {id:'m1',kind:'text',text:'读完了',status:'complete',phase:'final_answer',turnId:'turn-1'}
  ],
  tools:[{id:'c1',name:'Read',status:'complete',input:{file_path:'a.txt'},output:big}]
});

test('a reply keeps an outline of its process log and the log is read apart',()=>{
  const store=new Store(':memory:');
  try{
    const chat=store.newChat({title:'长对话',provider:'claude'});
    store.message(chat.id,'user','claude','读一下');
    const reply=store.message(chat.id,'assistant','claude','读完了','complete',{runId:'r',liveRevision:3,...log()});
    const failed=store.message(chat.id,'assistant','claude','','error',{liveRevision:1,...log()});
    const [, light]=store.messages(chat.id);
    assert.equal(light.deferredTrace,true);
    assert.equal(light.details.tools,undefined,'the tool list waits with the log');
    assert.deepEqual(light.details.activity.map(item=>Object.keys(item).sort()),[['id','kind','status'],['id','kind','name','nativeType','status'],['id','kind','phase','status','text','turnId']]);
    assert.ok(JSON.stringify(light).length<1000,'no input or output in the outline');
    const trace=store.trace(chat.id,reply.id);
    assert.equal(trace.activity[1].output,big);assert.equal(trace.tools[0].output,big);assert.equal(trace.liveRevision,3);
    const full=store.messages(chat.id,{trace:true});
    assert.equal(full[1].deferredTrace,undefined);assert.equal(full[1].details.activity[0].text,'私下的思考');
    const picked=store.messages(chat.id,{trace:unfinishedReply});
    assert.equal(picked[1].deferredTrace,true);
    assert.equal(picked[2].id,failed.id);assert.equal(picked[2].details.activity[1].output,big,'a failed reply hands its tool calls on');
    assert.equal(store.messageById(chat.id,reply.id,{trace:true}).details.tools[0].output,big);
  }finally{store.close();}
});

test('saving an outline leaves the saved log, and a full save replaces it',()=>{
  const store=new Store(':memory:');
  try{
    const chat=store.newChat({title:'对话',provider:'codex'});
    const reply=store.message(chat.id,'assistant','codex','','running',{liveRevision:0,...log()});
    const light=store.lastAssistant(chat.id);
    light.details.subagents=[{id:'child',status:'complete'}];light.status='complete';store.saveMessage(light);
    assert.equal(store.trace(chat.id,reply.id).activity[1].output,big);
    assert.deepEqual(store.lastAssistant(chat.id).details.subagents,[{id:'child',status:'complete'}]);
    reply.details.activity.push({id:'c2',kind:'tool',name:'Bash',status:'complete',input:'ls',output:'a.txt'});store.saveMessage(reply);
    assert.equal(store.trace(chat.id,reply.id).activity.length,4);
    assert.equal(store.lastAssistant(chat.id).details.activity.length,4);
    // A row an older build rewrote in full is its own record, not the stale log beside it.
    store.db.prepare('UPDATE messages SET details=? WHERE id=?').run(JSON.stringify({liveRevision:9,activity:[{id:'old',kind:'tool',input:'dir',output:'newer'}],tools:[]}),reply.id);
    const legacy=store.lastAssistant(chat.id);
    assert.equal(legacy.deferredTrace,undefined);assert.equal(legacy.details.activity[0].output,'newer');
    store.saveMessage(legacy);
    assert.equal(store.trace(chat.id,reply.id).activity[0].output,'newer');assert.equal(store.lastAssistant(chat.id).deferredTrace,true);
  }finally{store.close();}
});

test('branches copy logs, deleted chats take theirs along, and commentary-only replies need none',()=>{
  const store=new Store(':memory:');
  try{
    const chat=store.newChat({title:'源',provider:'claude'});
    store.message(chat.id,'user','claude','问');
    const reply=store.message(chat.id,'assistant','claude','答','complete',log());
    const plain=store.message(chat.id,'assistant','claude','只说话','complete',{activity:[{id:'p',kind:'text',text:'只说话',status:'complete'}],tools:[]});
    assert.equal(store.messageById(chat.id,plain.id).deferredTrace,undefined);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_traces').get().n,1);
    const branch=store.branchChat(chat.id,reply.id);
    const copied=store.messages(branch.id)[1];
    assert.equal(copied.deferredTrace,true);assert.equal(store.trace(branch.id,copied.id).activity[1].output,big);
    store.deleteChat(chat.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM message_traces').get().n,1,'only the branch keeps a log');
    assert.equal(store.export().messages.find(row=>row.id===copied.id).details.activity[1].output,big,'backups carry the whole log');
  }finally{store.close();}
});

test('logs kept inside messages by older builds move out once, after a copy of the database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'starport-trace-')),file=join(dir,'hub.sqlite');
  let store=new Store(file),chatId,replyId;
  try{
    const chat=store.newChat({title:'旧对话',provider:'claude'});chatId=chat.id;
    replyId=store.message(chat.id,'assistant','claude','答').id;
  }finally{store.close();}
  const db=new DatabaseSync(file);
  db.prepare('UPDATE messages SET details=? WHERE id=?').run(JSON.stringify({liveRevision:2,...log()}),replyId);
  db.prepare("DELETE FROM settings WHERE key='messages.traceSplit'").run();db.close();
  store=new Store(file);
  try{
    const row=store.db.prepare('SELECT details FROM messages WHERE id=?').get(replyId);
    assert.ok(row.details.length<1000);
    assert.equal(store.lastAssistant(chatId).deferredTrace,true);
    assert.equal(store.trace(chatId,replyId).activity[1].output,big);
    assert.equal(readdirSync(join(dir,'db-backups')).length,1);
  }finally{store.close();}
  store=new Store(file);store.close();
  assert.equal(readdirSync(join(dir,'db-backups')).length,1,'the move happens once');
});

const source=file=>readFileSync(new URL('../public/'+file,import.meta.url),'utf8');

test('the page keeps a log it has read when the same reply comes again without it',()=>{
  const context=vm.createContext({});vm.runInContext(source('live.js'),context);
  const {preferMessage}=context.StarportLive;
  const full={id:'r',status:'complete',details:{liveRevision:2,activity:[{id:'c',output:big}],tools:[{id:'c',output:big}]}};
  const light=()=>({id:'r',status:'complete',deferredTrace:true,details:{liveRevision:2,activity:[{id:'c'}]}});
  const kept=preferMessage(full,light());
  assert.equal(kept.details.activity[0].output,big);assert.equal(kept.details.tools[0].output,big);assert.equal(kept.deferredTrace,undefined);
  const newer={...light(),details:{liveRevision:3,activity:[{id:'c'}]}};
  assert.equal(preferMessage(full,newer).deferredTrace,true,'a newer save is read again when opened');
});

test('the chat route sends outlines, the trace route the whole log, and a turn saves at most once a second',{timeout:20000},async t=>{
  let saves=0;
  const implementations={claude:async({emit})=>{
    for(let i=0;i<200;i++)emit({type:'delta',text:'字'});
    emit({type:'tool',id:'c1',name:'Read',status:'complete',input:{file_path:'a.txt'},output:big});
    emit({type:'replace',text:'读完了'});emit({type:'final-answer',text:'读完了'});
  }};
  const dataDir=mkdtempSync(join(tmpdir(),'hub-trace-')),workspace=mkdtempSync(join(tmpdir(),'hub-trace-ws-'));
  const hub=createHub({port:0,dataDir,registry,implementations});await hub.listen();t.after(()=>hub.close());
  const save=hub.store.saveMessage.bind(hub.store);hub.store.saveMessage=row=>{if(row.role==='assistant')saves++;return save(row);};
  const base='http://127.0.0.1:'+hub.server.address().port;
  const call=async path=>{const res=await fetch(base+'/api'+path,{headers:{'X-Hub-Token':hub.token,Origin:base}});const json=await res.json();if(!res.ok)throw Object.assign(new Error(json.error),{status:res.status});return json;};
  const chat=hub.store.newChat({provider:'claude',workspace,title:'对话'});
  await fetch(base+'/api/chats/'+chat.id+'/messages',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Token':hub.token,Origin:base},body:JSON.stringify({text:'读一下'})});
  await hub.runner.active.get(chat.id)?.done;
  assert.ok(saves<=3,`saved ${saves} times`);
  const reply=(await call('/chats/'+chat.id)).messages.find(row=>row.role==='assistant');
  assert.equal(reply.content,'读完了');assert.equal(reply.deferredTrace,true);assert.equal(reply.details.activity[0].output,undefined);
  const trace=await call('/chats/'+chat.id+'/messages/'+reply.id+'/trace');
  assert.equal(trace.activity[0].output,big);assert.equal(trace.tools[0].output,big);
  await assert.rejects(call('/chats/'+chat.id+'/messages/missing/trace'),error=>error.status===404);
});

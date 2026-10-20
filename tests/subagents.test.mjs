import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AntigravitySubagents,mergeSubagent,settleSubagents } from '../src/subagents.mjs';
import { Runner } from '../src/runner.mjs';
import { Store } from '../src/storage.mjs';

const parent='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222',nested='33333333-3333-4333-8333-333333333333',old='44444444-4444-4444-8444-444444444444';
const start=Date.parse('2026-09-28T11:18:46Z');
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'starport-subagents-')),brain=join(dir,'brain');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(join(dir,'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,parent_conversation_id TEXT,status TEXT,not_fully_idle INTEGER,killed INTEGER,step_count INTEGER,last_modified_time TEXT)');
  db.close();
  function meta(id=child,owner=parent,state='SUBAGENT_STATE_ALIVE'){
    const folder=join(brain,owner,'.system_generated','subagents');mkdirSync(folder,{recursive:true});
    writeFileSync(join(folder,id+'.json'),JSON.stringify({conversationId:id,subagentDescriptor:{role:'Import format researcher',typeName:'research'},state,spawnStepIndex:29}));
  }
  function transcript(id=child,at=start){
    const folder=join(brain,id,'.system_generated','logs');mkdirSync(folder,{recursive:true});
    const file=join(folder,'transcript.jsonl');
    writeFileSync(file,[{step_index:0,type:'SYSTEM_MESSAGE',created_at:new Date(at).toISOString(),content:'<SYSTEM_MESSAGE>\n[Message] timestamp=now sender='+parent+' priority=MESSAGE_PRIORITY_HIGH content=查找 CSV 导入字段\n</SYSTEM_MESSAGE>'},
      {step_index:1,type:'PLANNER_RESPONSE',created_at:new Date(at+1000).toISOString(),thinking:'PRIVATE_REASONING',tool_calls:[{name:'view_file',args:{toolAction:'"Reading import definitions"'}}]}].map(row=>JSON.stringify(row)+'\n').join(''));
    return file;
  }
  function summary(id=child,owner=parent,status='CASCADE_RUN_STATUS_RUNNING',idle=1,killed=0,count=2,at=start+1000){
    const db=new DatabaseSync(join(dir,'conversation_summaries.db'));
    db.prepare('DELETE FROM conversation_summaries WHERE conversation_id=?').run(id);
    db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?)').run(id,owner,status,idle,killed,count,new Date(at).toISOString());db.close();
  }
  meta();transcript();summary();return {brain,meta,transcript,summary,reader:new AntigravitySubagents(brain)};
}
test('real agy metadata + assignment + native summary expose task and nested counts without reasoning',async t=>{
  const f=fixture(t);f.meta(nested,child);f.transcript(nested,start+2000);f.summary(nested,child);
  const rows=await f.reader.snapshot(parent,{since:start-1000});
  assert.equal(rows.length,2);assert.equal(rows[1].depth,1);assert.equal(rows[1].parentId,child);
  assert.equal(rows[0].task,'查找 CSV 导入字段');assert.equal(rows[0].activity,'Reading import definitions');
  assert.equal(rows[0].status,'running');assert.equal(rows[0].startedAt,start);
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_REASONING'));
});
test('ALIVE idle child finishes only when fully idle; failures and stale summaries are not success',async t=>{
  const f=fixture(t);
  f.summary(child,parent,'CASCADE_RUN_STATUS_IDLE',1);assert.equal((await f.reader.snapshot(parent))[0].status,'running');
  f.summary(child,parent,'CASCADE_RUN_STATUS_IDLE',0);let row=(await f.reader.snapshot(parent))[0];assert.equal(row.status,'complete');assert.equal(row.endedAt,start+1000);
  f.summary(child,parent,'CASCADE_RUN_STATUS_IDLE',0,1);assert.equal((await f.reader.snapshot(parent))[0].status,'interrupted');
  f.summary(child,parent,'CASCADE_RUN_STATUS_IDLE',0,0,1);assert.equal((await f.reader.snapshot(parent))[0].status,'running');
  f.summary();f.meta(child,parent,'SUBAGENT_STATE_KILLED');assert.equal((await f.reader.snapshot(parent))[0].status,'interrupted');
});
test('old children, unrelated sessions, malformed metadata and incomplete JSONL cannot contaminate a turn',async t=>{
  const f=fixture(t);f.meta(old,parent);f.transcript(old,start-60000);f.summary(old,parent,'CASCADE_RUN_STATUS_IDLE',0,0,2,start-59000);
  assert.equal((await f.reader.snapshot(parent,{since:start})).length,1);
  assert.deepEqual(await f.reader.snapshot('../../outside'),[]);
  const file=f.transcript();const update=JSON.stringify({step_index:2,type:'PLANNER_RESPONSE',created_at:new Date(start+5000).toISOString(),tool_calls:[{name:'run_command',args:{toolAction:'"Checking results"'}}]});
  appendFileSync(file,update.slice(0,40));assert.equal((await f.reader.snapshot(parent,{since:start}))[0].activity,'Reading import definitions');
  appendFileSync(file,update.slice(40)+'\n');assert.equal((await f.reader.snapshot(parent,{since:start}))[0].activity,'Checking results');
});
test('duplicate events preserve clocks; only confirmed completions count as completed',()=>{
  const rows=[];mergeSubagent(rows,{id:'a',status:'running',startedAt:100,updatedAt:100});mergeSubagent(rows,{id:'a',status:'running',startedAt:200,updatedAt:300});
  mergeSubagent(rows,{id:'b',status:'error',startedAt:120,updatedAt:400});mergeSubagent(rows,{id:'c',status:'complete',startedAt:140,updatedAt:500});
  mergeSubagent(rows,{id:'c',status:'running',updatedAt:400});
  settleSubagents(rows,'complete',700);
  assert.equal(rows.length,3);assert.equal(rows[0].startedAt,100);assert.equal(rows[0].status,'unknown');assert.equal(rows[0].endedAt,700);
  assert.equal(rows[1].status,'error');assert.equal(rows[2].status,'complete');assert.equal(rows[2].endedAt,500);
});
test('runner broadcasts child progress, saves it for reload, and settles stopped children',async()=>{
  const store=new Store(':memory:'),chat=store.newChat({provider:'antigravity',workspace:process.cwd()}),events=[];
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),record:()=>{}};
  const runner=new Runner(store,registry,(type,data)=>events.push({type,data:structuredClone(data)}),{antigravity:async({emit})=>{
    emit({type:'subagent',id:'a',task:'find operators',startedAt:start,updatedAt:start+1000,status:'running'});
    emit({type:'subagent',id:'b',task:'check equations',startedAt:start,updatedAt:start+2000,status:'complete'});
    throw Object.assign(new Error('stopped'),{canceled:true});
  }});
  await runner.start(chat.id,'test');await runner.active.get(chat.id).done;
  const message=store.messages(chat.id).at(-1);assert.equal(message.details.subagents[0].status,'interrupted');assert.equal(message.details.subagents[1].status,'complete');
  assert.ok(events.some(event=>event.data.message?.details.subagents?.length===2));
  assert.deepEqual((await runner.messages(chat.id)).at(-1).details.subagents,message.details.subagents);store.close();
});
test('history recovery is bounded by the next turn and persists completed native children',async t=>{
  const f=fixture(t);f.summary(child,parent,'CASCADE_RUN_STATUS_IDLE',0);
  const store=new Store(':memory:'),chat=store.newChat({provider:'antigravity',workspace:process.cwd()});
  const message=store.message(chat.id,'assistant','antigravity','done','complete',{sessionId:parent});
  store.db.prepare('UPDATE messages SET created=? WHERE id=?').run(new Date(start-1000).toISOString(),message.id);
  const runner=new Runner(store,{},()=>{});runner.subagentReader=f.reader;
  const recovered=(await runner.messages(chat.id))[0];assert.equal(recovered.details.subagents[0].status,'complete');
  assert.equal(store.messages(chat.id)[0].details.subagents[0].task,'查找 CSV 导入字段');store.close();
});

test('runner polls native children during a quiet parent turn and does not manufacture activity on reread',async t=>{
  const f=fixture(t),store=new Store(':memory:'),chat=store.newChat({provider:'antigravity',workspace:process.cwd()});
  let finish;
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),record:()=>{}};
  const runner=new Runner(store,registry,()=>{},{antigravity:async({emit,setControl})=>{
    emit({type:'session',id:parent});await new Promise(resolve=>{finish=resolve;setControl({stop:resolve});});
  }});runner.subagentReader=f.reader;
  t.after(async()=>{finish?.();await runner.close();store.close();});
  await runner.start(chat.id,'test');const run=runner.active.get(chat.id);
  run.started=new Date(start-1000).toISOString();run.lastEventAt=start-1000;
  await new Promise(resolve=>setTimeout(resolve,2200));
  assert.equal(run.message.details.subagents.length,1);assert.equal(run.lastEventAt,start+1000);
  await new Promise(resolve=>setTimeout(resolve,2100));
  assert.equal(run.message.details.subagents.length,1);assert.equal(run.lastEventAt,start+1000);
  f.summary(child,parent,'CASCADE_RUN_STATUS_IDLE',0);finish();await run.done;
  assert.equal(store.messages(chat.id).at(-1).details.subagents[0].status,'complete');
});


test('native fully idle with a final error stays failed instead of counting as completed',async t=>{
  const f=fixture(t),file=f.transcript();
  appendFileSync(file,JSON.stringify({step_index:2,type:'GENERIC',status:'ERROR',created_at:new Date(start+2000).toISOString()})+'\n');
  f.summary(child,parent,'CASCADE_RUN_STATUS_IDLE',0,0,3,start+2000);
  assert.equal((await f.reader.snapshot(parent))[0].status,'error');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseEvent,runCli } from '../src/adapters/cli.mjs';
import { Runner } from '../src/runner.mjs';
import { Store } from '../src/storage.mjs';

const eof='API error (attempt 1): request failed: Post "https://example.invalid/v1internal:streamGenerateContent?alt=sse": EOF';
const reset='API error (attempt 2): request failed: Post "https://example.invalid/v1internal:streamGenerateContent?alt=sse": write tcp 172.29.0.1:13785->172.29.0.180:443: wsasend: An existing connection was forcibly closed by the remote host.';
const step=(index,type,state='DONE',extra={})=>({event:'step_update',step_update:{step_index:index,step_type:type,state,...extra}});
const result=(error=eof,response='Final',status='ERROR')=>({event:'result',result:{status,response,error,conversation_id:'session'}});
const parse=events=>{const state={};return events.flatMap(event=>parseEvent('antigravity',event,state));};
const completed=[step(3,'error_message'),step(4,'tool','DONE',{tool_name:'run_command'}),step(5,'agent_response','DONE',{text:'Final'})];

for(const error of [eof,reset])test('completed agy answer supersedes its recovered transport error: '+error.split(': ').at(-1),()=>{
  const events=parse([...completed,result(error,' Final\n')]);
  assert.equal(events.some(event=>event.type==='error'),false);
  assert.equal(events.find(event=>event.type==='final-answer').text,' Final\n');
  assert.equal(events.find(event=>event.type==='diagnostic').message,error);
});

test('agy completion can be confirmed by finished streamed text without a full snapshot',()=>{
  const events=parse([step(1,'error_message'),step(2,'agent_response','RUNNING',{text_delta:'Fi'}),step(2,'agent_response','RUNNING',{text_delta:'nal'}),step(2,'agent_response'),result()]);
  assert.equal(events.some(event=>event.type==='error'),false);
});

const failures={
  'partial text':[step(1,'error_message'),step(2,'agent_response','RUNNING',{text:'Final'})],
  'missing native completion':[step(1,'error_message'),{event:'step_update',step_update:{step_index:2,step_type:'agent_response',text:'Final'}}],
  'a newer connection failure':[...completed,step(6,'error_message')],
  'a newer unfinished tool':[...completed,step(6,'tool','RUNNING',{tool_name:'run_command'})],
  'a different final response':[step(1,'error_message'),step(2,'agent_response','DONE',{text:'Intermediate'})],
  'no observed recovery':[step(2,'agent_response','DONE',{text:'Final'})],
};
for(const [name,steps] of Object.entries(failures))test('agy retains a terminal error with '+name,()=>{
  const events=parse([...steps,result()]);
  assert.equal(events.find(event=>event.type==='error').message,eof);
  assert.equal(events.some(event=>event.type==='diagnostic'),false);
});

test('agy does not suppress non-transport errors, cancellation or empty answers',()=>{
  for(const error of ['Authentication failed','API error (attempt 1): request failed: HTTP 403 Forbidden'])
    assert.equal(parse([...completed,result(error)]).find(event=>event.type==='error').message,error);
  assert.ok(parse([...completed,result(eof,'Final','CANCELLED')]).some(event=>event.type==='error'));
  assert.ok(parse([step(1,'error_message'),step(2,'agent_response','DONE',{text:'  '}),result(eof,'  ')]).some(event=>event.type==='error'));
});

test('agy recovery evidence belongs to one native turn, including queued input and flat results',()=>{
  for(const boundary of [result(),step(6,'user_input')]){
    const state={};for(const event of [...completed,boundary])parseEvent('antigravity',event,state);
    assert.ok(parseEvent('antigravity',result(),state).some(event=>event.type==='error'));
  }
  const flat=result().result;
  assert.equal(parse([...completed,flat]).some(event=>event.type==='error'),false);
  assert.equal(parse([result(eof,'Final','SUCCESS')]).some(event=>event.type==='error'),false);
});

const runtime={command:process.execPath,prefixArgs:[resolve('tests/fixtures/antigravity-recovery-cli.mjs')]};
const run=(prompt,extra={})=>runCli({provider:'antigravity',runtime,options:{mode:'accept-edits'},prompt,cwd:process.cwd(),emit:()=>{},setControl:()=>{},...extra});

test('Runner saves recovered completion without an error footer and retains the native session',{timeout:6000},async()=>{
  const store=new Store(':memory:'),records=[];
  const registry={resolve:()=>runtime,probe:async()=>({}),record:(...args)=>records.push(args)};
  const runner=new Runner(store,registry,()=>{}),chat=store.newChat({provider:'antigravity',workspace:process.cwd()});
  try{
    await runner.start(chat.id,'recovered');await runner.active.get(chat.id).done;
    const message=store.lastAssistant(chat.id);
    assert.equal(message.status,'complete');assert.equal(message.content,'Final recovered');assert.equal(message.details.error,undefined);
    assert.equal(message.details.diagnostics[0].message,eof);
    assert.equal(store.session(chat.id,'antigravity').native_id,'recovery-session');
    assert.equal(records.at(-1)[1],true);
  }finally{await runner.close();store.close();}
});

test('Runner still saves an unrecovered connection error as a failed task with its error footer',{timeout:6000},async()=>{
  const store=new Store(':memory:'),records=[];
  const registry={resolve:()=>runtime,probe:async()=>({}),record:(...args)=>records.push(args)};
  const runner=new Runner(store,registry,()=>{}),chat=store.newChat({provider:'antigravity',workspace:process.cwd()});
  try{
    await runner.start(chat.id,'failed');await runner.active.get(chat.id).done;
    const message=store.lastAssistant(chat.id);
    assert.equal(message.status,'error');assert.equal(message.details.error,eof);
    assert.equal(message.content,'Final failed');assert.equal(store.session(chat.id,'antigravity'),undefined);
    assert.equal(records.at(-1)[1],false);
  }finally{await runner.close();store.close();}
});

test('recovered agy turns still deliver queued input; later failures remain failures',{timeout:6000},async()=>{
  for(const prompt of ['recovered again','failed']){
    const events=[];let queued;
    const running=run('recovered',{emit:event=>events.push(event),setControl:control=>{queued=control.steer(prompt,{id:'next'});}});
    await queued;
    if(prompt==='failed')await assert.rejects(running,/EOF/);else await running;
    assert.deepEqual(events.filter(event=>event.type==='replace').map(event=>event.text),['Final recovered','Final '+prompt]);
    assert.deepEqual(events.filter(event=>event.type==='input-consumed').map(event=>event.id),['next']);
  }
});

test('agy partial output and explicit stop remain unsuccessful',{timeout:6000},async()=>{
  await assert.rejects(run('partial'),/EOF/);
  const controller=new AbortController();
  await assert.rejects(run('cancel',{signal:controller.signal,emit:event=>{if(event.type==='activity'&&event.item.status==='complete'&&event.item.text)controller.abort();}}),error=>error.canceled===true);
});

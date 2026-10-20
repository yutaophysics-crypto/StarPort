import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeActivity,settleActivity } from '../src/activity.mjs';
import { recoverActivity } from '../src/activity-history.mjs';
import { parseEvent } from '../src/adapters/cli.mjs';
import { parseCodexActivity } from '../src/adapters/codex-events.mjs';
import { parseDeepseekEvent,runDeepseek } from '../src/adapters/deepseek.mjs';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import {mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('Claude thinking, tool input streams and nested output retain order without duplicate text or signatures',()=>{
  const state={},rows=[],events=[];
  const feed=e=>{const parsed=parseEvent('claude',e,state);events.push(...parsed);for(const event of parsed)if(['tool','activity'].includes(event.type))mergeActivity(rows,event);};
  feed({type:'stream_event',event:{type:'message_start',message:{id:'msg1'}}});
  feed({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});
  feed({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Native summary'}}});
  feed({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'PRIVATE_SIGNATURE'}}});
  feed({type:'stream_event',event:{type:'content_block_stop',index:0}});
  feed({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'text',text:''}}});
  feed({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Checking.'}}});
  feed({type:'stream_event',event:{type:'content_block_start',index:2,content_block:{type:'tool_use',id:'tool1',name:'Bash',input:{}}}});
  feed({type:'stream_event',event:{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"command":"echo ok"}'}}});
  feed({type:'stream_event',event:{type:'content_block_stop',index:2}});
  feed({type:'assistant',message:{id:'msg1',content:[{type:'thinking',thinking:'Native summary'},{type:'text',text:'Checking.'},{type:'tool_use',id:'tool1',name:'Bash',input:{command:'echo ok'}}]}});
  feed({type:'assistant',parent_tool_use_id:'tool1',message:{id:'child',content:[{type:'text',text:'Child output'}]}});
  feed({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool1',content:[{type:'text',text:'ok'}]}]}});
  assert.deepEqual(rows.map(row=>row.kind),['thinking','text','tool','text']);
  assert.equal(rows[0].text,'Native summary');assert.equal(rows[1].text,'Checking.');assert.equal(rows[2].input.command,'echo ok');assert.equal(rows[2].status,'complete');
  assert.equal(events.filter(event=>event.type==='delta').map(event=>event.text).join(''),'Checking.');
  assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_SIGNATURE/);assert.equal(rows[3].scope,'tool1');
});

test('Claude completed single-block snapshots reuse streamed ids without overwriting thinking',()=>{
  const rows=[],state={},feed=event=>{for(const item of parseEvent('claude',event,state))if(['tool','activity'].includes(item.type))mergeActivity(rows,item);};
  feed({type:'stream_event',event:{type:'message_start',message:{id:'same-message'}}});
  feed({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});
  feed({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Summary'}}});
  feed({type:'assistant',uuid:'thinking-envelope',message:{id:'same-message',content:[{type:'thinking',thinking:'Summary'}]}});
  feed({type:'stream_event',event:{type:'content_block_start',index:1,content_block:{type:'text',text:''}}});
  feed({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Answer'}}});
  feed({type:'assistant',uuid:'text-envelope',message:{id:'same-message',content:[{type:'text',text:'Answer'}]}});
  assert.deepEqual(rows.map(row=>[row.kind,row.text]),[['thinking','Summary'],['text','Answer']]);
});

test('Codex exposes summary only, reconciles streaming output and honors exit, denial and plan status',()=>{
  const rows=[],state={},feed=(method,params)=>{for(const event of parseCodexActivity(method,params,state))mergeActivity(rows,event);};
  feed('item/started',{item:{id:'r',type:'reasoning',summary:[],content:['PRIVATE_REASONING']}});
  feed('item/reasoning/summaryTextDelta',{itemId:'r',summaryIndex:0,delta:'Inspect sources'});
  feed('item/reasoning/textDelta',{itemId:'r',delta:'PRIVATE_REASONING'});
  feed('item/completed',{item:{id:'r',type:'reasoning',summary:['Inspect sources'],content:['PRIVATE_REASONING']}});
  feed('item/started',{item:{id:'cmd',type:'commandExecution',command:'node --version',cwd:'C:\\test'}});
  feed('item/commandExecution/outputDelta',{itemId:'cmd',delta:'v24.'});
  feed('item/commandExecution/outputDelta',{itemId:'cmd',delta:'14.0'});
  assert.equal(rows[1].output,'v24.14.0');
  feed('item/completed',{item:{id:'cmd',type:'commandExecution',command:'node --version',aggregatedOutput:'v24.14.0',exitCode:1,status:'completed'}});
  feed('item/completed',{item:{id:'denied',type:'fileChange',status:'declined',changes:[{path:'a',kind:'update',diff:'-a\n+b'}]}});
  feed('turn/plan/updated',{turnId:'turn1',plan:[{step:'Verify',status:'inProgress'}]});
  assert.equal(rows[0].text,'Inspect sources');assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_REASONING/);
  assert.equal(rows[1].status,'error');assert.equal(rows[2].status,'denied');assert.equal(rows[3].plan[0].status,'inProgress');
});

test('DeepSeek exposed reasoning remains separate from answer and native structured tool output is intact',()=>{
  const rows=[],state={},parsed=parseDeepseekEvent({seq:4,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'reasoning',text:'Exposed thought'},{type:'text',text:'Answer'}]}}},state);
  for(const event of parsed)if(['tool','activity'].includes(event.type))mergeActivity(rows,event);
  assert.deepEqual(rows.map(row=>row.kind),['thinking','text']);assert.equal(parsed.find(event=>event.type==='delta').text,'Answer\n\n');
  const result=parseDeepseekEvent({type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'t',content:[{type:'text',text:'x'.repeat(15000)}]}]},meta:{diff:'native diff'}}})[0];
  assert.equal(result.output.length,15000);assert.equal(result.meta.diff,'native diff');
});

test('DeepSeek SDK preserves child tools and failures without mixing child text into the parent answer',async()=>{
  const events=[];await runDeepseek({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/deepseek-activity-rpc.mjs')]},options:{provider:'fixture',model:'fixture'},prompt:'check',cwd:process.cwd(),emit:event=>events.push(event),setControl:()=>{}});
  assert.equal(events.filter(event=>event.type==='delta').map(event=>event.text).join(''),'Parent answer\n\n');
  assert.ok(events.some(event=>event.type==='activity'&&event.item.scope==='child'&&event.item.text==='Child summary'));
  assert.ok(events.some(event=>event.type==='tool'&&event.id==='child:t'&&event.status==='error'));
  assert.equal(events.filter(event=>event.type==='subagent').at(-1).status,'error');
});

test('Claude exposes native task lifecycle while keeping housekeeping events out of conversation activity',()=>{
  const state={},start=parseEvent('claude',{type:'system',subtype:'task_started',task_id:'agent1',task_type:'local_agent',subagent_type:'Explore',description:'Inspect files',spawn_depth:1},state);
  assert.equal(start.find(event=>event.type==='subagent').status,'running');
  const stopped=parseEvent('claude',{type:'system',subtype:'task_notification',task_id:'agent1',status:'stopped',summary:'Stopped'},state);
  assert.equal(stopped.find(event=>event.type==='subagent').status,'interrupted');
  assert.deepEqual(parseEvent('claude',{type:'system',subtype:'task_started',task_id:'watcher',task_type:'local_agent',ambient:true},state),[]);
  assert.deepEqual(parseEvent('claude',{type:'system',subtype:'task_progress',task_id:'watcher',description:'Housekeeping'},state),[]);
  assert.equal(parseEvent('claude',{type:'system',subtype:'task_progress',task_id:'agent1',description:'Late update'},state).find(event=>event.type==='subagent').status,'interrupted');
});

test('native recovery needs one unambiguous bound turn and does not fabricate missing completion',()=>{
  const message={content:'Final',status:'complete',details:{tools:[{id:'t1'}]}};
  const source={messages:[{role:'user',content:'hi'},{role:'assistant',content:'Checking',details:{activity:[{id:'t1',kind:'tool',status:'running'}]}},{role:'assistant',content:'Final',details:{activity:[{id:'a',kind:'text',text:'Final',status:'complete'}]}}]};
  const rows=recoverActivity(message,source);assert.equal(rows[0].status,'unknown');assert.equal(rows[1].text,'Final');
  assert.equal(recoverActivity(message,{messages:[...source.messages,...source.messages]}),null);
  assert.equal(recoverActivity({...message,content:'unmatched',details:{tools:[]}},source),null);
});

test('runner persists ordered native activity across reload and leaves unconfirmed tools unknown',async t=>{
  const file=join(mkdtempSync(join(tmpdir(),'starport-activity-db-')),'db.sqlite');let store=new Store(file);t.after(()=>store.close());const registry={resolve:()=>({command:process.execPath}),probe:async()=>({}),record:()=>{}};
  const runner=new Runner(store,registry,()=>{},{claude:async({emit})=>{
    emit({type:'activity',item:{id:'think',kind:'thinking',text:'Native summary',status:'complete'}});
    emit({type:'tool',id:'t',name:'Bash',status:'running',input:{command:'echo hi'}});
    emit({type:'activity',item:{id:'a',kind:'text',text:'Final',status:'complete'}});emit({type:'replace',text:'Final'});
  }});
  const chat=store.newChat({provider:'claude',workspace:process.cwd()});await runner.start(chat.id,'hi');await runner.active.get(chat.id).done;
  const saved=store.messages(chat.id).at(-1);assert.deepEqual(saved.details.activity.map(row=>row.id),['think','t','a']);assert.equal(saved.details.tools[0].status,'unknown');
  assert.equal(saved.details.activity[1].status,'unknown');assert.equal(saved.content,'Final');
  store.close();store=new Store(file);assert.deepEqual(store.messages(chat.id).at(-1).details.activity,saved.details.activity);
  const interrupted={activity:[{id:'t',status:'running'}],tools:[]};settleActivity(interrupted,'interrupted');assert.equal(interrupted.activity[0].status,'interrupted');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {parseClaudeEvent} from '../src/adapters/claude-events.mjs';
import {parseCodexActivity} from '../src/adapters/codex-events.mjs';
import {parseAntigravityEvent} from '../src/adapters/antigravity-events.mjs';
import {parseDeepseekEvent} from '../src/adapters/deepseek.mjs';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {runCodex} from '../src/adapters/codex.mjs';

const source=readFileSync(new URL('../public/activity-model.js',import.meta.url),'utf8');
function load(saved=new Map()){
  const sandbox={localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}};
  runInNewContext(source,sandbox);return sandbox.StarportActivityModel;
}
const model=load(),message=(activity,fields={})=>({id:'message',status:'complete',content:'',details:{activity},...fields});

test('display preference persists independently of provider and rejects unknown levels',()=>{
  const saved=new Map(),first=load(saved);assert.equal(first.level,'overview');first.setLevel('hidden');
  const next=load(saved);assert.equal(next.level,'hidden');next.setLevel('invented');assert.equal(next.level,'hidden');next.setLevel('full');assert.equal(load(saved).level,'full');
});
test('terminal transition folds a manually opened running workflow exactly once, including stop/failure',()=>{
  for(const outcome of ['complete','error','interrupted']){
    const views=new model.DisclosureState();assert.equal(views.root('m','running'),true);views.set('m',true);
    assert.equal(views.root('m',outcome),false);views.set('m',true);assert.equal(views.root('m',outcome),true);
    assert.equal(views.root('other',outcome),false);
  }
});
test('saved authoritative final answer keeps all blocks while earlier commentary remains in the workflow',()=>{
  const final='First paragraph\n\nSecond paragraph\n\n$$E=mc^2$$';
  const msg=message([{id:'intro',kind:'text',text:'Checking'},{id:'a',kind:'text',text:'First paragraph'},{id:'b',kind:'text',text:'Second paragraph'}],{content:'Checking'+final,details:{finalAnswer:final,activity:[{id:'intro',kind:'text',text:'Checking'}]}});
  assert.equal(model.answer(msg).text,final);assert.equal(model.entries(msg)[0].record.text,'Checking');
  assert.equal(msg.content,'Checking'+final,'display does not rewrite the saved message');
});
test('Codex goal history displays only the last turn final answer and retains previous answers as activity',()=>{
  const msg=message([{id:'f1',kind:'text',text:'First result',phase:'final_answer',turnId:'1'},{id:'t',kind:'tool',name:'Continue'},{id:'f2a',kind:'text',text:'Final A',phase:'final_answer',turnId:'2'},{id:'f2b',kind:'text',text:'Final B',phase:'final_answer',turnId:'2'}]);
  assert.equal(model.answer(msg).text,'Final A\n\nFinal B');assert.ok(model.entries(msg).some(entry=>entry.record?.id==='f1'));
});
test('legacy accumulated messages separate final text after the last root step, keeping scoped replies out',()=>{
  const msg=message([{id:'s1',kind:'step'},{id:'intro',kind:'text',text:'Later'},{id:'child',kind:'text',text:'Child reply',scope:'child'},{id:'s2',kind:'step'},{id:'final',kind:'text',text:'Final'}],{content:'Later\n\nFinal\n\n'});
  assert.equal(model.answer(msg).text,'Final');assert.equal(model.entries(msg).find(entry=>entry.type==='agent').agent.records[0].text,'Child reply');
});
test('Claude lifecycle task ids and native tool scopes form one agent view without duplicate cards',()=>{
  const event=parseClaudeEvent({type:'system',subtype:'task_started',task_id:'task',task_type:'local_agent',subagent_type:'Explore',tool_use_id:'delegate',description:'Check layout'},{}) .find(event=>event.type==='subagent');
  assert.equal(event.scope,'delegate');
  const msg=message([{id:'delegate',kind:'tool',name:'Agent'},{id:'think',kind:'thinking',scope:'delegate',text:'Exposed summary'},{id:'claude-task:task',kind:'task',scope:'delegate'}],{status:'running'});msg.details.subagents=[event];
  const entries=model.entries(msg);assert.equal(entries.length,1);assert.equal(entries[0].agent.id,'task');assert.equal(entries[0].agent.records.length,3);
});
test('nested child records stay with their owner and malformed parent cycles cannot recurse',()=>{
  const msg=message([{id:'a-tool',kind:'tool',scope:'a'},{id:'b-tool',kind:'tool',scope:'b'}]);
  msg.details.subagents=[{id:'a',status:'complete'},{id:'b',parentId:'a',status:'complete'}];
  let entries=model.entries(msg);assert.equal(entries.length,1);assert.equal(entries[0].agent.children[0].records[0].id,'b-tool');
  msg.details.subagents[0].parentId='b';entries=model.entries(msg);assert.equal(entries.length,2);assert.equal(entries[0].agent.children.length,0);
});
test('unconfirmed children never become successful just because the parent finished',()=>{
  const msg=message([{id:'child-tool',kind:'tool',scope:'child',status:'complete'}]);msg.details.subagents=[{id:'child',status:'running'}];
  assert.equal(model.entries(msg)[0].agent.status,'unknown');msg.status='interrupted';assert.equal(model.entries(msg)[0].agent.status,'interrupted');
});
test('a live native plan is running even though its update event is committed; unfinished plans remain unconfirmed',()=>{
  const plan={kind:'plan',status:'complete',plan:[{step:'Check',status:'completed'},{step:'Verify',status:'inProgress'}]};
  assert.equal(model.status(plan,{status:'running'}),'running');assert.equal(model.status(plan,{status:'complete'}),'unknown');
});
test('late legacy tool metadata cannot discard earlier blocks of a final answer',()=>{
  const msg=message([{id:'a',kind:'text',text:'First paragraph'},{id:'b',kind:'text',text:'Second paragraph'},{id:'late',kind:'tool',status:'denied'}],{content:'First paragraph\n\nSecond paragraph'});
  assert.equal(model.answer(msg).text,msg.content);
});
test('native final outcomes expose authoritative answers without exposing child replies or signature blocks',()=>{
  const cc=parseClaudeEvent({type:'result',subtype:'success',result:'Complete answer',session_id:'cc'},{});
  assert.equal(cc.find(event=>event.type==='final-answer').text,'Complete answer');
  const agy=parseAntigravityEvent({event:'result',result:{status:'SUCCESS',response:'Agy answer'}},{});
  assert.equal(agy.find(event=>event.type==='final-answer').text,'Agy answer');
  const state={};parseDeepseekEvent({type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'Exposed summary'},{type:'text',text:'Part 1'},{type:'text',text:' Part 2'}]}}},state);
  assert.equal(state.lastAssistantText,'Part 1 Part 2');
});
test('Codex collaboration retains native child status and scoped delegation without treating shutdown as success',()=>{
  const state={},events=parseCodexActivity('item/completed',{threadId:'parent',item:{id:'delegate',type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',senderThreadId:'parent',receiverThreadIds:['a','b'],prompt:'Inspect',agentsStates:{a:{status:'running'},b:{status:'errored',message:'Failed'}}}},state);
  assert.equal(events.find(event=>event.type==='subagent'&&event.id==='a').scope,'delegate');assert.equal(events.find(event=>event.type==='subagent'&&event.id==='b').status,'error');
  const stopped=parseCodexActivity('item/completed',{threadId:'parent',item:{id:'close',type:'collabAgentToolCall',tool:'closeAgent',status:'completed',senderThreadId:'parent',receiverThreadIds:['a'],agentsStates:{a:{status:'shutdown'}}}},state);
  assert.equal(stopped.find(event=>event.type==='subagent').status,'unknown');
});
test('Runner persists final answer separately while retaining all raw commentary and activity',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'starport-final-answer-')),store=new Store(join(directory,'hub.sqlite'));
  const registry={resolve:()=>({command:process.execPath}),probe:async()=>({}),record:()=>{}};
  const runner=new Runner(store,registry,()=>{},{deepseek:async({emit})=>{
    emit({type:'delta',text:'Checking\n\nFinal'});emit({type:'activity',item:{id:'intro',kind:'text',text:'Checking'}});emit({type:'final-answer',text:'Final'});
  }});t.after(async()=>{await runner.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const chat=store.newChat({provider:'deepseek',workspace:process.cwd()});await runner.start(chat.id,'hi');await runner.active.get(chat.id).done;
  const saved=store.messages(chat.id).at(-1);assert.equal(saved.details.finalAnswer,'Final');assert.equal(saved.content,'Checking\n\nFinal');assert.equal(saved.details.activity[0].text,'Checking');
});

test('Codex native child notifications are scoped, do not finish the root turn, and never leak into parent answer/usage',{timeout:10000},async()=>{
  const events=[];
  await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/codex-child-activity-rpc.mjs')]},options:{permissionMode:'ask'},prompt:'fixture',cwd:process.cwd(),signal:AbortSignal.timeout(6000),emit:event=>events.push(event),setControl:()=>{}});
  assert.equal(events.filter(event=>event.type==='replace').at(-1).text,'Parent final answer');
  assert.ok(events.some(event=>event.type==='activity'&&event.item.id==='child:reason'&&event.item.scope==='child'&&event.item.text==='Child public summary'));
  assert.ok(events.some(event=>event.type==='subagent'&&event.id==='child'&&event.status==='complete'));
  assert.ok(events.some(event=>event.type==='subagent'&&event.name==='Layout reviewer'));
  assert.equal(events.filter(event=>event.type==='usage').length,0);
  assert.doesNotMatch(JSON.stringify(events),/FOREIGN_MESSAGE|PRIVATE_REASONING/);
});

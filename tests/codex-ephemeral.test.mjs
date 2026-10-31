import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runCodex} from '../src/adapters/codex.mjs';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';

function nativeFixture(scenario='success'){
  const workspace=mkdtempSync(join(tmpdir(),'sp-ephemeral-')),scenarioFile=join(workspace,'scenario.txt'),logFile=join(workspace,'rpc.jsonl');
  writeFileSync(logFile,'');writeFileSync(scenarioFile,scenario);
  return {workspace,runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/codex-ephemeral-rpc.mjs'),scenarioFile,logFile]},
    calls:()=>readFileSync(logFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}
function runnerFixture(t,scenario='success'){
  const f=nativeFixture(scenario),store=new Store(':memory:');t.after(()=>store.close());
  const registry={resolve:()=>f.runtime,probe:async()=>({nativeGoal:true,nativePlan:true}),record(){},list:async()=>[]};
  const runner=new Runner(store,registry,()=>{});t.after(()=>runner.close());
  const chat=store.newChat({provider:'codex',title:'Fictional project',workspace:f.workspace});
  return {...f,store,runner,chat};
}
const deskOf=f=>meta=>f.store.newChat({provider:'codex',title:'[工位] Fictional',workspace:f.workspace,options:{codex:{},desk:{parentChatId:f.chat.id,...meta}}});

test('ephemeral threads are never probed for turns they cannot list',async()=>{
  // The plain run is the control: on the same slow turn its status check does read the thread.
  for(const ephemeral of [true,false]){
    const f=nativeFixture('slow'),events=[];
    await runCodex({runtime:f.runtime,options:{mode:'chat'},ephemeral,prompt:'Fixture',cwd:f.workspace,signal:AbortSignal.timeout(8000),emit:e=>events.push(e),setControl(){},reconcileIntervalMs:20,reconcileAfterMs:0});
    const calls=f.calls();
    assert.equal(calls.find(c=>c.method==='thread/start').params.ephemeral,ephemeral?true:undefined);
    assert.equal(calls.some(c=>c.method==='thread/read'),!ephemeral);
    assert.equal(events.find(e=>e.type==='session').ephemeral,ephemeral?true:undefined);
    assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'Fixture answer');
  }
});

test('only one-off desks get ephemeral threads, and they save no session to resume',async t=>{
  const f=runnerFixture(t),desk=deskOf(f);
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

test('a Codex that ignores the ephemeral option keeps a resumable desk session',async t=>{
  const f=runnerFixture(t,'no-ephemeral'),chat=deskOf(f)({compact:true}),events=[];
  await runCodex({runtime:f.runtime,options:{mode:'chat'},ephemeral:true,prompt:'Fixture',cwd:f.workspace,signal:AbortSignal.timeout(8000),emit:e=>events.push(e),setControl(){}});
  assert.equal(events.find(e=>e.type==='session').ephemeral,undefined);
  const run=await f.runner.start(chat.id,'Fixture request',[],{desk:true,memory:{}});await run.done;
  assert.equal(f.store.lastAssistant(chat.id).status,'complete');
  assert.ok(f.store.session(chat.id,'codex'));
});

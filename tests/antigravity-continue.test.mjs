import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../src/adapters/cli.mjs';
import { Runner } from '../src/runner.mjs';
import { Store } from '../src/storage.mjs';
import { Workflows } from '../src/workflows.mjs';

const runtime={command:process.execPath,prefixArgs:[resolve('tests/fixtures/antigravity-continue-cli.mjs')]};
const cutoff='Your previous response was cut off because it exceeded the output token limit\nPlease continue from where you left off, keeping your response shorter\nRetries remaining: 0';
const closed='API error (attempt 3): request failed: Post "https://example.invalid/v1internal:streamGenerateContent?alt=sse": write tcp 10.0.0.1:6908->10.0.0.2:443: use of closed network connection';
const quota='Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4m2s.';

function scene(error,fails){
  const cwd=mkdtempSync(join(tmpdir(),'agy-continue-'));
  writeFileSync(join(cwd,'scenario.json'),JSON.stringify({error,fails}));
  return cwd;
}
const turns=cwd=>JSON.parse(readFileSync(join(cwd,'turns.json'),'utf8'));
function run(cwd,extra={}){
  const events=[];
  return {events,done:runCli({provider:'antigravity',runtime,options:{mode:'accept-edits'},prompt:'Draw the cover.',cwd,
    emit:event=>events.push(event),setControl:()=>{},unattended:true,...extra})};
}

test('an unattended agy cut off at its output limit is resumed in the same conversation and finishes',{timeout:15000},async()=>{
  const cwd=scene(cutoff,1),{events,done}=run(cwd);
  await done;
  const [first,second]=turns(cwd);
  assert.equal(turns(cwd).length,2);
  assert.equal(first.args.includes('--conversation'),false);
  assert.equal(second.args[second.args.indexOf('--conversation')+1],'continue-session');
  assert.match(second.prompt,/从停下的地方接着做/);
  assert.deepEqual(events.filter(event=>event.type==='replace').map(event=>event.text),['Started.','Delivered.']);
  assert.deepEqual(events.filter(event=>event.type==='notice').map(event=>event.text),['Antigravity 因单次回复超出了输出上限中途停下，已在同一会话里请它接着做（1/2）。']);
  const continued=events.find(event=>event.type==='diagnostic'&&event.kind==='antigravity-continued');
  assert.equal(continued.attempt,1);assert.match(continued.message,/exceeded the output token limit/);
  // The resumed turn's steps keep agy's conversation-wide numbering, so the first part's log stays.
  assert.ok(events.some(event=>event.type==='tool'&&event.id==='agy:2'));
  assert.ok(events.some(event=>event.type==='activity'&&event.item.id==='agy:11'));
});

test('a turn that keeps stopping is handed back after two continues, saying why',{timeout:15000},async()=>{
  const cwd=scene(closed,5),{events,done}=run(cwd);
  await assert.rejects(done,error=>/因连接中断中途停下，已自动请它接着做 2 次，仍未完成/.test(error.message)&&/use of closed network connection/.test(error.message));
  assert.equal(turns(cwd).length,3);
  assert.equal(events.filter(event=>event.type==='notice').length,2);
});

test('attended chats, lasting errors and a stop are not continued',{timeout:15000},async()=>{
  for(const [error,extra] of [[cutoff,{unattended:false}],[quota,{}]]){
    const cwd=scene(error,1),{done}=run(cwd,extra);
    await assert.rejects(done);
    assert.equal(turns(cwd).length,1);
  }
  const controller=new AbortController(),cwd=scene(cutoff,1);
  const {done}=run(cwd,{signal:controller.signal,emit:event=>{if(event.type==='notice')controller.abort();}});
  await assert.rejects(done,error=>error.canceled===true);
  assert.equal(turns(cwd).length,1);
});

test('a called agy companion that stops mid-turn is continued, and its card says so',{timeout:20000},async t=>{
  const dataDir=scene(cutoff,1),store=new Store(join(dataDir,'test.sqlite'));
  const runner=new Runner(store,{resolve:()=>runtime,probe:async()=>({}),record(){}},()=>{});
  const workflows=new Workflows({store,runner,dataDir});
  t.after(async()=>{workflows.runs.clear();await runner.close();store.close();});
  const chat=store.newChat({workspace:dataDir});
  workflows.createCompanion({name:'画师',provider:'antigravity'},{id:'painter'});
  const run=workflows.createRun(chat,{title:'调用',trigger:'dispatch'});
  const step={key:'s',companionId:'painter',companionName:'画师',order:1,task:'画封面',notes:[],status:'waiting',attempt:0};
  run.card.details.workflowRun.steps.push(step);
  await workflows.runStep(run,chat,step,{mode:'call',callerName:'主模型',chain:['main']});
  assert.equal(step.status,'done',step.error);assert.equal(step.output,'Delivered.');
  assert.deepEqual(step.notes.filter(note=>note.includes('接着做')),['Antigravity 因单次回复超出了输出上限中途停下，已在同一会话里请它接着做（1/2）。']);
  const message=store.messageById(step.deskChatId,step.deskMessageId);
  assert.equal(message.status,'complete');assert.equal(message.details.error,undefined);
});

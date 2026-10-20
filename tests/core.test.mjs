import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store,buildContext } from '../src/storage.mjs';
import { PROVIDERS,validateOptions,runtimeFingerprint } from '../src/providers.mjs';
import { parseEvent,cliArguments } from '../src/adapters/cli.mjs';
import { parseDeepseekEvent } from '../src/adapters/deepseek.mjs';
import { runCodex } from '../src/adapters/codex.mjs';
import { Runner } from '../src/runner.mjs';
import { createHub } from '../src/server.mjs';

test('SQLite retains groups, messages, provider options; interrupted runs survive restart',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'hub-store-')),'db.sqlite');let s=new Store(file);
  const group=s.group('论文'),chat=s.newChat({group_id:group.id,workspace:process.cwd(),options:{codex:{mode:'goal'},claude:{permissionMode:'plan'}}});
  s.message(chat.id,'user','codex','研究 α');s.message(chat.id,'assistant','codex','部分输出','running');s.close();s=new Store(file);
  assert.equal(s.list().groups[0].name,'论文');assert.equal(s.chat(chat.id).options.codex.mode,'goal');assert.equal(s.messages(chat.id)[1].status,'interrupted');s.close();
});
test('backup import is additive and rolls back malformed imports',()=>{
  const s=new Store(':memory:'),g=s.group('group'),c=s.newChat({group_id:g.id});s.message(c.id,'user','codex','important');
  const backup=s.export();assert.equal(s.import(backup).chats,1);assert.equal(s.list().chats.length,2);
  const broken=structuredClone(backup);broken.messages[0].role='invalid';assert.throws(()=>s.import(broken));assert.equal(s.list().chats.length,2);s.close();
});
test('context bridges intervening providers and explicitly reports truncation',()=>{
  const messages=[{id:'a',role:'user',content:'old'},{id:'b',role:'assistant',provider:'codex',content:'answer',status:'complete'},{id:'c',role:'user',content:'new'},{id:'d',role:'assistant',provider:'claude',content:'different',status:'complete'},{id:'e',role:'user',content:'continue'}];
  const next=buildContext(messages,'b');assert.ok(next.text.includes('different'));assert.ok(!next.text.includes('answer'));
  const short=buildContext(messages,null,10);assert.ok(short.omitted>0);assert.ok(short.text.includes('continue'));assert.ok(short.text.includes('仍完整保存'));
});
test('provider capabilities differ and invalid options are rejected',()=>{
  assert.equal(PROVIDERS.codex.fields.some(f=>f.key==='tokenBudget'),true);assert.equal(PROVIDERS.claude.fields.some(f=>f.key==='tokenBudget'),false);
  assert.throws(()=>validateOptions('codex',{permissionMode:'allow-everything'}));assert.throws(()=>validateOptions('codex',{tokenBudget:-1}));
  const args=cliArguments('claude',validateOptions('claude',{permissionMode:'plan',worktree:true}));assert.ok(args.includes('--worktree'));assert.ok(!args.includes('--dangerously-skip-permissions'));
});
test('Windows runtime verification survives executable path casing changes',()=>{
  const first=runtimeFingerprint({command:'C:/Program Files/nodejs/node.exe',prefixArgs:['dsh.js']});
  const second=runtimeFingerprint({command:'C:/Program Files/nodejs/node.EXE',prefixArgs:['dsh.js']});
  assert.equal(first===second,process.platform==='win32');
});
test('Claude stream normalizer separates nested agents and surfaces failed results',()=>{
  const state={};assert.equal(parseEvent('claude',{type:'stream_event',event:{delta:{type:'text_delta',text:'你好'}}},state)[0].text,'你好');
  const child=parseEvent('claude',{type:'assistant',parent_tool_use_id:'child',message:{content:[{type:'text',text:'child reply'}]}},state);
  assert.ok(!child.some(e=>e.type==='delta'));assert.equal(child.find(e=>e.type==='activity').item.scope,'child');
  const result=parseEvent('claude',{type:'result',is_error:true,errors:['account disabled'],session_id:'s'},state);assert.ok(result.some(e=>e.type==='error'&&e.message==='account disabled'));
});
test('Antigravity result uses nested protocol envelope and errors do not become success',()=>{
  const state={};const out=parseEvent('antigravity',{event:'result',result:{status:'ERROR',error:'login required',conversation_id:'a',response:''}},state);
  assert.equal(state.terminal,true);assert.ok(out.some(e=>e.type==='error'));assert.equal(out[0].id,'a');
});
test('DeepSeek SDK reads committed answers and structured turn outcomes',()=>{
  const out=parseDeepseekEvent({type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'internal'},{type:'text',text:'answer'}]}}});assert.equal(out[0].text,'answer\n\n');
  assert.equal(parseDeepseekEvent({type:'turn/end',data:{reason:{kind:'error',error:{message:'failed'}}}})[0].reason.error.message,'failed');
});
test('native Codex goal continues until the native state is complete',async()=>{
  const events=[];await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/codex-rpc.mjs')]},options:{mode:'goal',objective:'Finish',sandbox:'read-only',tokenBudget:1000},prompt:'Start',cwd:process.cwd(),signal:new AbortController().signal,emit:e=>events.push(structuredClone(e)),setControl:()=>{}});
  assert.equal(events.filter(e=>e.type==='notice').length,1);assert.equal(events.filter(e=>e.type==='goal').at(-1).goal.status,'complete');assert.equal(events.filter(e=>e.type==='replace').at(-1).text,'第一步\n\n完成');
});
const fakeRegistry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({nativeGoal:true}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'测试',nativeGoal:p.id==='codex'}))};
test('runner reserves concurrency, preserves failed output and clears stale native sessions',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({workspace:process.cwd()});let finish;
  const r=new Runner(s,fakeRegistry,()=>{},{codex:async({emit})=>{emit({type:'delta',text:'partial'});await new Promise(resolve=>finish=resolve);throw new Error('failed');}});
  await r.start(chat.id,'question');await assert.rejects(()=>r.start(chat.id,'second'),/正在运行/);finish();await r.active.get(chat.id).done;
  assert.equal(s.messages(chat.id).at(-1).content,'partial');assert.equal(s.messages(chat.id).at(-1).status,'error');assert.equal(r.active.size,0);s.close();
});
test('switching back to a native session includes the other provider conversation',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({workspace:process.cwd()});const captured=[];
  const fake=async({provider,session,prompt,emit})=>{captured.push({provider,session,prompt});emit({type:'session',id:provider+'-native'});emit({type:'replace',text:provider+' answer'});};
  const r=new Runner(s,fakeRegistry,()=>{},{codex:fake,claude:fake});
  for(const[id,text]of [['codex','one'],['claude','two'],['codex','three']]){s.updateChat(chat.id,{provider:id});await r.start(chat.id,text);await r.active.get(chat.id).done;}
  assert.equal(captured[2].session,'codex-native');assert.ok(captured[2].prompt.includes('claude answer'));assert.ok(!captured[2].prompt.includes('codex answer'));s.close();
});
test('stopped native goals keep the paused session and resume without replaying the interrupted turn',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({workspace:process.cwd(),options:{codex:{mode:'goal'}}});const captured=[];
  const r=new Runner(s,fakeRegistry,()=>{},{codex:async({session,prompt,goalObjective,emit})=>{
    captured.push({session,prompt,goalObjective});emit({type:'session',id:'preserved-goal'});
    emit({type:'goal',goal:{objective:'one',status:'paused',tokensUsed:123}});
    throw Object.assign(new Error('已停止'),{canceled:true});
  }});
  await r.start(chat.id,'one');await r.active.get(chat.id).done;
  assert.equal(s.session(chat.id,'codex').native_id,'preserved-goal');
  await r.start(chat.id,'continue');await r.active.get(chat.id).done;
  assert.equal(captured[1].session,'preserved-goal');assert.match(captured[1].prompt,/\ncontinue$/);assert.doesNotMatch(captured[1].prompt,/--- 用户 ---/);assert.equal(captured[1].goalObjective,'continue');s.close();
});
test('HTTP blocks cross-site calls and unauthorized reads; groups roundtrip',async t=>{
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'hub-http-')),registry:fakeRegistry});const port=await hub.listen();t.after(()=>hub.close());const base='http://127.0.0.1:'+port;
  assert.equal((await fetch(base+'/api/state')).status,401);
  assert.equal((await fetch(base+'/api/groups',{method:'POST',headers:{'X-Hub-Token':hub.token,Origin:'https://example.com'},body:'{"name":"bad"}'})).status,403);
  const result=await fetch(base+'/api/groups',{method:'POST',headers:{'X-Hub-Token':hub.token},body:'{"name":"persistent"}'});assert.equal(result.status,201);
  const data=await(await fetch(base+'/api/state',{headers:{'X-Hub-Token':hub.token}})).json();assert.equal(data.groups[0].name,'persistent');
  assert.equal((await fetch(base+'/vendor/../../package.json')).status,404);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Store,buildContext } from '../src/storage.mjs';
import { HistoryImporter } from '../src/history.mjs';
import { ClaudeHistory,convertClaudeMessages } from '../src/claude-history.mjs';
import { createHub } from '../src/server.mjs';
import { claudeCapabilities,validateOptions } from '../src/providers.mjs';
import { cliArguments,parseEvent,runCli } from '../src/adapters/cli.mjs';
import { claudeId,claudeRecords,fixtureClaudeReader,fixtureClaudeHistory } from './fixtures/claude-history.mjs';
const offline={resolve:()=>{throw new Error('Must not start or authenticate Claude');},list:async()=>[]};
const importer=store=>new HistoryImporter(store,offline,process.cwd(),undefined,fixtureClaudeHistory());

test('Claude history works offline, pages and searches titles and folders',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const history=importer(store);
  const first=await history.list('claude');assert.equal(first.data.length,30);assert.equal(first.nextCursor,'30');
  const next=await history.list('claude',{cursor:first.nextCursor});assert.equal(next.data.length,5);assert.equal(next.nextCursor,null);
  assert.equal((await history.list('claude',{search:'research'})).data[0].id,claudeId(1));
  assert.equal((await history.list('claude',{search:'星港'})).data.length,1);
  await assert.rejects(()=>history.list('claude',{cursor:'../secret'}),/搜索/);
  await assert.rejects(()=>history.list('claude',{archived:true}),/归档/);
});
test('Claude import preserves exposed activity as data, excluding unrelated sidechains and media bytes',()=>{
  const messages=convertClaudeMessages([...claudeRecords,{type:'system',message:{content:'injection'}},{type:'user',isMeta:true,message:{content:'meta'}}],'2023-01-01T00:00:00.000Z');
  assert.equal(messages.length,4);assert.equal(messages[0].created,'2023-11-14T22:13:21.000Z');
  assert.equal(messages[2].content,'Continue with context\n\n[image]');assert.equal(messages[2].details.notices.length,1);
  assert.doesNotMatch(JSON.stringify(messages),/nested private|BASE64_SECRET|injection|"meta"/);
  assert.equal(messages[1].details.activity.find(row=>row.kind==='thinking').text,'Native thinking summary');
  assert.match(JSON.stringify(messages[1].details.activity),/NEVER RUN/);
  assert.doesNotMatch(buildContext(messages).text,/NEVER RUN|Native thinking summary/);
});
test('Claude copies are independent, deduplicated, grouped across directories and restorable',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const history=importer(store),group=store.group('Shared');
  const results=await Promise.all([history.import('claude',{id:claudeId(0),group_id:group.id}),history.import('claude',{id:claudeId(0)})]);
  assert.deepEqual(results.map(r=>r.status).sort(),['imported','skipped']);const chat=store.chat(results[0].chatId);
  assert.equal(chat.group_id,group.id);assert.equal(chat.provider,'claude');assert.equal(store.session(chat.id,'claude'),undefined);
  assert.equal(validateOptions('claude',chat.options.claude).permissionMode,'plan');assert.equal(store.messages(chat.id).length,4);
  const second=await history.import('claude',{id:claudeId(1),group_id:group.id});assert.notEqual(store.chat(second.chatId).workspace,chat.workspace);
  assert.equal((await history.list('claude')).data[0].importedChatId,chat.id);
  assert.match(buildContext(store.messages(chat.id)).text,/Final Claude answer/);
  const restored=new Store(':memory:');t.after(()=>restored.close());restored.import(store.export());assert.equal((await importer(restored).import('claude',{id:claudeId(0)})).status,'skipped');
  store.importHistory('codex',{...(await fixtureClaudeHistory().read(claudeId(0))),title:'Same ID, different provider'});assert.equal(store.list().chats.length,3);
});
test('Claude preview truncates only display; missing, oversized and failed reads leave no partial imports',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const history=importer(store);
  for(const args of [{id:claudeId(33)},{id:claudeId(99)},{id:'../secret'},{id:claudeId(0),group_id:'missing'}])await assert.rejects(()=>history.import('claude',args));
  assert.equal(store.list().chats.length,0);
  const reader=fixtureClaudeReader();reader.getSessionMessages=async()=>[{type:'assistant',message:{content:'x'.repeat(7000)}}];
  const local=new ClaudeHistory(reader);assert.equal((await local.read(claudeId(0),{preview:true})).messages[0].content.length,6000);assert.equal((await local.read(claudeId(0))).messages[0].content.length,7000);
  reader.getSessionMessages=async()=>[{type:'assistant',message:{content:'x'.repeat(2000001)}}];await assert.rejects(()=>local.read(claudeId(0)),/单条/);
  reader.getSessionInfo=async id=>({sessionId:id,fileSize:129*1024*1024});await assert.rejects(()=>local.read(claudeId(0)),/128 MB/);
});
test('Claude HTTP picker and import roundtrip without CLI or authentication',async t=>{
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-claude-api-')),registry:offline,claudeHistory:fixtureClaudeHistory()});
  const port=await hub.listen();t.after(()=>hub.close());const base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/history/claude')).status,401);
  const list=await(await fetch(base+'/api/history/claude',{headers})).json();assert.equal(list.data.length,30);
  const preview=await(await fetch(base+'/api/history/claude/preview?id='+claudeId(0),{headers})).json();assert.equal(preview.messages.length,4);
  const result=await(await fetch(base+'/api/history/claude/import',{method:'POST',headers,body:JSON.stringify({id:claudeId(0)})})).json();assert.equal(result.status,'imported');
  assert.equal(hub.store.messages(result.chatId).length,4);
});
test('Claude unattended flags are version-gated; resume keeps its workspace session',()=>{
  assert.equal(claudeCapabilities('2.1.258 (Claude Code)').nativeNoPrompts,false);assert.equal(claudeCapabilities('2.1.265 (Claude Code)').nativeNoPrompts,true);
  const args=cliArguments('claude',{...validateOptions('claude',{worktree:true,model:'sonnet'}),nativeNoPrompts:true},'session');
  assert.equal(args[args.indexOf('--resume')+1],'session');assert.equal(args[args.indexOf('--permission-prompts')+1],'none');assert.ok(!args.includes('--worktree'));assert.ok(!args.includes('--dangerously-skip-permissions'));
  const state={};parseEvent('claude',{type:'stream_event',event:{delta:{type:'text_delta',text:'first'}}},state);
  assert.ok(!parseEvent('claude',{type:'assistant',message:{content:[{type:'text',text:'first'}]}},state).some(e=>e.type==='delta'));
  assert.equal(parseEvent('claude',{type:'assistant',message:{content:[{type:'text',text:'after tool'}]}},state)[0].text,'after tool');
});
test('Claude process streams UTF-8, propagates account errors and can be stopped',async()=>{
  const runtime={command:process.execPath,prefixArgs:[resolve('tests/fixtures/claude-cli.mjs')]};
  const run=(prompt,extra={})=>runCli({provider:'claude',runtime,options:{permissionMode:'plan',nativeNoPrompts:true},prompt,cwd:process.cwd(),setControl:()=>{},emit:()=>{},...extra});
  const events=[];await run('hello',{session:'resumed-native',emit:e=>events.push(e)});assert.equal(events.find(e=>e.type==='session').id,'resumed-native');assert.equal(events.find(e=>e.type==='replace').text,'你好，星港');
  await assert.rejects(()=>run('blocked'),/account is on hold/);
  const abort=new AbortController();await assert.rejects(()=>run('slow',{signal:abort.signal,emit:e=>{if(e.type==='session')abort.abort();}}),e=>e.canceled===true);
});

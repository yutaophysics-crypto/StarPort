import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {createHub} from '../src/server.mjs';
import {contextToolHost,contextCommandBridge,contextToolInstructions,CONTEXT_TOOLS,CALL_TOOLS} from '../src/context-tools.mjs';
import {runClaude} from '../src/adapters/claude.mjs';
import {runCodex} from '../src/adapters/codex.mjs';
import {runCli} from '../src/adapters/cli.mjs';
import {runDeepseek} from '../src/adapters/deepseek.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record:()=>{},list:async()=>[]};
const until=async fn=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('fixture timeout');};
const input={kind:'preference',title:'交流方式',content:'请简洁作答。'};

test('global preferences and project instructions are separate, durable and revision protected',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'starport-context-')),'hub.sqlite');let s=new Store(file);
  try{const p=s.addProject('project',process.cwd());s.instructions.update(null,{content:'简洁作答',revision:0});s.instructions.update(p.id,{content:'本项目给出完整证明',revision:0});
    assert.match(s.instructions.prompt(p.id),/完整证明/);assert.doesNotMatch(s.instructions.prompt(),/完整证明/);assert.match(s.instructions.prompt(),/简洁作答/);assert.throws(()=>s.instructions.update(p.id,{content:'stale',revision:0}),e=>e.status===409);
    const old=s.instructions.fingerprint(p.id);s.instructions.update(p.id,{content:'新项目要求',revision:1});assert.notEqual(old,s.instructions.fingerprint(p.id));s.close();s=new Store(file);assert.equal(s.instructions.get(p.id).content,'新项目要求');
  }finally{s.close();}
});

test('scoped memory updates remain pending, replace their target atomically, and reject stale targets',()=>{
  const s=new Store(':memory:');try{const a=s.addProject('A','C:/A'),b=s.addProject('B','C:/B');
    const global=s.memory.create(input,{confirmed:true}),old=s.memory.create({...input,project_id:a.id},{confirmed:true}),other=s.memory.create({...input,project_id:b.id},{confirmed:true});
    assert.notEqual(global.id,old.id);assert.notEqual(old.id,other.id);assert.deepEqual(new Set(s.memory.search({projectId:a.id}).items.map(row=>row.id)),new Set([global.id,old.id]));assert.equal(s.memory.list({view:'profile'}).total,1);
    const update=s.memory.create({...input,content:'本项目请详细作答。',project_id:a.id,supersedes:old.id});assert.equal(s.memory.get(old.id).content,input.content);assert.doesNotMatch(s.memory.recall('',{projectId:a.id}).text,/详细/);
    const confirmed=s.memory.update(update.id,{revision:1,confirm:true});assert.equal(confirmed.id,old.id);assert.equal(confirmed.content,'本项目请详细作答。');assert.equal(s.memory.list({view:'candidate'}).total,0);
    const stale=s.memory.create({...input,content:'更新二',project_id:a.id,supersedes:old.id});s.memory.update(old.id,{revision:confirmed.revision,content:'用户直接修正'});assert.throws(()=>s.memory.update(stale.id,{revision:1,confirm:true}),e=>e.status===409);assert.ok(s.memory.get(stale.id));
    assert.throws(()=>s.memory.create({...input,content:'跨项目错误',project_id:b.id,supersedes:old.id}));assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{s.close();}
});

test('historical full-text retrieval handles Chinese, source citation, scope, updates, deletions and bounded paging',()=>{
  const s=new Store(':memory:');try{const a=s.addProject('A','C:/A'),b=s.addProject('B','C:/B'),g=s.group('mixed');
    const global=s.newChat({group_id:g.id}),ca=s.newChat({project_id:a.id,group_id:g.id,workspace:'C:/other-folder'}),cb=s.newChat({project_id:b.id,group_id:g.id});
    const add=(chat,text)=>s.message(chat.id,'user','codex',text);
    add(global,'量子物理和中文交流');const row=add(ca,'讨论量子物理的边界模型。'+'长文本'.repeat(2000));add(cb,'另一个项目的量子物理');s.message(ca.id,'assistant','codex','失败的量子物理','error');s.message(ca.id,'user','codex','未交给模型的量子物理','pending',{guidance:{state:'queued'}});
    assert.equal(s.search.search({query:'量子物理'}).total,1);const result=s.search.search({query:'量子物理',projectId:a.id});assert.equal(result.total,1);assert.equal(result.items[0].id,row.id);assert.match(result.items[0].citation,/#starport-chat=/);assert.ok(result.items[0].snippet.length<900);
    assert.equal(s.search.search({query:'物理',projectId:a.id}).total,1);assert.equal(s.search.search({query:'量子物理',all:true}).total,3);assert.equal(s.search.search({query:'" OR 1=1 --'}).total,0);assert.throws(()=>s.search.read({chatId:cb.id},a.id),e=>e.status===404);
    const part=s.search.read({chatId:ca.id,messageId:row.id,maxChars:1000},a.id);assert.ok(part.nextStart);assert.equal(s.search.read({chatId:ca.id,messageId:row.id,start:part.nextStart,maxChars:1000},a.id).text.length,1000);
    row.content='现在改为拓扑代码';s.saveMessage(row);assert.equal(s.search.search({query:'量子物理',projectId:a.id}).total,0);assert.equal(s.search.search({query:'拓扑代码',projectId:a.id}).total,1);s.deleteChat(ca.id);assert.equal(s.search.search({query:'拓扑代码',all:true}).total,0);
  }finally{s.close();}
});

test('call tools come only with a call session, name whom it may call, and waiting is not capped by count',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({}),started=[],closed=[];
  const calls={callees:[{id:'a',name:'甲',role:'数值'},{id:'c',name:'丙'}],start:async args=>{started.push(args);return {callId:'x',status:'running'};},wait:async()=>({callId:'x',status:'running'}),close:()=>closed.push(true)};
  try{
    assert.ok(!contextToolHost({store:s,chat,messages:()=>[]}).definitions.some(t=>CALL_TOOLS.includes(t.name)));
    const host=contextToolHost({store:s,chat,messages:()=>[],calls}),call=host.definitions.find(t=>t.name==='starport_companion_call');
    assert.match(call.description,/甲（数值）、丙/);assert.deepEqual(call.inputSchema.required,['companion','task']);
    assert.deepEqual(await host.call('starport_companion_call',{companion:'甲',task:'算'}),{callId:'x',status:'running'});
    for(let i=0;i<100;i++)await host.call('starport_companion_wait',{callId:'x'});
    await host.call('starport_memory_search',{query:''});
    host.close();assert.equal(closed.length,1);
    const desk=contextToolHost({store:s,chat,messages:()=>[],tools:new Set(CALL_TOOLS),calls});
    assert.deepEqual(desk.definitions.map(t=>t.name),CALL_TOOLS,'a desk granted only calls gets only calls');
    const only=contextToolInstructions('codex',new Set(CALL_TOOLS),{callees:calls.callees});
    assert.doesNotMatch(only,/长期记忆/);assert.match(only,/星港伙伴调用.*甲（数值）、丙/);
    assert.match(contextToolInstructions('antigravity',null,{callees:calls.callees}),/starport_companion_wait --callId/);
    assert.doesNotMatch(contextToolInstructions('codex'),/星港伙伴调用/);
  }finally{s.close();}
});
test('memory tool requires current user quotes, rejects foreign evidence, and enforces project scope',async()=>{
  const s=new Store(':memory:');try{const p=s.addProject('A','C:/A'),chat=s.newChat({project_id:p.id}),user=s.message(chat.id,'user','claude','本项目以后要给出完整证明。');
    const host=contextToolHost({store:s,chat,messages:()=>[user]});const suggestion={kind:'knowledge',title:'项目要求',content:'本项目需要完整证明。',evidence:user.content};
    const result=await host.call('starport_memory_propose',suggestion);const candidate=s.memory.get(result.id);assert.equal(candidate.status,'candidate');assert.equal(candidate.project_id,p.id);assert.equal(s.memory.recall('证明',{projectId:p.id}).items.length,0);
    await assert.rejects(host.call('starport_memory_propose',{...suggestion,evidence:'检索到的其他对话里的原话'}));await assert.rejects(host.call('starport_history_search',{query:'证明',all:true}));s.memory.configure({search:false});await assert.rejects(host.call('starport_history_search',{query:'证明'}));
  }finally{s.close();}
});

for(const provider of ['codex','claude','antigravity','deepseek'])test(provider+' uses scoped memory and on-demand history, with updated instructions next turn',async()=>{
  const s=new Store(':memory:'),calls=[];const runner=new Runner(s,registry,()=>{},{[provider]:async args=>{
    calls.push(args);const results=await args.contextTools.call('starport_history_search',{query:'采购预算'});assert.equal(results.total,1);
    const original=await args.contextTools.call('starport_history_read',{chatId:results.items[0].chat_id,messageId:results.items[0].id});assert.match(original.text,/采购预算定为123元/);
    await args.contextTools.call('starport_memory_propose',{...input,content:'用户以后希望简洁作答。',evidence:'以后请简洁作答'});args.emit({type:'session',id:'native-context'});args.emit({type:'replace',text:'采购预算123元。'+results.items[0].citation});
  }});
  try{const p=s.addProject('A','C:/A'),foreign=s.addProject('B','C:/B');s.instructions.update(null,{content:'简洁偏好',revision:0});s.instructions.update(p.id,{content:'当前项目的特殊要求',revision:0});s.instructions.update(foreign.id,{content:'不应泄漏的其他项目要求',revision:0});s.memory.create({...input,content:'其他项目记忆',project_id:foreign.id},{confirmed:true});
    const source=s.newChat({project_id:p.id,title:'采购决定'});s.message(source.id,'user',provider,'采购预算定为123元。');const chat=s.newChat({project_id:p.id,provider,workspace:process.cwd()});await runner.start(chat.id,'以前采购预算怎么定的？以后请简洁作答');await until(()=>!runner.active.has(chat.id));assert.equal(s.lastAssistant(chat.id).status,'complete');assert.match(calls[0].prompt,/简洁偏好/);assert.match(calls[0].prompt,/当前项目的特殊要求/);assert.doesNotMatch(calls[0].prompt,/其他项目/);assert.equal(s.lastAssistant(chat.id).details.memory.candidates.length,1);assert.ok(s.lastAssistant(chat.id).details.memory.sources.length);
    s.instructions.update(p.id,{revision:1,content:'更新项目要求'});await runner.start(chat.id,'以后请简洁作答，再看预算');await until(()=>!runner.active.has(chat.id));assert.equal(calls[1].session,undefined);assert.match(calls[1].prompt,/更新项目要求/);
  }finally{await runner.close();s.close();}
});

test('command bridge authenticates, cannot access application APIs, and is revoked after a run',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({}),source=s.newChat({});s.message(source.id,'user','deepseek','共同采购预算123元');const host=contextToolHost({store:s,chat,messages:()=>[]}),bridge=await contextCommandBridge(host);
  try{assert.equal((await fetch(bridge.env.STARPORT_CONTEXT_URL,{method:'POST',body:'{}'})).status,403);
    const output=await new Promise((resolve,reject)=>{let out='',err='';const child=spawn(process.execPath,['scripts/context-tool.mjs','starport_history_search','--query','采购预算'],{cwd:process.cwd(),env:{...process.env,...bridge.env},windowsHide:true});child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out)));});assert.equal(output.total,1);
    const wrong=await fetch(bridge.env.STARPORT_CONTEXT_URL.replace('/tool','/api/export'),{method:'POST',headers:{'X-Starport-Context':bridge.env.STARPORT_CONTEXT_TOKEN},body:'{}'});assert.equal(wrong.status,403);
  }finally{await bridge.close();s.close();}await assert.rejects(fetch(bridge.env.STARPORT_CONTEXT_URL));
});

test('backups remap project scopes and restore instructions for review instead of applying them',()=>{
  const s=new Store(':memory:'),restored=new Store(':memory:');try{const p=s.addProject('A','C:/A');s.newChat({project_id:p.id});s.instructions.update(null,{revision:0,content:'global preference'});s.instructions.update(p.id,{revision:0,content:'project requirement'});s.memory.create({...input,project_id:p.id},{confirmed:true});restored.import(s.export());
    const project=restored.projects()[0];assert.equal(restored.list().chats[0].project_id,project.id);assert.equal(restored.memory.list({projectId:project.id,view:'candidate'}).total,1);assert.equal(restored.instructions.get().content,'');assert.equal(restored.instructions.get().pending_content,'global preference');assert.equal(restored.instructions.get(project.id).pending_content,'project requirement');assert.doesNotMatch(restored.instructions.prompt(project.id),/project requirement/);
    restored.instructions.update(project.id,{revision:restored.instructions.get(project.id).revision,content:'project requirement'});assert.match(restored.instructions.prompt(project.id),/project requirement/);
    const bad=s.export();bad.contextInstructions.items.push({scope:'project:invalid',content:'bad'});const before=restored.list().chats.length;assert.throws(()=>restored.import(bad));assert.equal(restored.list().chats.length,before);
  }finally{s.close();restored.close();}
});

test('Claude registers only the Starport tool server, preserving native settings and permission mode',async()=>{
  let seen;const signal=new AbortController().signal;
  const tools={definitions:CONTEXT_TOOLS,call:async()=>({total:0,items:[]})};
  const makeQuery=args=>{seen=args.options;return {close(){},async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',result:'done',session_id:'fixture',usage:{}};}};};
  await runClaude({runtime:{command:process.execPath},options:{permissionMode:'plan'},contextTools:tools,prompt:'test',cwd:process.cwd(),signal,emit(){},setControl(){},makeQuery});assert.equal(seen.permissionMode,'plan');assert.ok(seen.mcpServers.starport_context);assert.equal(seen.allowedTools.length,CONTEXT_TOOLS.length);assert.ok(seen.allowedTools.every(name=>name.startsWith('mcp__starport_context__starport_')));
});

test('context APIs protect user instructions; the project of a conversation follows its folder, not its group',async()=>{
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-context-api-')),registry}),base='http://127.0.0.1:'+await hub.listen();
  const req=(path,method='GET',data,headers={})=>fetch(base+'/api'+path,{method,headers:{'X-Hub-Token':hub.token,'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});
  try{const p=hub.store.addProject('A',process.cwd()),chat=hub.store.newChat({workspace:process.cwd()});assert.equal((await req('/context/preferences','PATCH',{revision:0,content:'中文优先'},{Origin:'https://evil.example'})).status,403);assert.equal((await req('/context/preferences','PATCH',{revision:0,content:'中文优先'})).status,200);assert.equal((await req('/context/preferences','PATCH',{revision:0,content:'stale'})).status,409);
    assert.equal((await req('/chats/'+chat.id,'PATCH',{project_id:null,title:'改标题'})).status,200);assert.equal(hub.store.chat(chat.id).workspace,process.cwd());assert.equal(hub.store.chat(chat.id).project_id,p.id);assert.equal((await req('/projects/'+p.id+'/requirements','PATCH',{revision:0,content:'具体项目要求'})).status,200);assert.equal((await req('/context/history/search','POST',{query:'不存在的讨论'})).status,200);
  }finally{await hub.close();}
});

test('all new context controls have English labels',()=>{
  const sandbox={localStorage:{getItem:()=>null,setItem:()=>{}}};runInNewContext(readFileSync('public/i18n.js','utf8'),sandbox);sandbox.StarportI18n.setLanguage('en');const source=readFileSync('public/shared-context.js','utf8');
  for(const match of source.matchAll(/tr\('[^']+','([^']+)'|t\('([^']+)'/g)){const label=match[1]||match[2];assert.ok(!/\p{Script=Han}/u.test(sandbox.StarportI18n.t(label)),label);}
});

test('Codex native dynamic tool request returns real scoped results and reports host errors',async()=>{
  const s=new Store(':memory:');try{const source=s.newChat({}),chat=s.newChat({});s.message(source.id,'user','codex','采购预算定为123元');
    const host=contextToolHost({store:s,chat,messages:()=>[]}),runtime={command:process.execPath,prefixArgs:[resolve('tests/fixtures/context-native.mjs'),'codex']};
    for(const fail of [false,true]){const events=[];await runCodex({runtime,options:{mode:'chat'},prompt:'history',contextTools:fail?{definitions:host.definitions,call:async()=>{throw Error('检索已关闭');}}:host,cwd:process.cwd(),signal:AbortSignal.timeout(6000),emit:e=>events.push(e),setControl(){}});
      const response=JSON.parse(events.findLast(e=>e.type==='replace').text);assert.equal(response.registered.length,5);assert.ok(response.registered.every(t=>t.type==='function'));assert.equal(response.success,!fail);
      if(fail)assert.match(response.contentItems[0].text,/检索已关闭/);else {const result=JSON.parse(response.contentItems[0].text);assert.equal(result.total,1);assert.equal(result.items[0].chat_id,source.id);}
    }
  }finally{s.close();}
});

for(const provider of ['antigravity','deepseek'])test(provider+' native adapter passes run-scoped bridge to its actual child',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({}),source=s.newChat({});s.message(source.id,'user',provider,'采购预算123元');const bridge=await contextCommandBridge(contextToolHost({store:s,chat,messages:()=>[]}));
  try{const events=[],args={runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/context-native.mjs'),provider]},options:{mode:'agent',provider:'fixture',model:'fixture'},prompt:'history',contextEnv:bridge.env,cwd:process.cwd(),signal:AbortSignal.timeout(6000),emit:e=>events.push(e),setControl(){}};
    if(provider==='deepseek')await runDeepseek(args);else await runCli({...args,provider});
    const result=JSON.parse(events.findLast(e=>provider==='deepseek'?e.type==='final-answer':e.type==='replace').text);assert.equal(result.total,1);assert.equal(result.items[0].chat_id,source.id);
  }finally{await bridge.close();s.close();}
});

for(const provider of ['codex','antigravity','deepseek'])test(provider+' actual child transport can search and read a model-selected memory',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({}),saved=s.memory.create({kind:'knowledge',title:'陶艺釉料',content:'釉料烧制温度需要按配方记录。'},{confirmed:true}),host=contextToolHost({store:s,chat,messages:()=>[]}),bridge=await contextCommandBridge(host);
  try{const events=[],args={runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/context-native.mjs'),provider,'memory']},options:{mode:provider==='codex'?'chat':'agent',provider:'fixture',model:'fixture'},prompt:'memory',contextTools:host,contextEnv:bridge.env,cwd:process.cwd(),signal:AbortSignal.timeout(6000),emit:e=>events.push(e),setControl(){}};
    if(provider==='codex')await runCodex(args);else if(provider==='deepseek')await runDeepseek(args);else await runCli({...args,provider});
    const output=JSON.parse(events.findLast(e=>provider==='deepseek'?e.type==='final-answer':e.type==='replace').text),result=provider==='codex'?JSON.parse(output.contentItems[0].text):output;
    assert.equal(result.items[0].id,saved.id);assert.equal(result.items[0].content,saved.content);
  }finally{await bridge.close();s.close();}
});

test('history index ignores streaming deltas and indexes final text only',()=>{
  const s=new Store(':memory:');try{const chat=s.newChat({}),row=s.message(chat.id,'assistant','codex','采购预算开始','running');const count=()=>s.db.prepare('SELECT count(*) n FROM chat_history_fts').get().n;
    assert.equal(count(),0);row.content+='处理中';s.saveMessage(row);assert.equal(count(),0);row.content='采购预算确认123元';row.status='complete';s.saveMessage(row);assert.equal(count(),1);assert.equal(s.search.search({query:'采购预算'}).total,1);
    row.status='error';s.saveMessage(row);assert.equal(count(),0);assert.equal(s.search.search({query:'采购预算'}).total,0);
  }finally{s.close();}
});

test('Claude in-process MCP transports scoped history and memory reads with array IDs and preserves validation errors',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({}),source=s.newChat({});s.message(source.id,'user','claude','采购预算123元');const saved=s.memory.create({kind:'knowledge',title:'陶艺釉料',content:'陶艺釉料应记录烧制温度。'},{confirmed:true}),contextTools=contextToolHost({store:s,chat,messages:()=>[]});
  try{const makeQuery=args=>({close(){},async *[Symbol.asyncIterator](){const client=new Client({name:'starport-test',version:'1.0.0'}),server=args.options.mcpServers.starport_context.instance,[a,b]=InMemoryTransport.createLinkedPair();
    try{await server.connect(b);await client.connect(a);const listed=await client.listTools();assert.equal(listed.tools.length,5);const result=await client.callTool({name:'starport_history_search',arguments:{query:'采购预算'}});assert.equal(JSON.parse(result.content[0].text).total,1);
      const memories=await client.callTool({name:'starport_memory_search',arguments:{query:'釉料'}});assert.equal(JSON.parse(memories.content[0].text).items[0].id,saved.id);
      const read=await client.callTool({name:'starport_memory_read',arguments:{ids:[saved.id],reason:'当前的陶艺工作需要釉料背景。'}});assert.equal(JSON.parse(read.content[0].text).items[0].content,saved.content);
      s.memory.configure({search:false});const denied=await client.callTool({name:'starport_history_search',arguments:{query:'采购预算'}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/已关闭/);yield {type:'result',subtype:'success',result:'done',session_id:'fixture',usage:{}};
    }finally{await client.close();await server.close();}
  }});
  await runClaude({runtime:{command:process.execPath},options:{permissionMode:'plan'},contextTools,prompt:'test',cwd:process.cwd(),signal:AbortSignal.timeout(6000),emit(){},setControl(){},makeQuery});
  }finally{s.close();}
});

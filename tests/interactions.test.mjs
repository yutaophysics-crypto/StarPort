import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {runCodex} from '../src/adapters/codex.mjs';
import {runClaude} from '../src/adapters/claude.mjs';
import {runCli} from '../src/adapters/cli.mjs';
import {runDeepseek} from '../src/adapters/deepseek.mjs';
import {Store,buildContext} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {createHub} from '../src/server.mjs';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const until=async check=>{for(let index=0;index<300;index++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture did not become ready');};
const runtime=mode=>({command:process.execPath,prefixArgs:[resolve('tests/fixtures/interactions-native.mjs'),mode]});
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),record:()=>{},list:async()=>[]};
async function loadPublic(name){const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8'),context);return context[name==='live'?'StarportLive':'StarportQuestions'];}

test('Codex steering keeps the exact native turn and does not interrupt or start another turn',{timeout:6000},async()=>{
  let control;const events=[],controller=new AbortController();
  const running=runCodex({runtime:runtime('codex'),options:{mode:'chat',permissionMode:'ask'},prompt:'work',cwd:process.cwd(),signal:controller.signal,setControl:value=>control=value,emit:event=>events.push(event)});
  try{
    await until(()=>control?.canSend());assert.equal(control.inputMode,'steer');
    assert.equal((await control.steer('补充资料')).delivery,'accepted');assert.equal(control.canSend(),true);
    await control.steer('finish');await running;assert.equal(control.canSend(),false);
    const text=events.filter(event=>event.type==='replace').at(-1).text;assert.match(text,/expectedTurnId.*live-turn/);assert.match(text,/补充资料/);
    await assert.rejects(()=>control.steer('late'),/结束/);
  }finally{controller.abort();await running.catch(()=>{});}
});

test('both Codex question method names preserve multi-choice and free-text native answers',{timeout:6000},async()=>{
  for(const method of ['item/tool/requestUserInput','tool/requestUserInput']){
    let control,request;const events=[],controller=new AbortController();
    const running=runCodex({runtime:{...runtime('codex'),prefixArgs:[...runtime('codex').prefixArgs,method]},options:{mode:'chat',permissionMode:'ask'},prompt:'QUESTION',cwd:process.cwd(),signal:controller.signal,setControl:value=>control=value,emit:event=>{events.push(event);if(event.type==='approval')request=event.request;}});
    try{
      await until(()=>request);assert.equal(request.kind,'question');await assert.rejects(()=>control.answer(request.id,{decision:'accept',answers:{}}),/回答/);
      await control.answer(request.id,{decision:'accept',answers:{tests:['Unit','Custom']}});await running;
      assert.deepEqual(JSON.parse(events.filter(e=>e.type==='replace').at(-1).text),{answers:{tests:{answers:['Unit','Custom']}}});
      assert.ok(events.some(e=>e.type==='approval-resolved'));
    }finally{controller.abort();await running.catch(()=>{});}
  }
});

test('Codex skip resolves both native question methods with empty answers and preserves the running turn',{timeout:6000},async()=>{
  for(const method of ['item/tool/requestUserInput','tool/requestUserInput']){
    let control,request;const events=[],controller=new AbortController();
    const running=runCodex({runtime:{...runtime('codex'),prefixArgs:[...runtime('codex').prefixArgs,method]},options:{mode:'chat',permissionMode:'ask'},prompt:'QUESTION',cwd:process.cwd(),signal:controller.signal,setControl:value=>control=value,emit:event=>{events.push(event);if(event.type==='approval')request=event.request;}});
    try{
      await until(()=>request);await control.answer(request.id,{decision:'skip',answers:{tests:'Unit'}});await running;
      assert.deepEqual(JSON.parse(events.filter(e=>e.type==='replace').at(-1).text),{answers:{}});
      assert.equal(events.filter(e=>e.type==='approval-resolved').length,1);
      await assert.rejects(()=>control.answer(request.id,{decision:'skip'}),/失效/);
    }finally{controller.abort();await running.catch(()=>{});}
  }
});

test('Claude guidance streams during a running tool and folds into one native result without interruption',{timeout:6000},async()=>{
  let control,queries=0,closed=0,interrupted=0;const release=gate(),messages=[],events=[];
  const makeQuery=({prompt})=>{queries++;return {close(){closed++;},interrupt(){interrupted++;},async *[Symbol.asyncIterator](){
    const pump=(async()=>{for await(const row of prompt)messages.push(row);})();
    yield {type:'system',subtype:'init',session_id:'resident',model:'fixture'};
    await until(()=>messages.length);await release.promise;
    for(const row of messages.slice(1))yield {...row,isReplay:true};
    yield {type:'result',subtype:'success',session_id:'resident',result:'Answer with both instructions',user_message_uuids:messages.slice(1).map(row=>row.uuid)};
    await pump;
  }};};
  const running=runClaude({runtime:runtime('unused'),options:{permissionMode:'default'},prompt:'initial',cwd:process.cwd(),makeQuery,setControl:value=>control=value,emit:event=>events.push(event)});
  await until(()=>messages.length);await control.steer('second',{id:randomUUID()});await control.steer('third',{id:randomUUID()});
  await until(()=>messages.length===3);assert.equal(control.inputMode,'steer');assert.equal(closed,0);assert.equal(events.filter(e=>e.type==='input-consumed').length,0);release.resolve();await running;
  assert.equal(queries,1);assert.equal(interrupted,0);assert.equal(closed,1);assert.equal(control.canSend(),false);
  assert.deepEqual(messages.map(row=>row.message.content),['initial','second','third']);assert.equal(messages[1].session_id,'resident');assert.equal(messages[1].priority,'next');
  assert.equal(events.filter(e=>e.type==='input-consumed').length,2);
});

test('Claude keeps a late guidance send alive across the first result and waits for its own result',{timeout:6000},async()=>{
  let control,closed=0;const first=gate(),last=gate(),seen=[],events=[];
  const makeQuery=({prompt})=>({close(){closed++;},interrupt(){assert.fail('Guidance must not interrupt');},async *[Symbol.asyncIterator](){
    const pump=(async()=>{for await(const row of prompt)seen.push(row);})();
    yield {type:'system',subtype:'init',session_id:'resident'};
    await first.promise;
    yield {type:'result',subtype:'success',result:'First turn',user_message_uuids:[]};
    await until(()=>seen.length===2);
    yield {...seen[1],isReplay:true};await last.promise;
    yield {type:'result',subtype:'success',result:'Late instruction handled',user_message_uuids:[seen[1].uuid]};
    await pump;
  }});
  const running=runClaude({runtime:runtime('unused'),options:{permissionMode:'default'},prompt:'initial',cwd:process.cwd(),makeQuery,setControl:value=>control=value,emit:event=>events.push(event)});
  await until(()=>seen.length);const id=randomUUID();await control.steer('late',{id});first.resolve();
  await until(()=>events.some(event=>event.type==='input-consumed'));
  assert.equal(closed,0);assert.equal(control.canSend(),true);assert.equal(events.filter(event=>event.type==='input-consumed').length,1);
  last.resolve();await running;assert.equal(closed,1);assert.equal(control.canSend(),false);
  assert.equal(events.filter(event=>event.type==='replace').at(-1).text,'Late instruction handled');
});

for(const format of ['legacy','capped'])test('Claude completes acknowledged guidance with '+format+' native result UUIDs',{timeout:6000},async()=>{
  let control;const release=gate(),seen=[],events=[],count=format==='capped'?64:2;
  const makeQuery=({prompt})=>({close(){},async *[Symbol.asyncIterator](){
    const pump=(async()=>{for await(const row of prompt)seen.push(row);})();
    yield {type:'system',subtype:'init',session_id:'resident'};await release.promise;
    for(const row of seen.slice(1))yield {...row,isReplay:true};
    yield {type:'result',subtype:'success',result:'All guidance handled',...(format==='capped'?{user_message_uuids:[randomUUID(),...seen.slice(2).map(row=>row.uuid)]}:{})};
    await pump;
  }});
  const running=runClaude({runtime:runtime('unused'),options:{permissionMode:'default'},prompt:'initial',cwd:process.cwd(),makeQuery,setControl:value=>control=value,emit:event=>events.push(event)});
  await until(()=>seen.length);for(let index=0;index<count;index++)await control.steer('guide '+index,{id:randomUUID()});
  await until(()=>seen.length===count+1);release.resolve();await running;
  assert.equal(control.canSend(),false);assert.equal(events.filter(event=>event.type==='input-consumed').length,count);
});

test('Claude unacknowledged guidance is not marked delivered when the user stops',{timeout:6000},async()=>{
  let control;const release=gate(),seen=[],events=[];
  const makeQuery=({prompt,options})=>({close(){release.resolve();},async *[Symbol.asyncIterator](){
    const pump=(async()=>{for await(const row of prompt)seen.push(row);})();
    yield {type:'system',subtype:'init',session_id:'resident'};
    await release.promise;assert.equal(options.abortController.signal.aborted,true);await pump;
  }});
  const running=runClaude({runtime:runtime('unused'),options:{permissionMode:'default'},prompt:'initial',cwd:process.cwd(),makeQuery,setControl:value=>control=value,emit:event=>events.push(event)});
  const outcome=running.catch(error=>error);
  await until(()=>seen.length);await control.steer('unread',{id:randomUUID()});await until(()=>seen.length===2);
  assert.equal(events.filter(event=>event.type==='input-consumed').length,0);await control.stop();
  assert.equal((await outcome).canceled,true);assert.equal(control.canSend(),false);
  await assert.rejects(()=>control.steer('after stop',{id:randomUUID()}),/结束/);
});

for(const provider of ['antigravity','deepseek'])test(provider+' queue waits for the native result and preserves its process/session',{timeout:6000},async()=>{
  let control;const events=[],controller=new AbortController(),base={prompt:'initial',cwd:process.cwd(),signal:controller.signal,emit:event=>events.push(event),setControl:value=>control=value};
  const running=provider==='antigravity'?runCli({...base,provider,runtime:runtime('agy'),options:{permissionMode:'configured'}}):runDeepseek({...base,runtime:runtime('deepseek'),options:{provider:'fixture',model:'fixture'}});
  try{
    await until(()=>control?.canSend());assert.equal(control.inputMode,'queue');
    await control.steer('second',{id:'second'});await control.steer('third',{id:'third'});await running;
    const textEvents=events.filter(e=>e.type===(provider==='deepseek'?'delta':'replace')),rows=textEvents.map(e=>JSON.parse(e.text));
    assert.deepEqual(rows.map(row=>row.text),['initial','second','third']);assert.equal(new Set(rows.map(row=>row.pid)).size,1);
    assert.deepEqual(events.filter(e=>e.type==='input-consumed').map(e=>e.id),['second','third']);assert.equal(control.canSend(),false);
  }finally{controller.abort();await running.catch(()=>{});}
});

test('Runner deduplicates guidance, rejects stale targets and keeps receipts and native cursor',{timeout:6000},async()=>{
  const store=new Store(':memory:'),release=gate(),native=[],events=[];let emitNative;
  const runner=new Runner(store,registry,(type,data)=>events.push(structuredClone(data)),{codex:async({emit,setControl})=>{
    emitNative=emit;emit({type:'session',id:'native'});setControl({inputMode:'steer',steer:async(text,{id})=>{native.push({id,text});return {delivery:'accepted'};},stop:release.resolve});await release.promise;emit({type:'replace',text:'Final after guidance'});
  }});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()}),first=await runner.start(chat.id,'initial'),run=runner.active.get(chat.id);
    await until(()=>runner.state(chat.id).inputReady);
    const data={text:'specific guidance',runId:first.id,clientId:'retry-safe'};
    const [a,b]=await Promise.all([runner.guidance(chat.id,data),runner.guidance(chat.id,data)]);assert.equal(a.user.id,b.user.id);assert.equal(native.length,1);
    await assert.rejects(()=>runner.guidance(chat.id,{...data,runId:'different'}),/标识/);
    await assert.rejects(()=>runner.guidance(chat.id,{...data,clientId:'other',runId:'different'}),/暂不/);
    assert.equal(runner.state(chat.id).id,first.id);assert.equal(a.user.status,'complete');assert.ok(events.some(row=>row.inputs?.some(user=>user.id===a.user.id)));
    emitNative({type:'context',context:{usedTokens:25,windowTokens:100,status:'available'}});release.resolve();await run.done;
    assert.equal(store.session(chat.id,'codex').cursor,a.user.id);assert.equal(runner.context(chat.id).usedTokens,25);
    assert.equal((await runner.guidance(chat.id,data)).user.id,a.user.id);assert.equal(native.length,1);
    const next=store.message(chat.id,'user','codex','next');assert.equal(buildContext(store.messages(chat.id),a.user.id).text,next.content);
    assert.ok(buildContext(store.messages(chat.id)).text.indexOf('specific guidance')<buildContext(store.messages(chat.id)).text.indexOf('Final after guidance'));
  }finally{release.resolve();await runner.close();store.close();}
});

test('unsent queued messages are settled on stop and never replayed as accepted context',async()=>{
  const store=new Store(':memory:'),release=gate();
  const runner=new Runner(store,registry,()=>{},{claude:async({setControl,signal})=>{setControl({inputMode:'queue',steer:async()=>({delivery:'queued'}),stop:release.resolve});await release.promise;if(signal.aborted)throw Object.assign(Error('stopped'),{canceled:true});}});
  try{
    const chat=store.newChat({provider:'claude',workspace:process.cwd()}),started=await runner.start(chat.id,'initial'),run=runner.active.get(chat.id);
    await until(()=>runner.state(chat.id).inputReady);
    const answer=await runner.guidance(chat.id,{text:'UNSENT_GUIDANCE',runId:started.id,clientId:'queued'});assert.equal(answer.user.status,'pending');
    assert.doesNotMatch(buildContext(store.messages(chat.id)).text,/UNSENT_GUIDANCE/);
    await runner.stop(chat.id);await run.done;const saved=store.messageById(chat.id,answer.user.id);
    assert.equal(saved.status,'interrupted');assert.equal(saved.details.guidance.state,'not-delivered');assert.doesNotMatch(buildContext(store.messages(chat.id)).text,/UNSENT_GUIDANCE/);
  }finally{release.resolve();await runner.close();store.close();}
});

test('native question answers survive immediate provider completion without changing permission approvals',async()=>{
  const store=new Store(':memory:'),release=gate();
  const runner=new Runner(store,registry,()=>{},{codex:async({emit,setControl})=>{
    emit({type:'session',id:'native'});emit({type:'approval',request:{id:'question',kind:'question',params:{questions:[{id:'q',question:'Choose?'}]}}});
    setControl({answer:async()=>{emit({type:'approval-resolved',id:'question'});release.resolve();}});await release.promise;
  }});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()});await runner.start(chat.id,'start');const run=runner.active.get(chat.id);
    await until(()=>runner.state(chat.id).approvals.length);await runner.answer(chat.id,'question',{decision:'accept',answers:{q:'My answer'}});await run.done;
    const answer=store.messages(chat.id).find(row=>row.details.nativeQuestionReply);assert.equal(answer.content,'Choose?\nMy answer');assert.equal(store.session(chat.id,'codex').cursor,answer.id);
  }finally{release.resolve();await runner.close();store.close();}
});

test('native skipped questions keep a truthful receipt when completion arrives immediately',async()=>{
  const store=new Store(':memory:'),release=gate();let calls=0;
  const runner=new Runner(store,registry,()=>{},{codex:async({emit,setControl})=>{
    emit({type:'session',id:'native'});emit({type:'approval',request:{id:'permission',kind:'permission',params:{}}});
    emit({type:'approval',request:{id:'question',kind:'question',params:{questions:[{id:'q',question:'Choose?'}]}}});
    setControl({answer:async()=>{calls++;emit({type:'approval-resolved',id:'question'});release.resolve();}});await release.promise;
  }});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()});await runner.start(chat.id,'start');const run=runner.active.get(chat.id);
    await until(()=>runner.state(chat.id).approvals.length);
    await assert.rejects(()=>runner.answer(chat.id,'permission',{decision:'skip'}),/无效/);assert.equal(calls,0);
    await runner.answer(chat.id,'question',{decision:'skip'});await run.done;
    const reply=store.messages(chat.id).find(row=>row.details.nativeQuestionReply);
    assert.equal(reply.details.nativeQuestionReply.skipped,true);assert.match(reply.content,/跳过/);assert.equal(store.session(chat.id,'codex').cursor,reply.id);
  }finally{release.resolve();await runner.close();store.close();}
});

test('read and inferred-question skip endpoints require auth, reject stale or foreign targets, and persist across a running turn',async()=>{
  const release=gate(),events=[];
  const hub=createHub({port:0,dataDir:await mkdtemp(join(tmpdir(),'starport-skip-')),registry,implementations:{codex:async({emit,setControl})=>{setControl({stop:release.resolve});emit({type:'replace',text:stock});await release.promise;emit({type:'replace',text:stock});}}});
  try{
    const port=await hub.listen(),base='http://127.0.0.1:'+port,chat=hub.store.newChat({workspace:process.cwd()}),other=hub.store.newChat({}),foreign=hub.store.message(other.id,'assistant','codex','other');
    const headers={'Content-Type':'application/json','X-Hub-Token':hub.token};
    const post=(action,data,auth=headers)=>fetch(base+'/api/chats/'+chat.id+'/'+action,{method:'POST',headers:auth,body:JSON.stringify(data)});
    const old=hub.store.message(chat.id,'assistant','codex','old');
    assert.equal((await post('read',{messageId:old.id},{})).status,401);
    assert.equal((await post('read',{messageId:foreign.id})).status,409);
    assert.equal((await post('read',{messageId:old.id})).status,200);assert.equal(hub.store.chat(chat.id).unread,false);
    await hub.runner.start(chat.id,'start');const run=hub.runner.active.get(chat.id);await until(()=>run.message.content===stock);
    assert.equal((await post('read',{messageId:old.id})).status,409);
    const questionLib=await loadPublic('questions'),ids=Array.from(questionLib.extract(stock),q=>q.id),replyTo={messageId:run.message.id,questions:ids};
    assert.equal((await post('question-skip',{replyTo},{})).status,401);
    assert.ok((await post('question-skip',{replyTo:{...replyTo,messageId:foreign.id}})).status>=400);
    assert.ok((await post('question-skip',{replyTo:{...replyTo,messageId:old.id}})).status>=400);
    assert.equal((await post('question-skip',{replyTo})).status,200);assert.equal(hub.runner.active.has(chat.id),true);
    assert.equal(questionLib.latest({messages:hub.store.messages(chat.id)}).questions.length,0);
    release.resolve();await run.done;
    assert.deepEqual(hub.store.lastAssistant(chat.id).details.skippedQuestions,ids);
    assert.equal(hub.store.messages(chat.id).filter(row=>row.role==='user').length,1,'dismissing prose questions must not send a fabricated follow-up');
    const latest=hub.store.lastAssistant(chat.id);assert.equal(hub.store.chat(chat.id).unread,true);
    assert.equal((await post('read',{messageId:latest.id})).status,200);
    const live=await (await fetch(base+'/api/live',{headers})).json();assert.equal(live.chatStatuses.find(row=>row.id===chat.id).unread,false);
  }finally{release.resolve();await hub.close();}
});

test('guidance API authenticates mutations and validates chat/reply boundaries',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'starport-interactions-')),release=gate();
  const hub=createHub({port:0,dataDir,registry,implementations:{codex:async({setControl})=>{setControl({inputMode:'steer',steer:async()=>({delivery:'accepted'}),stop:release.resolve});await release.promise;}}});
  try{
    const port=await hub.listen(),base='http://127.0.0.1:'+port,chat=hub.store.newChat({provider:'codex',workspace:process.cwd()}),other=hub.store.newChat({provider:'codex',workspace:process.cwd()}),foreign=hub.store.message(other.id,'assistant','codex','other');
    const started=await hub.runner.start(chat.id,'start');await until(()=>hub.runner.state(chat.id).inputReady);
    const body={text:'guide',runId:started.id,clientId:'api-guide'},path=base+'/api/chats/'+chat.id+'/guidance';
    assert.equal((await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
    const headers={'Content-Type':'application/json','X-Hub-Token':hub.token};
    assert.equal((await fetch(path,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(body)})).status,403);
    const rejected=await fetch(path,{method:'POST',headers,body:JSON.stringify({...body,replyTo:{messageId:foreign.id,questions:['q']}})});assert.ok(rejected.status>=400);
    const accepted=await fetch(path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(accepted.status,202);assert.equal((await accepted.json()).delivery,'accepted');
  }finally{release.resolve();await hub.close();}
});

const stock='你说的“示例项目”是项目A吗？我先按它与项目B、项目C比较；若编号不同，请告诉我。\n\n- 是项目A\n- 不确定编号\n\n你说的“主目录一半、子目录一半”，是新增文件各占一半，还是希望整个现有项目最终各占一半？这会影响如何计算已有文件的分布。\n\n- 新增文件各一半\n- 整个项目最终各一半\n- 还没想清楚';
test('plain-text questions recognize two question blocks, exclude unsafe/partial examples and keep ids stable',async()=>{
  const questions=await loadPublic('questions'),rows=questions.extract(stock);assert.equal(rows.length,2);assert.equal(rows[0].options[0].label,'是项目A');assert.equal(rows[1].options.length,3);
  assert.equal(questions.extract(stock,{allowTail:false}).length,1);assert.equal(questions.extract(stock+'\n\n接下来继续检查。',{allowTail:false}).length,2);
  for(const text of ['```md\nQuestion?\n- A\n- B\n```','批准删除？\n- 是\n- 否','普通概览\n- A\n- B','Question?\n- A'])assert.equal(questions.extract(text).length,0);
  assert.equal(rows[0].id,questions.extract(stock+'\n\nmore')[0].id);
  const message={id:'assistant',role:'assistant',status:'complete',content:stock,details:{}},state={messages:[message],run:null};
  assert.equal(questions.latest(state).questions.length,2);
  state.messages.push({role:'user',status:'pending',details:{replyTo:{messageId:message.id,questions:[rows[0].id]},guidance:{state:'queued'}}});assert.equal(questions.latest(state).questions.length,1);
  state.messages.at(-1).status='error';assert.equal(questions.latest(state).questions.length,2);
  state.run={approvals:[{kind:'question'}]};assert.equal(questions.latest(state).questions.length,0);
});

test('late guidance receipts cannot clear a live task or downgrade delivered messages, and reconnect recovers them',async()=>{
  const live=await loadPublic('live'),assistant={id:'assistant',role:'assistant',status:'running',created:'2026-10-07T00:00:00Z',details:{runId:'task'}},state={chat:{id:'chat'},run:{id:'task'},active:['chat'],messages:[assistant]};
  const delivered={id:'guide',role:'user',status:'complete',created:'2026-10-07T00:00:01Z',content:'guide',details:{liveRevision:2,guidance:{runId:'task',state:'delivered'}}};
  live.applyUpdate(state,{chatId:'chat',message:delivered});assert.equal(state.run.id,'task');assert.deepEqual(state.active,['chat']);
  live.applyUpdate(state,{chatId:'chat',message:{...delivered,status:'pending',details:{liveRevision:1}}});assert.equal(state.messages[1].status,'complete');
  const recovered={...delivered,id:'missed'};live.applyUpdate(state,{chatId:'chat',message:{...assistant,status:'complete',details:{runId:'task',liveRevision:3}},inputs:[recovered],run:null,active:[]});
  assert.ok(state.messages.some(row=>row.id==='missed'));assert.equal(state.run,null);
  assert.deepEqual(Array.from(live.orderedMessages(state.messages),row=>row.id),['guide','missed','assistant']);
});

test('guidance composer preserves drafts during editing, switching and question submissions',async()=>{
  const app=await readFile(new URL('../public/app-send.js',import.meta.url),'utf8'),code=app.slice(app.indexOf('async function sendGuidance('),app.indexOf('function resizePrompt()')),live=await loadPublic('live');
  for(const action of ['none','edit','switch','question','failure']){
    const release=gate(),state={chat:{id:'chat'},run:{id:'task',inputReady:true,inputMode:'steer'},active:['chat'],messages:[]},nodes={'#prompt':{value:'draft'}},drafts=new Map([['chat','draft']]),posted=[];
    const context=vm.createContext({state,coverOpen:false,sendingMessage:false,draftKey:()=>state.chat.id,$:selector=>nodes[selector],crypto:{randomUUID},t:text=>text,renderRun:()=>{},renderMessages:()=>{},resizePrompt:()=>{},localStorage:{getItem:key=>drafts.get(key)??null,setItem:(key,value)=>drafts.set(key,value),removeItem:key=>drafts.delete(key)},StarportComposer:{ids:()=>[]},liveSync:{receive:data=>live.applyUpdate(state,data),reconcile:async()=>{}},api:async(path,method,data)=>{posted.push({path,data});await release.promise;if(action==='failure')throw Error('native failed');return {delivery:'accepted',user:{id:'user',role:'user',status:'complete',details:{}}};}});
    vm.runInContext(code,context);const sending=context.sendGuidance('answer',action==='question'?{replyTo:{messageId:'assistant',questions:['q']},preserveDraft:true}:{});
    if(action==='edit')nodes['#prompt'].value='edited';if(action==='switch'){state.chat={id:'other'};state.run=null;nodes['#prompt'].value='other draft';}
    release.resolve();if(action==='failure')await assert.rejects(sending,/native failed/);else await sending;
    assert.equal(posted[0].path,action==='question'?'/chats/chat/guidance':'/chats/chat/queue');assert.equal(posted[0].data.runId,'task');
    assert.equal(nodes['#prompt'].value,action==='none'?'':action==='edit'?'edited':action==='switch'?'other draft':'draft');
    if(action==='question')assert.equal(posted[0].data.replyTo.messageId,'assistant');if(action==='switch')assert.equal(state.messages.length,0);else assert.equal(state.run.id,'task');
    assert.equal(drafts.has('chat'),!['none','switch'].includes(action));
    assert.equal(context.sendingMessage,false);
  }
});

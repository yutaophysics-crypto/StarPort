import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {runCodex} from '../src/adapters/codex.mjs';
import {runClaude} from '../src/adapters/claude.mjs';
import {runDeepseek} from '../src/adapters/deepseek.mjs';
import {Store} from '../src/storage.mjs';
import {Attachments} from '../src/attachments.mjs';
import {Runner} from '../src/runner.mjs';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const until=async check=>{for(let index=0;index<300;index++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture did not reach expected state');};
const runtime=mode=>({command:process.execPath,prefixArgs:[resolve('tests/fixtures/interactions-native.mjs'),mode]});
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),list:async()=>[],record:()=>{}};
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('fixture image')]).toString('base64');
const image={path:'/shots/a.png',mime:'image/png',data:png};

async function fixture(provider){
  const store=new Store(':memory:'),attachments=new Attachments(store,await mkdtemp(join(tmpdir(),'starport-guidance-'))),release=gate(),calls=[],steered=[];
  const runner=new Runner(store,registry,()=>{},{[provider]:async({emit,setControl,prompt,images})=>{
    calls.push({prompt,images});emit({type:'session',id:'resident'});
    setControl({inputMode:'steer',steer:async(text,options)=>{steered.push({text,...options});return {delivery:'accepted'};},stop:release.resolve});
    if(calls.length===1)await release.promise;
    emit({type:'replace',text:'Final '+calls.length});
  }},attachments);
  const chat=store.newChat({provider,workspace:process.cwd()});
  return {store,attachments,runner,chat,release,calls,steered,async close(){release.resolve();await runner.close();store.close();}};
}

for(const provider of ['codex','claude'])test(provider+' messages sent during a task carry their attachments when steered or sent next',async()=>{
  const f=await fixture(provider);
  try{
    await f.runner.start(f.chat.id,'initial');await until(()=>f.runner.state(f.chat.id)?.inputReady);
    const shot=await f.attachments.upload({name:'shot.png',data:png}),note=await f.attachments.upload({name:'note.md',data:Buffer.from('# 注意边界条件').toString('base64')});
    const runId=f.runner.state(f.chat.id).id;
    const row=f.runner.enqueue(f.chat.id,{text:'看这张图',clientId:randomUUID(),runId,attachments:[shot.id,note.id]}).queued;
    assert.deepEqual(row.details.attachments.map(item=>item.name),['shot.png','note.md']);assert.equal(row.details.attachments[0].data,undefined);
    assert.deepEqual(f.steered,[]);

    await f.runner.steerQueued(f.chat.id,row.id,{revision:row.revision,runId});
    assert.equal(f.steered.length,1);assert.match(f.steered[0].text,/^看这张图\n\n/);assert.match(f.steered[0].text,/# 注意边界条件/);
    assert.deepEqual(f.steered[0].images.map(item=>[item.mime,item.path,item.data]),[['image/png',shot.path,png]]);
    const steered=f.store.messages(f.chat.id).find(message=>message.details.guidance);
    assert.equal(steered.content,'看这张图');assert.deepEqual(steered.details.attachments.map(item=>item.id),[shot.id,note.id]);

    // A queued message waits for the next turn and brings its image along.
    const later=f.runner.enqueue(f.chat.id,{text:'再看这张',clientId:randomUUID(),runId,attachments:[shot.id]}).queued;
    f.release.resolve();await until(()=>f.calls.length===2&&!f.runner.active.has(f.chat.id));
    assert.deepEqual(f.calls[1].images.map(item=>item.path),[shot.path]);assert.match(f.calls[1].prompt,/再看这张[\s\S]*shot\.png/);
    const sent=f.store.messages(f.chat.id).filter(message=>message.role==='user').at(-1);
    assert.equal(sent.details.queuedMessage.id,later.id);assert.deepEqual(sent.details.attachments.map(item=>item.id),[shot.id]);
  }finally{await f.close();}
});

test('a reused message id with other attachments is refused, and missing attachments queue nothing',async()=>{
  const f=await fixture('codex');
  try{
    await f.runner.start(f.chat.id,'initial');await until(()=>f.runner.state(f.chat.id)?.inputReady);
    const shot=await f.attachments.upload({name:'shot.png',data:png}),runId=f.runner.state(f.chat.id).id,clientId=randomUUID();
    f.runner.enqueue(f.chat.id,{text:'图',clientId,runId,attachments:[shot.id]});
    assert.equal(f.runner.enqueue(f.chat.id,{text:'图',clientId,runId,attachments:[shot.id]}).queued.details.attachments.length,1);
    assert.throws(()=>f.runner.enqueue(f.chat.id,{text:'图',clientId,runId}),/另一条消息/);
    assert.throws(()=>f.runner.enqueue(f.chat.id,{text:'图',clientId:randomUUID(),runId,attachments:['missing']}),/附件不存在/);
    assert.equal(f.store.queue.list(f.chat.id).length,1);

    const guided=randomUUID();await f.runner.guidance(f.chat.id,{text:'补充',runId,clientId:guided,attachments:[shot.id]});
    await assert.rejects(()=>f.runner.guidance(f.chat.id,{text:'补充',runId,clientId:guided}),/另一条消息/);
    assert.equal((await f.runner.guidance(f.chat.id,{text:'补充',runId,clientId:guided,attachments:[shot.id]})).delivery,'accepted');
    assert.equal(f.steered.length,1);
  }finally{await f.close();}
});

test('Codex steers images into the running turn as local images',{timeout:6000},async()=>{
  let control;const events=[],controller=new AbortController();
  const running=runCodex({runtime:runtime('codex'),options:{mode:'chat',permissionMode:'ask'},prompt:'work',cwd:process.cwd(),signal:controller.signal,setControl:value=>control=value,emit:event=>events.push(event)});
  try{
    await until(()=>control?.canSend());
    assert.equal((await control.steer('看图',{images:[image]})).delivery,'accepted');await control.steer('finish');await running;
    const text=events.filter(event=>event.type==='replace').at(-1).text;
    assert.match(text,/"input":\[\{"type":"text","text":"看图","text_elements":\[\]\},\{"type":"localImage","path":"\/shots\/a\.png"\}\]/);
  }finally{controller.abort();await running.catch(()=>{});}
});

test('Claude steers images into the running turn as image blocks',async()=>{
  let control;const release=gate(),messages=[];
  const makeQuery=({prompt})=>({close(){},interrupt(){},async *[Symbol.asyncIterator](){
    const pump=(async()=>{for await(const row of prompt)messages.push(row);})();
    yield {type:'system',subtype:'init',session_id:'resident',model:'fixture'};
    await until(()=>messages.length);await release.promise;
    yield {type:'result',subtype:'success',session_id:'resident',result:'Seen',user_message_uuids:messages.slice(1).map(row=>row.uuid)};
    await pump;
  }});
  const running=runClaude({runtime:runtime('unused'),options:{permissionMode:'default'},prompt:'initial',cwd:process.cwd(),makeQuery,setControl:value=>control=value,emit:()=>{}});
  await until(()=>messages.length);await control.steer('看图',{id:randomUUID(),images:[image]});await control.steer('只有文字',{id:randomUUID()});
  await until(()=>messages.length===3);release.resolve();await running;
  assert.deepEqual(messages[1].message.content,[{type:'text',text:'看图'},{type:'image',source:{type:'base64',media_type:'image/png',data:png}}]);
  assert.equal(messages[2].message.content,'只有文字');
  await assert.rejects(()=>control.steer('late',{id:randomUUID(),images:[image]}),/结束/);
});

test('DeepSeek sends a queued image with the next native prompt',{timeout:6000},async()=>{
  let control;const events=[],controller=new AbortController();
  const running=runDeepseek({runtime:runtime('deepseek'),options:{provider:'fixture',model:'fixture'},prompt:'initial',cwd:process.cwd(),signal:controller.signal,emit:event=>events.push(event),setControl:value=>control=value});
  try{
    await until(()=>control?.canSend());await control.steer('看图',{id:'second',images:[image]});await running;
    const rows=events.filter(event=>event.type==='delta').map(event=>JSON.parse(event.text));
    assert.deepEqual(rows.map(row=>[row.text,row.images]),[['initial',[]],['看图',['image/png']]]);
  }finally{controller.abort();await running.catch(()=>{});}
});

test('the composer sends its attachments with a message during a task and then clears them',async()=>{
  const app=await readFile(new URL('../public/app-send.js',import.meta.url),'utf8'),code=app.slice(app.indexOf('async function sendGuidance('),app.indexOf('function resizePrompt()'));
  for(const text of ['看这张','',null]){
    // null: a server not yet restarted after the update, which would drop the attachments.
    const state={chat:{id:'chat'},run:{id:'task',inputReady:true,inputMode:'steer',...text===null?{}:{takesAttachments:true}}},nodes={'#prompt':{value:text}},posted=[],consumed=[];
    const context=vm.createContext({state,coverOpen:false,sendingMessage:false,draftKey:()=>'draft',$:selector=>nodes[selector],crypto:{randomUUID},t:value=>value,renderRun:()=>{},renderMessages:()=>{},resizePrompt:()=>{},localStorage:{removeItem:()=>{}},
      StarportComposer:{ids:()=>['shot'],busy:false,consume:(ids,key)=>consumed.push([ids,key])},liveSync:{receive:()=>{},reconcile:async()=>{}},
      api:async(path,method,data)=>{posted.push({path,data});return {queued:{id:'q'},queue:[],queueVersion:1};}});
    vm.runInContext(code,context);
    if(text===null){nodes['#prompt'].value='看这张';await assert.rejects(context.sendInput(),/仅支持文字/);assert.deepEqual(posted,[]);assert.deepEqual(consumed,[]);continue;}
    await context.sendInput();
    assert.equal(posted[0].path,'/chats/chat/queue');assert.deepEqual([...posted[0].data.attachments],['shot']);
    assert.equal(posted[0].data.text,text||'请查看这些附件。');assert.deepEqual(JSON.parse(JSON.stringify(consumed)),[[['shot'],'draft']]);
  }
});

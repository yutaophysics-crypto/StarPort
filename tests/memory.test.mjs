import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {createHub} from '../src/server.mjs';
const input={kind:'preference',title:'回复语言',content:'用户希望使用中文交流。'};
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record:()=>{},list:async()=>[]};
const trailer=proposals=>'\n```starport-memory\n'+JSON.stringify(proposals)+'\n```';
const until=async fn=>{for(let n=0;n<150;n++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('fixture timed out');};

test('candidate approval is explicit, revision protected, duplicate safe, durable and separate from profile',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'starport-memory-')),'hub.sqlite');let store=new Store(file);
  try{
    const m=store.memory,row=m.create(input);assert.equal(row.status,'candidate');assert.equal(m.epoch,0);assert.equal(m.recall('中文').items.length,0);assert.equal(m.list({view:'profile'}).total,0);
    assert.throws(()=>m.update(row.id,{revision:0,confirm:true}),error=>error.status===409);
    const edited=m.update(row.id,{revision:1,content:'用户希望简洁地使用中文交流。'});assert.equal(edited.status,'candidate');assert.equal(m.epoch,0);
    const saved=m.update(row.id,{revision:edited.revision,confirm:true});assert.equal(saved.status,'confirmed');assert.equal(m.epoch,1);assert.equal(m.list({view:'profile'}).total,1);assert.equal(m.search({query:'中文'}).items[0].id,row.id);assert.equal(m.read([row.id]).items[0].id,row.id);assert.equal(m.recall('问题').items.length,0);
    assert.equal(m.create({...input,content:saved.content}).id,row.id);assert.throws(()=>m.remove(row.id,1),error=>error.status===409);
    store.close();store=new Store(file);assert.equal(store.memory.get(row.id).status,'confirmed');assert.equal(store.memory.epoch,1);
    store.memory.remove(row.id,saved.revision);assert.equal(store.memory.recall('中文').items.length,0);assert.equal(store.memory.epoch,2);
    assert.equal(store.memory.create({...input,content:saved.content},{respectRejection:true}),null);
    const recreated=store.memory.create({...input,content:saved.content},{confirmed:true});assert.equal(recreated.status,'confirmed');
    const candidate=store.memory.create({...input,content:'独立候选'});assert.equal(store.memory.create({...input,content:'独立候选'},{confirmed:true}).status,'confirmed');assert.equal(store.memory.get(candidate.id).status,'confirmed');
  }finally{store.close();}
});

test('deleting a source chat keeps memories and evidence, and removing a memory never deletes chat or files',()=>{
  const s=new Store(':memory:');try{
    const chat=s.newChat({workspace:process.cwd()}),user=s.message(chat.id,'user','claude','我希望以后用中文交流。');
    const memory=s.memory.create(input,{confirmed:true,origin:'assistant',source:{chat,message:user,provider:'claude',evidence:user.content}});
    s.deleteChat(chat.id);const kept=s.memory.get(memory.id);assert.equal(kept.source_chat,null);assert.equal(kept.source_message,null);assert.equal(kept.evidence,user.content);assert.equal(kept.status,'confirmed');
    const unrelated=s.newChat({title:'keep'});s.memory.remove(memory.id,kept.revision);assert.ok(s.chat(unrelated.id));assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{s.close();}
});

test('proposals require verbatim user evidence; never auto-approve or store credentials, and metadata stays out of answers',()=>{
  const s=new Store(':memory:');try{
    const chat=s.newChat({workspace:process.cwd()}),user=s.message(chat.id,'user','codex','我希望以后用中文交流。'),assistant=s.message(chat.id,'assistant','codex','已了解。'+trailer([
      {...input,evidence:user.content},{...input,content:'invented fact',evidence:'助手虚构的证据'},
      {...input,content:'password=secret123',evidence:user.content},{...input,kind:'invented',content:'bad',evidence:user.content}
    ]));assistant.details.activity=[{id:'answer',kind:'text',text:assistant.content}];
    const ids=s.memory.capture(chat,assistant,s.messages(chat.id));assert.equal(ids.length,1);assert.equal(assistant.content,'已了解。');assert.equal(assistant.details.activity[0].text,'已了解。');assert.equal(s.memory.list({view:'candidate'}).total,1);assert.equal(s.memory.epoch,0);
    s.memory.remove(ids[0],1);assistant.content='再提议。'+trailer([{...input,evidence:user.content}]);assert.deepEqual(s.memory.capture(chat,assistant,[user]),[]);
    s.memory.configure({capture:false});assistant.content='答复。'+trailer([{...input,content:'另一个偏好',evidence:user.content}]);assert.deepEqual(s.memory.capture(chat,assistant,[user]),[]);assert.equal(assistant.content,'答复。');
  }finally{s.close();}
});

test('candidate indexes and explicit reads are bounded; Chinese/English searches do not execute wildcards',()=>{
  const s=new Store(':memory:');try{
    const m=s.memory;m.create(input,{confirmed:true});const knowledge=m.create({kind:'knowledge',title:'分形对偶',content:'分形对偶研究需要先区分物理空间与算子映射。'},{confirmed:true});m.create({kind:'knowledge',title:'gardening',content:'Rose gardening notes'},{confirmed:true});
    assert.ok(m.search({query:'解释分形对偶'}).items.some(row=>row.id===knowledge.id));assert.equal(m.search({query:'gardening'}).items.length,1);assert.equal(m.recall('gardening').items.length,0);
    for(let n=0;n<20;n++)m.create({kind:'knowledge',title:'分形对偶 '+n,content:'分形对偶 '+n+' '+('字'.repeat(900))},{confirmed:true});assert.ok(m.recall('解释分形对偶').text.length<9200);assert.equal(m.recall('解释分形对偶').items.length,0);
    assert.equal(m.list({search:'%'}).total,0);assert.equal(m.list({search:'_'}).total,0);assert.equal(m.list({limit:3,offset:3}).items.length,3);assert.throws(()=>m.list({offset:NaN}));
    const before=m.epoch;m.configure({enabled:false});assert.equal(m.epoch,before+1);assert.equal(m.recall('中文').text,'');assert.ok(m.list().total>0);assert.throws(()=>m.configure({enabled:'true'}));
    const upper=m.create({kind:'knowledge',title:'大写变量',content:'变量 X 的定义'}),lower=m.create({kind:'knowledge',title:'小写变量',content:'变量 x 的定义'});assert.notEqual(upper.id,lower.id);
  }finally{s.close();}
});

test('backups preserve records as review candidates and malformed memory imports roll back the whole import',()=>{
  const original=new Store(':memory:'),restored=new Store(':memory:');try{
    original.newChat({title:'backup',workspace:process.cwd()});original.memory.create(input,{confirmed:true});const backup=original.export();
    const result=restored.import(backup);assert.equal(result.memories,1);assert.equal(restored.memory.list({view:'candidate'}).total,1);assert.equal(restored.memory.recall('中文').text,'');
    const legacy={...backup};delete legacy.sharedMemory;const legacyStore=new Store(':memory:');try{assert.equal(legacyStore.import(legacy).memories,0);}finally{legacyStore.close();}
    const bad=structuredClone(backup);bad.sharedMemory.items.push({...input,status:'confirmed',kind:'bad'});const count=restored.list().chats.length;assert.throws(()=>restored.import(bad));assert.equal(restored.list().chats.length,count);assert.equal(restored.memory.list({view:'candidate'}).total,1);
  }finally{original.close();restored.close();}
});

for(const provider of ['codex','claude','antigravity','deepseek'])test(provider+' receives only confirmed shared memories, captures candidates and refreshes native sessions after edits',async()=>{
  const s=new Store(':memory:'),calls=[];const runner=new Runner(s,registry,()=>{},{[provider]:async args=>{calls.push(args);const found=await args.contextTools.call('starport_memory_search',{kind:'preference'});args.memoryRead=found.items.length?await args.contextTools.call('starport_memory_read',{ids:[found.items[0].id],reason:'根据用户明确的语言偏好选择回答语言。'}):{items:[]};args.emit({type:'session',id:'native'});args.emit({type:'replace',text:'回答完成。'+trailer([{kind:'goal',title:'学习方向',content:'用户想长期学习数学。',evidence:'我想长期学习数学'}])});}});
  try{
    const chat=s.newChat({provider,workspace:process.cwd()}),pending=s.memory.create({...input,content:'do not send this pending memory'});const saved=s.memory.create(input,{confirmed:true});
    await runner.start(chat.id,'我想长期学习数学');await until(()=>!runner.active.has(chat.id));assert.match(calls[0].memoryRead.items[0].content,/用户希望使用中文交流/);assert.doesNotMatch(calls[0].prompt,/用户希望使用中文交流|do not send/);
    assert.equal(s.lastAssistant(chat.id).content,'回答完成。');assert.equal(s.memory.list({view:'candidate'}).total,2);assert.equal(s.lastAssistant(chat.id).details.memory.ids[0],saved.id);
    await runner.start(chat.id,'继续');await until(()=>!runner.active.has(chat.id));assert.equal(calls[1].session,provider==='deepseek'?undefined:'native');
    s.memory.update(saved.id,{revision:saved.revision,content:'用户现在希望使用英文。'});
    await runner.start(chat.id,'新的请求');await until(()=>!runner.active.has(chat.id));assert.equal(calls[2].session,undefined);assert.match(calls[2].memoryRead.items[0].content,/用户现在希望使用英文/);assert.doesNotMatch(calls[2].prompt,/用户希望使用中文交流/);assert.doesNotMatch(calls[2].prompt,/```starport-memory\n/);
    s.memory.remove(saved.id,s.memory.get(saved.id).revision);await runner.start(chat.id,'删除后');await until(()=>!runner.active.has(chat.id));assert.equal(calls[3].session,undefined);assert.doesNotMatch(calls[3].prompt,/用户现在希望使用英文/);assert.ok(s.memory.get(pending.id));
  }finally{await runner.close();s.close();}
});

test('memory edits during an active task apply next turn without stopping it; failed replies produce no candidates',async()=>{
  const s=new Store(':memory:');let release,called=0;const wait=new Promise(resolve=>release=resolve),runner=new Runner(s,registry,()=>{},{codex:async({emit,prompt})=>{called++;emit({type:'context',context:{status:'ready',usedTokens:100,windowTokens:1000}});emit({type:'replace',text:'未完成'+trailer([{...input,evidence:'我希望用中文'}])});if(called===1)await wait;throw Error('failure');}});
  try{const chat=s.newChat({workspace:process.cwd()}),row=s.memory.create(input,{confirmed:true});const initial=await runner.start(chat.id,'我希望用中文');await until(()=>called===1);s.memory.update(row.id,{revision:1,content:'变更后的偏好'});assert.equal(runner.state(chat.id).id,initial.id);assert.equal(runner.context(chat.id).usedTokens,100);release();await until(()=>!runner.active.has(chat.id));assert.equal(s.memory.list({view:'candidate'}).total,0);assert.equal(s.lastAssistant(chat.id).status,'error');}finally{release();await runner.close();s.close();}
});

test('memory API enforces origin/token, bounded inputs, revision conflicts and explicit confirmation',async()=>{
  const hub=createHub({dataDir:mkdtempSync(join(tmpdir(),'starport-memory-api-')),port:0,registry});const base='http://127.0.0.1:'+await hub.listen();
  const req=(path,method='GET',data,headers={})=>fetch(base+'/api'+path,{method,headers:{'X-Hub-Token':hub.token,'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});
  try{
    assert.equal((await fetch(base+'/api/memories')).status,401);assert.equal((await req('/memories','POST',input,{Origin:'https://evil.test'})).status,403);
    const row=await (await req('/memories','POST',input)).json();assert.equal(row.status,'candidate');assert.equal((await req('/memories/'+row.id,'PATCH',{revision:0,confirm:true})).status,409);
    assert.equal((await req('/memories/'+row.id,'PATCH',{revision:1,confirm:true})).status,200);assert.equal((await (await req('/memories?view=profile')).json()).total,1);
    assert.equal((await req('/memories?offset=-1')).status,400);assert.equal((await req('/memories','POST',{...input,content:'x'.repeat(2100)})).status,400);assert.equal((await req('/memories/config','PATCH',{capture:false})).status,200);
    assert.equal((await req('/memories/'+row.id,'DELETE',{revision:2})).status,200);assert.equal((await req('/memories/'+row.id)).status,404);
  }finally{await hub.close();}
});

test('a preference delivered as guidance can become a candidate, while queued and unsent drafts cannot',async()=>{
  const s=new Store(':memory:');let release,seen='';const wait=new Promise(resolve=>release=resolve),runner=new Runner(s,registry,()=>{},{codex:async({setControl,emit})=>{
    setControl({inputMode:'steer',steer:async text=>{seen=text;return {delivery:'accepted'};}});await wait;
    emit({type:'replace',text:'收到。'+trailer([{...input,evidence:seen},{...input,content:'未送达的偏好',evidence:'这条草稿没有送达'}])});
  }});
  try{const chat=s.newChat({workspace:process.cwd()});const run=await runner.start(chat.id,'初始任务');await until(()=>runner.state(chat.id)?.inputReady);await runner.guidance(chat.id,{text:'我希望以后用中文交流。',runId:run.id,clientId:'memory-guidance'});s.queue.add(chat.id,{text:'这条草稿没有送达',clientId:'unsent-draft'});s.queue.hold(chat.id,'test hold');release();await until(()=>!runner.active.has(chat.id));const items=s.memory.list({view:'candidate'}).items;assert.equal(items.length,1);assert.equal(items[0].evidence,seen);assert.equal(s.memory.epoch,0);}finally{release();await runner.close();s.close();}
});

test('metadata streaming remains invisible, regular Markdown is intact, and memory chrome is bilingual',()=>{
  const sandbox={};runInNewContext(readFileSync(new URL('../public/memory-protocol.js',import.meta.url),'utf8'),sandbox);const split=sandbox.StarportMemoryProtocol.split;
  assert.equal(split('Answer\n```starport-memory\n[{').text,'Answer');assert.equal(split('Answer'+trailer([input])).proposals.length,1);assert.equal(split('```starport-memory\n[]\n```').text,'');assert.equal(split('ordinary\n```json\n{}\n```').text,'ordinary\n```json\n{}\n```');assert.equal(split('Answer\n```starport-memory\ninvalid\n```').text,'Answer');
  const example='Protocol example:'+trailer([input])+'\nExplanation afterwards.';assert.equal(split(example).text,example);assert.equal(split(example+trailer([input])).text,example);
  const i18n={localStorage:{getItem:()=>null,setItem:()=>{}}};runInNewContext(readFileSync(new URL('../public/i18n.js',import.meta.url),'utf8'),i18n);i18n.StarportI18n.setLanguage('en');
  const source=['memory.js','memory-receipt.js'].map(file=>readFileSync(new URL('../public/'+file,import.meta.url),'utf8')).join('\n');const labels=[...source.matchAll(/translated\('[^']+','([^']+)'|t\('([^']+)'/g)].map(match=>match[1]||match[2]);for(const label of labels)assert.ok(!/\p{Script=Han}/u.test(i18n.StarportI18n.t(label)),label);
});

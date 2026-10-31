import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const registry=()=>({resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true}))});
function refreshSource(app){
  const start=app.search(/async\s+function\s+refresh\s*\(\s*\)\s*\{/),end=app.search(/async\s+function\s+openChat\s*\(/);
  assert.ok(start>=0&&end>start,'Refresh source boundaries must be present');return app.slice(start,end);
}
test('every provider pushes a settled terminal packet for completion, failure and stop',async()=>{
  for(const provider of Object.keys(PROVIDERS))for(const status of ['complete','error','interrupted']){
    const store=new Store(':memory:'),events=[],release=deferred();
    const fake=async({emit,setControl})=>{
      setControl({stop:()=>release.resolve()});emit({type:'tool',id:'last-operation',name:'read_file',status:'running'});
      emit({type:'subagent',id:'unfinished-child',name:'Child',status:'running',startedAt:Date.now(),updatedAt:Date.now()});
      emit({type:'replace',text:'Final response'});
      if(status==='interrupted'){await release.promise;throw Object.assign(Error('stopped'),{canceled:true});}
      if(status==='error')throw Error('failure');
    };
    const runner=new Runner(store,registry(),(type,data)=>events.push({type,data:structuredClone(data)}),{[provider]:fake});
    try{
      const chat=store.newChat({provider,workspace:process.cwd()});await runner.start(chat.id,'start');const run=runner.active.get(chat.id);
      if(status==='interrupted'){await new Promise(resolve=>setImmediate(resolve));await runner.stop(chat.id);}
      await run.done;
      const final=events.filter(e=>e.type==='message').at(-1)?.data;
      assert.equal(final?.message.status,status,provider+' terminal message status');assert.equal(final.run,null,provider+' run must be absent in final packet');
      assert.equal(final.message.details.tools[0].status,status==='interrupted'?'interrupted':'unknown');
      assert.equal(final.message.details.subagents[0].status,status==='interrupted'?'interrupted':'unknown');
      assert.ok(final.message.details.endedAt);assert.ok(!runner.active.has(chat.id));
      assert.equal(store.messages(chat.id).at(-1).status,status);assert.equal(final.runId,run.id);
    }finally{await runner.close();store.close();}
  }
});
test('late adapter events cannot change a saved terminal result or interfere with a subsequent run',async()=>{
  const store=new Store(':memory:'),callbacks=[],release=deferred(),events=[];
  const runner=new Runner(store,registry(),(type,data)=>events.push({type,data:structuredClone(data)}),{codex:async({emit})=>{callbacks.push(emit);emit({type:'replace',text:'answer'});if(callbacks.length===2)await release.promise;}});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()});await runner.start(chat.id,'one');await runner.active.get(chat.id).done;const saved=store.lastAssistant(chat.id),count=events.length;
    callbacks[0]({type:'tool',id:'late',status:'running'});assert.deepEqual(store.lastAssistant(chat.id),saved);assert.equal(events.length,count);
    await runner.start(chat.id,'two');await new Promise(resolve=>setImmediate(resolve));const newRun=runner.state(chat.id);
    callbacks[0]({type:'replace',text:'stale result'});assert.equal(runner.state(chat.id).id,newRun.id);assert.equal(store.lastAssistant(chat.id).content,'answer');release.resolve();await runner.active.get(chat.id).done;
  }finally{release.resolve();await runner.close();store.close();}
});
test('lightweight live status bypasses provider probes and history, remains authenticated and reflects completion',async t=>{
  const gate=deferred(),reg=registry();let probes=0,historyReads=0;reg.list=async()=>{probes++;await gate.promise;return [];};
  const verification={ok:true,date:'2026-10-11T18:28:04.901Z'};reg.verifications=()=>({antigravity:verification});
  const hub=createHub({port:0,dataDir:await mkdtemp(join(tmpdir(),'starport-live-')),registry:reg,implementations:{codex:async({emit})=>{emit({type:'tool',id:'tool',status:'running'});emit({type:'replace',text:'answer'});}}});
  const port=await hub.listen(),base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token};t.after(async()=>{gate.resolve();await hub.close();});
  const chat=hub.store.newChat({provider:'codex',workspace:process.cwd()});hub.runner.messages=async()=>{historyReads++;throw Error('must not recover history');};
  assert.equal((await fetch(base+'/api/live')).status,401);
  assert.equal((await fetch(base+'/api/live',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/live?chatId=missing',{headers})).status,404);
  await hub.runner.start(chat.id,'hello');const run=hub.runner.active.get(chat.id);await run.done;
  const response=await fetch(base+'/api/live?chatId='+chat.id,{headers,signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);const live=await response.json();
  assert.equal(live.run,null);assert.equal(live.message.status,'complete');assert.equal(live.message.content,'answer');assert.equal(live.message.details.tools[0].status,'unknown');assert.deepEqual(live.active,[]);assert.equal(probes,0);assert.equal(historyReads,0);
  assert.deepEqual(live.providerVerifications.antigravity,verification);
  const card=hub.store.message(chat.id,'assistant',null,'card','complete',{liveRevision:2});hub.store.message(chat.id,'assistant','codex','later','complete',{});
  const followed=await(await fetch(base+'/api/live?chatId='+chat.id+'&follow='+card.id+',bad%20id,'+chat.id,{headers})).json();
  assert.equal(followed.message.content,'later');assert.deepEqual(followed.followed.map(row=>row.id),[card.id]);
});
test('full chat and app snapshots remain coherent when completion or chat creation happens during asynchronous reads',async t=>{
  const gate=deferred(),entered=deferred(),finish=deferred(),listGate=deferred(),listEntered=deferred(),reg=registry();
  reg.list=async()=>{listEntered.resolve();await listGate.promise;return [];};
  const hub=createHub({port:0,dataDir:await mkdtemp(join(tmpdir(),'starport-coherent-')),registry:reg,implementations:{codex:async({emit})=>{emit({type:'replace',text:'answer'});await finish.promise;}}});
  const port=await hub.listen(),base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token};t.after(async()=>{gate.resolve();finish.resolve();listGate.resolve();await hub.close();});
  const chat=hub.store.newChat({provider:'codex',workspace:process.cwd()});await hub.runner.start(chat.id,'hello');const run=hub.runner.active.get(chat.id);
  hub.runner.messages=async id=>{const old=hub.store.messages(id);entered.resolve();await gate.promise;return old;};
  const pending=fetch(base+'/api/chats/'+chat.id,{headers});await entered.promise;finish.resolve();await run.done;gate.resolve();
  const snapshot=await(await pending).json();assert.equal(snapshot.run,null);assert.equal(snapshot.messages.at(-1).status,'complete');assert.equal(snapshot.messages.at(-1).details.tools?.length||0,0);
  const app=fetch(base+'/api/state',{headers});await listEntered.promise;const newer=hub.store.newChat({provider:'claude',workspace:process.cwd()});listGate.resolve();assert.ok((await(await app).json()).chats.some(row=>row.id===newer.id));
});
async function loadLive(){const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/live.js',import.meta.url),'utf8'),context);return context.StarportLive;}
const message=(status='running',revision=1,id='assistant')=>({id,role:'assistant',status,created:'2026-10-06T00:00:00Z',content:'answer',details:{liveRevision:revision,tools:[{id:'tool',status:status==='running'?'running':'unknown'}]}});
const clientState=()=>({chat:{id:'chat'},messages:[message()],run:{id:'run'},active:['chat'],context:null});
function eventTarget(){const listeners=new Map();return {hidden:false,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type),fire:(type,value)=>listeners.get(type)?.(value),close:()=>{}};}
async function clientFixture(api){
  const live=await loadLive(),state=clientState(),events=eventTarget(),doc=eventTarget(),win=eventTarget(),changes=[];let view=0,tick;
  const sync=live.create({state,api,viewRevision:()=>view,onChange:change=>changes.push(change),events,document:doc,window:win,setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{}});
  return {live,state,events,doc,win,changes,sync,tick:()=>tick(),switchChat:id=>{view++;state.chat={id};state.messages=[];state.run=null;}};
}
const finalPacket=()=>({chatId:'chat',message:message('complete',2),runId:'run',run:null,active:[],context:null});

test('completion and reconnect update provider status even for background chats, and stale failures cannot replace success',async()=>{
  const old={ok:false,error:'Old connection error',date:'2026-10-11T10:00:00Z'},success={ok:true,error:'',date:'2026-10-11T11:00:00Z'};
  const f=await clientFixture(async()=>({active:[],providerVerifications:{antigravity:success}}));
  f.state.providers=[{id:'antigravity',verification:old}];
  try{
    f.events.fire('message',{data:JSON.stringify({...finalPacket(),chatId:'background',providerVerifications:{antigravity:success}})});
    assert.equal(f.state.providers[0].verification.ok,true);assert.equal(f.changes.at(-1).providersChanged,true);
    const revision=f.sync.revision;f.sync.receive({providerVerifications:{antigravity:old}});
    assert.equal(f.state.providers[0].verification.ok,true);assert.equal(f.sync.revision,revision);
    f.state.providers[0].verification=old;f.events.onopen();await f.sync.reconcile();
    assert.equal(f.state.providers[0].verification.ok,true);
  }finally{f.sync.close();}
});

test('live provider success invalidates an older full refresh without depending on a message change',async()=>{
  const old={ok:false,date:'2026-10-11T10:00:00Z'},success={ok:true,date:'2026-10-11T11:00:00Z'},gate=deferred();
  const f=await clientFixture(async()=>({providerVerifications:{antigravity:success}}));f.state.providers=[{id:'antigravity',verification:old}];
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),code=refreshSource(app);
  const context=vm.createContext({state:f.state,viewRevision:0,refreshSequence:0,saveChain:Promise.resolve(),liveSync:f.sync,api:async()=>gate.promise,renderView:()=>{}});
  try{
    vm.runInContext(code,context);const refreshing=context.refresh();await new Promise(resolve=>setImmediate(resolve));
    f.sync.receive({providerVerifications:{antigravity:success}});gate.resolve({groups:[],chats:[{id:'chat'}],providers:[{id:'antigravity',verification:old}],active:[]});await refreshing;
    assert.equal(f.state.providers[0].verification.ok,true);
  }finally{f.sync.close();}
});

test('provider outcomes in the same millisecond use their saved order, including a genuine later failure',async()=>{
  const live=await loadLive(),date='2026-10-11T10:00:00Z',state={...clientState(),providers:[{id:'antigravity',verification:{ok:false,date,revision:1}}]};
  live.applyUpdate(state,{providerVerifications:{antigravity:{ok:true,date,revision:2}}});assert.equal(state.providers[0].verification.ok,true);
  live.applyUpdate(state,{providerVerifications:{antigravity:{ok:false,date,revision:1}}});assert.equal(state.providers[0].verification.ok,true);
  live.applyUpdate(state,{providerVerifications:{antigravity:{ok:false,date,revision:3}}});assert.equal(state.providers[0].verification.ok,false);
});

test('sidebar statuses recover background completion and preserve read receipts against late packets',async()=>{
  const f=await clientFixture(async()=>({active:[],chatStatuses:[{id:'background',last_assistant_id:'answer',last_assistant_sequence:2,last_assistant_status:'complete',read_revision:0,unread:true}]}));
  try{
    f.state.chats=[{id:'background',title:'Fixture',last_assistant_id:'answer',last_assistant_sequence:2,last_assistant_status:'running',read_revision:0,unread:false}];f.state.active=['background'];
    await f.sync.reconcile();assert.equal(f.state.chats[0].unread,true);assert.equal(f.changes.at(-1).sidebarChanged,true);
    f.sync.receive({chatId:'background',chat:{...f.state.chats[0],read_message_id:'answer',read_revision:1,unread:false}});
    assert.equal(f.state.chats[0].unread,false);
    f.sync.receive({chatId:'background',chat:{...f.state.chats[0],read_message_id:null,read_revision:0,unread:true}});assert.equal(f.state.chats[0].unread,false);
    f.sync.receive({chatId:'background',chat:{...f.state.chats[0],last_assistant_status:'running'},active:['background']});assert.deepEqual(Array.from(f.state.active),[]);
    f.sync.receive({chatId:'background',chat:{...f.state.chats[0],last_assistant_id:'new',last_assistant_sequence:3,last_assistant_status:'complete'},active:[]});assert.equal(f.state.chats[0].unread,true);
    f.sync.receive({chatId:'background',chat:{id:'background',last_assistant_id:'answer',last_assistant_sequence:2,last_assistant_status:'complete'},active:['background']});assert.equal(f.state.chats[0].last_assistant_id,'new');assert.deepEqual(Array.from(f.state.active),[]);
  }finally{f.sync.close();}
});
test('terminal SSE updates clear the run immediately, preserve the final answer and reject older live packets',async()=>{
  const f=await clientFixture(async()=>finalPacket());f.events.fire('message',{data:JSON.stringify(finalPacket())});
  assert.equal(f.state.run,null);assert.equal(f.state.messages[0].status,'complete');assert.equal(f.state.messages[0].content,'answer');assert.equal(f.changes.at(-1).terminal,true);assert.equal(f.changes.at(-1).runChanged,true);
  f.events.fire('message',{data:JSON.stringify({chatId:'chat',message:message('running',1),run:{id:'run'},active:['chat']})});assert.equal(f.state.run,null);assert.equal(f.state.messages[0].status,'complete');assert.deepEqual(Array.from(f.state.active),[]);
  const revision=f.sync.revision;f.sync.receive(finalPacket());assert.equal(f.sync.revision,revision,'unchanged polling must not invalidate concurrent refreshes');
  f.state.messages.push({...message('running',1,'new-assistant'),created:'2026-10-06T00:00:01Z'});f.state.run={id:'new-run'};f.state.active=['chat'];f.sync.receive(finalPacket());assert.equal(f.state.run.id,'new-run');assert.equal(f.state.messages.at(-1).status,'running');f.sync.close();
});
test('reconnect, foreground and active-run polling recover missed completion without touching drafts',async()=>{
  let reads=0;const f=await clientFixture(async()=>{reads++;return finalPacket();});f.state.draft='keep this';f.events.onerror();f.events.onopen();await f.sync.reconcile();assert.equal(f.state.run,null);assert.equal(f.state.draft,'keep this');assert.equal(reads,1);
  f.state.run={id:'run'};f.state.active=['chat'];f.tick();await f.sync.reconcile();assert.equal(f.state.run,null);assert.equal(reads,2);
  f.doc.hidden=true;f.tick();assert.equal(reads,2);f.doc.hidden=false;f.doc.fire('visibilitychange');await f.sync.reconcile();assert.equal(reads,3);f.win.fire('pageshow');await f.sync.reconcile();assert.equal(reads,4);f.sync.close();
});
test('late live HTTP responses and full-page refreshes cannot overwrite newer events or a switched chat',async()=>{
  const gate=deferred(),f=await clientFixture(async()=>gate.promise);const pending=f.sync.reconcile();
  f.sync.receive(finalPacket());gate.resolve({chatId:'chat',message:message(),run:{id:'run'},active:['chat']});await pending;assert.equal(f.state.run,null);assert.equal(f.state.messages[0].status,'complete');
  const changed=deferred(),other=await clientFixture(async()=>changed.promise),request=other.sync.reconcile();other.switchChat('different');changed.resolve(finalPacket());await request;assert.equal(other.state.chat.id,'different');assert.equal(other.state.messages.length,0);
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),code=refreshSource(app);
  const slow=deferred(),state=clientState(),context=vm.createContext({state,viewRevision:0,refreshSequence:0,saveChain:Promise.resolve(),liveSync:{revision:0},api:async path=>path==='/state'?slow.promise:{messages:[message()],run:{id:'run'}},renderView:()=>{}});
  vm.runInContext(code,context);const refreshing=context.refresh();await new Promise(resolve=>setImmediate(resolve));state.messages=[message('complete',2)];state.run=null;context.liveSync.revision++;
  slow.resolve({groups:[],chats:[{id:'chat'}],providers:[],active:['chat']});await refreshing;assert.equal(state.run,null);assert.equal(state.messages[0].status,'complete');f.sync.close();other.sync.close();
});
test('a run card above the latest reply keeps being read back until its missed end arrives',async()=>{
  const card=(status,revision)=>({...message(status,revision,'card'),details:{liveRevision:revision,workflowRun:{status:status==='complete'?'done':'running',steps:[]}}});
  const paths=[];let followed=card('running',3);
  const f=await clientFixture(async path=>{paths.push(path);return {chatId:'chat',message:message('complete',2),run:null,active:[],followed:[followed]};});
  try{
    f.state.messages=[card('running',3),{...message('complete',2),created:'2026-10-06T00:00:01Z'}];f.state.run=null;f.state.active=[];
    await f.sync.reconcile();
    assert.match(paths.at(-1),/[?&]follow=card(&|$)/,'the card is not the latest reply, so it is named');
    f.tick();await f.sync.reconcile();
    assert.equal(paths.length,2,'polling goes on while a card is running, though the latest reply is done');
    followed=card('complete',4);f.events.onerror();f.events.onopen();await f.sync.reconcile();
    assert.equal(f.state.messages[0].status,'complete');assert.equal(f.state.messages[0].details.workflowRun.status,'done');
    assert.equal(f.changes.at(-1).currentChanged,true);
    f.tick();assert.equal(paths.length,3,'nothing is left running, so polling stops');
  }finally{f.sync.close();}
});
test('a run card added below a running reply does not make that reply\'s own end look stale',async()=>{
  const live=await loadLive(),state=clientState();
  live.applyUpdate(state,{chatId:'chat',message:{...message('running',1,'card'),created:'2026-10-06T00:00:01Z',details:{liveRevision:1,workflowRun:{status:'running'}}}});
  assert.deepEqual(Array.from(state.messages,m=>m.id),['assistant','card'],'a call made mid-turn shows below the reply');
  const change=live.applyUpdate(state,finalPacket());
  assert.equal(state.messages[0].status,'complete');assert.equal(state.run,null,'the stop button goes at once');assert.equal(change.runChanged,true);
  live.applyUpdate(state,{chatId:'chat',message:message('running',1),run:{id:'run'},active:['chat']});
  assert.equal(state.run,null,'a late packet still cannot restart the finished reply');
});
test('live status reads back followed messages of its own chat only',async()=>{
  const store=new Store(':memory:'),runner=new Runner(store,registry(),()=>{},{});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()}),other=store.newChat({provider:'codex',workspace:process.cwd()});
    const card=store.message(chat.id,'assistant',null,'card','running',{liveRevision:1,workflowRun:{status:'running'}});
    store.message(chat.id,'assistant','codex','answer','complete',{});
    const foreign=store.message(other.id,'assistant',null,'elsewhere','running',{});
    card.status='complete';card.details.liveRevision=2;store.saveMessage(card);
    const live=runner.live(chat.id,[card.id,foreign.id,'missing']);
    assert.equal(live.message.content,'answer');
    assert.deepEqual(live.followed.map(row=>[row.id,row.status,row.details.liveRevision]),[[card.id,'complete',2]]);
    assert.equal(Object.hasOwn(runner.live(chat.id),'followed'),false);
  }finally{await runner.close();store.close();}
});
test('failed live reconciliation is retried and concurrent requests share one read',async()=>{
  let reads=0;const gate=deferred(),f=await clientFixture(async()=>{reads++;if(reads===1)throw Error('network');return gate.promise;});
  await f.sync.reconcile();assert.equal(f.state.run.id,'run');f.tick();const another=f.sync.reconcile();assert.equal(reads,2);gate.resolve(finalPacket());await another;assert.equal(f.state.run,null);f.sync.close();
});
test('a full refresh that returns late cannot overwrite a more recent full refresh',async()=>{
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),code=refreshSource(app);
  const gates=[deferred(),deferred()];let calls=0;const state=clientState(),context=vm.createContext({state,viewRevision:0,refreshSequence:0,saveChain:Promise.resolve(),liveSync:{revision:0},api:async path=>path==='/state'?gates[calls++].promise:{messages:[message('complete',2)],run:null},renderView:()=>{}});
  vm.runInContext(code,context);const old=context.refresh(),newer=context.refresh();await new Promise(resolve=>setImmediate(resolve));
  gates[1].resolve({groups:[],chats:[{id:'chat'}],providers:[],active:[]});await newer;gates[0].resolve({groups:[],chats:[{id:'chat'}],providers:[],active:['chat']});await old;
  assert.equal(state.run,null);assert.equal(state.messages[0].status,'complete');assert.deepEqual(state.active,[]);
});
test('send completion bypasses blocked metadata refresh and late acknowledgements preserve newer answers and drafts',async()=>{
  const live=await loadLive(),app=await readFile(new URL('../public/app-send.js',import.meta.url),'utf8'),code=app.slice(app.indexOf('function acceptMessageResult('),app.indexOf('function resizePrompt()'));
  for(const action of ['none','edit','append','switch']){
    const metadata=deferred(),accepted=deferred(),state=clientState();state.messages=[message('complete',2)];state.run=null;
    const nodes={'#prompt':{value:'original'},'#send':{disabled:false},'#conversation':{scrollTop:0,scrollHeight:0}},consumed=[],drafts=new Map([['chat','original']]);
    const context=vm.createContext({state,StarportLive:live,liveSync:{reconcile:async()=>{}},coverOpen:false,viewRevision:0,saveChain:Promise.resolve(),draftKey:()=>state.chat?.id||'new',currentProvider:()=>({installed:true}),$:selector=>nodes[selector],document:{activeElement:null},Event,t:text=>text,toast:()=>{},resizePrompt:()=>{},renderRun:()=>{nodes['#send'].disabled=false;},renderMessages:()=>{},refresh:()=>metadata.promise,localStorage:{getItem:key=>drafts.get(key)??null,setItem:(key,value)=>drafts.set(key,value),removeItem:key=>drafts.delete(key)},api:async()=>accepted.promise,StarportComposer:{ids:()=>['sent-attachment'],busy:false,prepareVideos:async()=>{},consume:(ids,key)=>consumed.push({ids,key})}});
    vm.runInContext(code,context);const sending=context.sendMessage('original');await new Promise(resolve=>setImmediate(resolve));
    if(action==='edit')nodes['#prompt'].value='new draft';
    if(action==='append')nodes['#prompt'].value='original\n补一句';
    if(action==='switch'){state.chat={id:'other'};state.messages=[];nodes['#prompt'].value='other draft';context.viewRevision++;}
    accepted.resolve({user:{id:'user',role:'user',status:'complete',content:'original'},assistant:message('running',1)});
    await Promise.race([sending,new Promise((_,reject)=>setTimeout(()=>reject(Error('Send waited for metadata discovery')),300))]);
    assert.equal(nodes['#send'].disabled,false);assert.equal(consumed[0].key,'chat');assert.deepEqual(Array.from(consumed[0].ids),['sent-attachment']);
    // Switched away mid-send: the other composer is untouched, and the sent chat's saved draft no
    // longer holds the sent message, so it does not come back on return.
    if(action==='switch'){assert.equal(state.messages.length,0);assert.equal(nodes['#prompt'].value,'other draft');assert.equal(drafts.has('chat'),false);}
    else{assert.equal(state.messages[0].role,'user');assert.equal(state.messages[1].status,'complete');assert.equal(nodes['#prompt'].value,{none:'',edit:'new draft',append:'补一句'}[action]);}
    if(action==='none')assert.equal(drafts.has('chat'),false);if(action==='append')assert.equal(drafts.get('chat'),'补一句');
    metadata.resolve();
  }
});

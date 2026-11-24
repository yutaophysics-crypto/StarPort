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
import {LivePatch} from '../src/live-patch.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const registry=()=>({resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true}))});
async function loadLive(){const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/live.js',import.meta.url),'utf8'),context);return context.StarportLive;}
const plain=value=>JSON.parse(JSON.stringify(value));

test('a running reply is pushed whole once, then as its changes, and the page rebuilds it exactly',async()=>{
  const live=await loadLive(),store=new Store(':memory:'),packets=[],steps=[],next=deferred();
  // Each step emits a few events and waits, so pushes fall between steps.
  const fake=async({emit,setControl})=>{
    setControl({stop:()=>{}});
    for(const step of steps){step(emit);await new Promise(resolve=>setTimeout(resolve,150));}
    await next.promise;
  };
  const filler='x'.repeat(4000);
  steps.push(
    emit=>{for(let i=0;i<40;i++)emit({type:'tool',id:'tool-'+i,name:'read_file',status:'complete',input:{path:'f'+i},output:filler});},
    emit=>{emit({type:'activity',item:{id:'think',kind:'thinking',text:'Thinking',status:'running'}});emit({type:'delta',text:'Hello'});},
    emit=>{emit({type:'activity',item:{id:'think'},delta:' more'});emit({type:'delta',text:' world'});emit({type:'usage',usage:{input:5}});},
    // A record that arrives after its step goes in front of it.
    emit=>{emit({type:'activity',item:{id:'early',kind:'text',text:'Before tool 3'},before:'tool-3'});emit({type:'tool',id:'tool-2',status:'error',output:'failed'});},
    emit=>{emit({type:'replace',text:'Rewritten'});emit({type:'subagent',id:'child',name:'Child',status:'running',startedAt:1,updatedAt:1});emit({type:'notice',text:'Note'});},
    emit=>{emit({type:'activity',item:{id:'think',status:'complete'}});emit({type:'delta',text:'!'});}
  );
  const runner=new Runner(store,registry(),(type,data)=>{if(type==='message')packets.push({data:plain(data),reply:plain(runner.active.get(data.chatId)?.message||data.message||null)});},{codex:fake});
  try{
    const chat=store.newChat({provider:'codex',workspace:process.cwd()});await runner.start(chat.id,'start');const run=runner.active.get(chat.id);
    await new Promise(resolve=>setTimeout(resolve,steps.length*150+300));
    const own=packets.filter(packet=>packet.data.message?.id===run.message.id||packet.data.patch?.id===run.message.id);
    assert.ok(own[0].data.message,'the first push carries the whole reply');
    const patches=own.slice(1);
    assert.ok(patches.length>=4&&patches.every(packet=>packet.data.patch&&!packet.data.message),'later pushes carry only changes');
    const copies=[own[0].data.message];
    for(const {data,reply} of patches){
      const applied=live.applyPatch(copies.at(-1),data.patch);
      assert.ok(applied,'each push applies to the copy before it');
      assert.deepEqual(plain(applied),reply,'the page copy equals the reply after each push');
      copies.push(applied);
    }
    assert.ok(JSON.stringify(patches.at(-1).data.patch).length<20000,'a late push is small however long the reply is');
    // Rows a push did not name stay the same objects, so the page redraws only the rows named.
    const full=copies.findIndex(copy=>copy.details.tools.length===40);
    assert.ok(full>0&&full<copies.length-1);
    assert.equal(copies.at(-1).details.tools[5],copies[full].details.tools[5]);
    assert.notEqual(copies.at(-1).details.tools[2],copies[full].details.tools[2]);
    next.resolve();await run.done;
    const final=packets.at(-1).data;assert.equal(final.message.status,'complete','the end goes whole');assert.equal(final.message.content,'Rewritten!');
  }finally{next.resolve();await runner.close();store.close();}
});

test('a push the copy cannot take asks for the whole reply; an old one is ignored',async()=>{
  const live=await loadLive(),reply={id:'m',role:'assistant',status:'running',content:'ab',details:{liveRevision:3,activity:[{id:'a'}],tools:[]}};
  const patch={id:'m',base:4,revision:6,fields:{id:'m',role:'assistant',status:'running'},content:{at:2,text:'c'}};
  assert.equal(live.applyPatch(reply,patch),null,'the copy is older than the push starts from');
  assert.equal(live.applyPatch(reply,{...patch,base:1,revision:3}),reply,'the copy is already as new');
  assert.equal(live.applyPatch(reply,{...patch,base:3,content:{at:9,text:'c'}}),null,'text from beyond the copy');
  assert.equal(live.applyPatch(reply,{...patch,base:3,lists:{activity:{n:3,rows:[{id:'b'}]}}}),null,'rows the copy is missing');
  assert.equal(live.applyPatch({...reply,deferredTrace:true},{...patch,base:3}),null,'an outline cannot take a push');
  const taken=live.applyPatch(reply,{...patch,base:2,unset:['tools'],details:{liveRevision:6,usage:{n:1}},lists:{activity:{n:2,rows:[{id:'b'}],ids:['b','a']}}});
  assert.equal(taken.content,'abc');assert.deepEqual(taken.details.activity.map(row=>row.id),['b','a']);assert.equal(taken.details.activity[1],reply.details.activity[0]);
  assert.equal(Object.hasOwn(taken.details,'tools'),false);assert.equal(reply.content,'ab','the old copy is not changed');

  // The live sync reads the reply again, whole, after a push it could not apply.
  const reads=[],state={chat:{id:'chat'},messages:[reply],run:{id:'run'},active:['chat'],context:null},listeners=new Map();
  const events={addEventListener:(type,fn)=>listeners.set(type,fn),close:()=>{}},target={addEventListener:()=>{},removeEventListener:()=>{}};
  const sync=live.create({state,api:async path=>{reads.push(path);return {chatId:'chat',message:{...reply,content:'abcdef',details:{...reply.details,liveRevision:9}},run:{id:'run'},active:['chat']};},viewRevision:()=>0,events,document:target,window:target,setInterval:()=>1,clearInterval:()=>{}});
  listeners.get('message')({data:JSON.stringify({chatId:'chat',runId:'run',patch,run:{id:'run'}})});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(reads.length,1);assert.ok(!reads[0].includes('have='),'the whole reply is asked for');
  assert.equal(state.messages[0].content,'abcdef');
  await sync.reconcile();assert.match(reads[1],/have=m%3A9/,'later reads send the revision held');sync.close();
});

test('/api/live answers a page holding the running reply with nothing or its changes',async t=>{
  const finish=deferred(),started=deferred();
  const hub=createHub({port:0,dataDir:await mkdtemp(join(tmpdir(),'starport-live-patch-')),registry:registry(),implementations:{codex:async({emit,setControl})=>{
    setControl({stop:()=>finish.resolve()});emit({type:'tool',id:'tool',status:'running',output:'x'.repeat(5000)});emit({type:'delta',text:'one'});started.resolve();await finish.promise;
  }}});
  const port=await hub.listen(),base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token};t.after(async()=>{finish.resolve();await hub.close();});
  const chat=hub.store.newChat({provider:'codex',workspace:process.cwd()});await hub.runner.start(chat.id,'hello');await started.promise;
  const run=hub.runner.active.get(chat.id);await new Promise(resolve=>setTimeout(resolve,80));
  const read=have=>fetch(base+'/api/live?chatId='+chat.id+(have?'&have='+encodeURIComponent(have):''),{headers}).then(response=>response.json());
  const whole=await read();assert.equal(whole.message.content,'one');const revision=whole.message.details.liveRevision;
  const same=await read(run.message.id+':'+revision);assert.equal(Object.hasOwn(same,'message'),false);assert.equal(Object.hasOwn(same,'patch'),false);assert.ok(same.run);
  const base0=run.patch.base.revision;
  run.message.details.liveRevision++;run.message.content+=' two';
  const changed=await read(run.message.id+':'+base0);assert.equal(changed.message,undefined);assert.deepEqual(changed.patch.content,{at:3,text:' two'});
  assert.equal(changed.patch.lists,undefined,'unchanged rows are not sent');
  const stale=await read(run.message.id+':'+(base0-1));assert.equal(stale.message.content,'one two','a copy older than the last push gets the whole reply');
  const other=await read('other:'+revision);assert.ok(other.message);
  finish.resolve();await run.done;
});

test('row order changes and removed fields survive the diff',()=>{
  const message={id:'m',status:'running',content:'',details:{liveRevision:1,activity:[{id:'a'},{id:'b'}],tools:[],extra:1}},patch=new LivePatch(message);
  assert.equal(patch.next(),null,'nothing to diff before the first send');
  message.details.activity.splice(1,0,{id:'c'});delete message.details.extra;message.details.liveRevision=2;
  const diff=patch.next();assert.deepEqual(diff.lists.activity,{n:3,rows:[{id:'c'}],ids:['a','c','b']});assert.deepEqual(diff.unset,['extra']);
  message.details.liveRevision=3;assert.equal(patch.next().lists,undefined,'nothing changed in the rows');
});

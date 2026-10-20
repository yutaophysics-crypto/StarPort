import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationStore } from '../src/collaboration/store.mjs';

const publication={workspaces:[{id:'workspace-one',name:'工作目录'}],providers:[{id:'codex',name:'ChatGPT / Codex',available:true,models:[]},{id:'claude',name:'Claude Code',available:true,models:[]},{id:'antigravity',name:'Antigravity',available:true,models:[]},{id:'deepseek',name:'DeepSeek Harness',available:true,models:[]}]};

test('large shared replies page within the response budget and do not inflate the next model context',async()=>{
  const {store,a,room}=await setup();try{
    const first=store.insertMessage(a.user.id,room.id,'早期消息');
    for(let i=0;i<3;i++)store.insertMessage(a.user.id,room.id,'字'.repeat(1100000),{kind:'agent',provider:'codex'});
    const page=store.messagePage(a.user.id,room.id,{});assert.equal(page.messages.length,1);assert.equal(page.hasOlder,true);
    const older=store.messagePage(a.user.id,room.id,{before:page.messages[0].seq});assert.equal(older.messages.length,1);assert.ok(older.messages[0].seq<page.messages[0].seq);
    const forward=store.roomMessages(a.user.id,room.id,{after:store.getMessage(first).seq});assert.equal(forward.length,1);
    const deviceRow=device(store,a.user,'电脑');store.invoke(a.user.id,room.id,{content:'继续',clientId:'bounded',provider:'codex',workspaceId:'workspace-one'});
    const claimed=store.poll(store.device(deviceRow.token),{bootId:'bounded-boot',published:publication});assert.equal(claimed.job.history.length,1);assert.equal(claimed.job.history[0].content,'继续');assert.equal(claimed.job.omitted,4);
  }finally{store.close();}
});
async function setup(){let time=Date.now();const store=new CollaborationStore(':memory:',{clock:()=>time});const a=await store.register({username:'alice',name:'Alice',password:'test-password-alice'}),b=await store.register({username:'bob',name:'Bob',password:'test-password-bob'});const room=store.createRoom(a.user.id,{name:'群聊'}),invite=store.invite(a.user.id,room.id);store.join(b.user.id,{token:invite.token});return {store,a,b,room,advance:ms=>time+=ms};}
function device(store,user,name){const registration=store.registerDevice(user.id,{name}),d=store.device(registration.token);store.poll(d,{bootId:'boot-one',published:publication});store.bind(user.id,{deviceId:d.id});return {...d,token:registration.token};}
const invocation=(clientId='send-one',provider='codex')=>({content:'请帮我检查项目',clientId,provider,workspaceId:'workspace-one',options:{model:'chosen-model'}});

test('group membership, expiring invites and independent caller-owned computer bindings',async()=>{
  const {store,a,b,room,advance}=await setup();try{
    const outsider=await store.register({username:'outsider',password:'test-password-outsider'});
    assert.throws(()=>store.room(outsider.user.id,room.id),e=>e.status===403);
    assert.throws(()=>store.send(outsider.user.id,room.id,{content:'no',clientId:'no'}),e=>e.status===403);
    const da=device(store,a.user,'Alice电脑'),db=device(store,b.user,'Bob电脑');
    assert.throws(()=>store.bind(b.user.id,{deviceId:da.id}),e=>e.status===403);
    const ja=store.invoke(a.user.id,room.id,invocation()),jb=store.invoke(b.user.id,room.id,invocation('send-b','claude'));
    assert.equal(ja.deviceId,da.id);assert.equal(jb.deviceId,db.id);assert.equal(store.devices(b.user.id).length,1);
    const claimA=store.poll(da,{bootId:'boot-one',published:publication}).job;assert.equal(claimA.id,ja.id);
    assert.throws(()=>store.start(db,ja.id,{claimToken:claimA.claimToken}),e=>e.status===403);
    assert.equal(store.poll(db,{bootId:'boot-one',published:publication}).job.id,jb.id);
    assert.throws(()=>store.invite(b.user.id,room.id),e=>e.status===403);
    const invite=store.invite(a.user.id,room.id);advance(8*86400000);assert.throws(()=>store.join(outsider.user.id,{token:invite.token}),e=>e.status===404);
  }finally{store.close();}
});

test('credential hashes, session CSRF and published capabilities do not disclose raw login or device secrets',async()=>{
  const {store,a,b}=await setup();try{
    const da=device(store,a.user,'电脑');const stored=JSON.stringify({users:store.db.prepare('SELECT * FROM users').all(),sessions:store.db.prepare('SELECT * FROM sessions').all(),devices:store.db.prepare('SELECT * FROM devices').all()});
    for(const secret of ['test-password-alice',a.token,da.token])assert.ok(!stored.includes(secret));
    store.checkCsrf(store.session(a.token),a.csrf);assert.throws(()=>store.checkCsrf(store.session(a.token),b.csrf),e=>e.status===403);
    assert.ok(!JSON.stringify(store.state(store.session(a.token))).includes(da.token));
    const output=store.publication({...publication,password:'do-not-publish',providers:publication.providers.map(p=>({...p,apiKey:'do-not-publish'}))});assert.ok(!JSON.stringify(output).includes('do-not-publish'));
    store.logout(store.session(a.token));assert.throws(()=>store.session(a.token),e=>e.status===401);
  }finally{store.close();}
});

test('message and invocation retries are idempotent, while credentials and remote permission changes are rejected',async()=>{
  const {store,a,room}=await setup();try{
    device(store,a.user,'电脑');const message=store.send(a.user.id,room.id,{content:'hi',clientId:'ordinary'});
    assert.equal(store.send(a.user.id,room.id,{content:'hi',clientId:'ordinary'}).id,message.id);
    const job=store.invoke(a.user.id,room.id,invocation());assert.equal(store.invoke(a.user.id,room.id,invocation()).id,job.id);
    assert.throws(()=>store.invoke(a.user.id,room.id,{...invocation(),content:'different'}),e=>e.status===409);
    for(const options of [{apiKey:'secret'},{permissionMode:'full-access'},{command:'malicious.exe'},{cwd:'C:/'},{model:'--dangerously-skip-permissions'}])assert.throws(()=>store.invoke(a.user.id,room.id,{...invocation('changed'),options}),e=>e.status===400);
    assert.equal(store.roomMessages(a.user.id,room.id).length,3);
  }finally{store.close();}
});

test('completed delivery is sequenced and cannot be overwritten; private approvals can only be answered by the caller',async()=>{
  const {store,a,b,room}=await setup();try{
    const da=device(store,a.user,'电脑'),job=store.invoke(a.user.id,room.id,invocation()),claim=store.poll(da,{bootId:'boot-one',published:publication}).job;
    store.start(da,job.id,{claimToken:claim.claimToken});
    const first={claimToken:claim.claimToken,seq:1,status:'running',content:'Partial',progress:[{id:'t',name:'Bash',status:'pending',input:'private'}],approvals:[{id:'approval-one',kind:'permission',params:{command:'private command'}}]};
    store.update(da,job.id,first);assert.equal(store.job(a.user.id,job.id).approvals.length,1);assert.equal(store.job(b.user.id,job.id).approvals,undefined);assert.equal(store.job(b.user.id,job.id).progress[0].input,undefined);
    assert.throws(()=>store.action(b.user.id,job.id,{action:'approval',clientId:'answer',requestId:'approval-one',decision:'accept'}),e=>e.status===403);
    const action=store.action(a.user.id,job.id,{action:'approval',clientId:'answer',requestId:'approval-one',decision:'decline'});
    assert.equal(store.action(a.user.id,job.id,{action:'approval',clientId:'answer',requestId:'approval-one',decision:'decline'}).id,action.id);
    assert.equal(store.poll(da,{bootId:'boot-one',published:publication,claim:false}).controls[0].actions[0].decision,'decline');
    store.acknowledge(da,job.id,action.id,{});assert.equal(store.job(a.user.id,job.id).actions[0].status,'done');
    store.update(da,job.id,first);assert.throws(()=>store.update(da,job.id,{...first,content:'different'}),e=>e.status===409);
    const final={claimToken:claim.claimToken,seq:2,status:'complete',content:'Final'};store.update(da,job.id,final);store.update(da,job.id,final);
    assert.throws(()=>store.update(da,job.id,{...final,seq:3,status:'running'}),e=>e.status===409);
    assert.equal(store.getMessage(job.assistantId).content,'Final');
  }finally{store.close();}
});

test('offline computers queue work, and lease loss, worker restart, revocation or removal never replay uncertain execution',async()=>{
  for(const event of ['lease','restart','revoke','remove']){
    const {store,a,b,room,advance}=await setup();try{
      const d=device(store,b.user,'电脑'),job=store.invoke(b.user.id,room.id,invocation()),claim=store.poll(d,{bootId:'boot-one',published:publication}).job;store.start(d,job.id,{claimToken:claim.claimToken});
      if(event==='lease'){advance(121000);store.expire();assert.equal(store.job(b.user.id,job.id).status,'interrupted');}
      if(event==='restart'){store.poll(d,{bootId:'boot-two',published:publication});assert.equal(store.job(b.user.id,job.id).status,'interrupted');}
      if(event==='revoke'){store.revokeDevice(b.user.id,d.id);assert.throws(()=>store.device(d.token),e=>e.status===401);assert.equal(store.job(b.user.id,job.id).status,'interrupted');}
      if(event==='remove'){store.removeMember(a.user.id,room.id,b.user.id);assert.throws(()=>store.job(b.user.id,job.id),e=>e.status===403);assert.equal(store.job(a.user.id,job.id).status,'interrupted');assert.throws(()=>store.update(d,job.id,{claimToken:claim.claimToken,seq:1,status:'complete',content:'late'}),e=>e.status===409);assert.equal(store.poll(d,{bootId:'boot-one',published:publication}).controls.length,0);}
      if(event!=='remove'&&event!=='revoke')assert.equal(store.poll(d,{bootId:'boot-two',published:publication}).job,null);
    }finally{store.close();}
  }
});

test('queued stop and a stop received between claim and start do not launch a model task',async()=>{
  const {store,a,room}=await setup();try{
    const d=device(store,a.user,'电脑'),job=store.invoke(a.user.id,room.id,invocation());store.action(a.user.id,job.id,{clientId:'stop-one',action:'stop'});assert.equal(store.job(a.user.id,job.id).status,'canceled');assert.equal(store.job(a.user.id,job.id).actions[0].status,'done');
    const next=store.invoke(a.user.id,room.id,invocation('next')),claim=store.poll(d,{bootId:'boot-one',published:publication}).job;store.action(a.user.id,next.id,{clientId:'stop-two',action:'stop'});assert.throws(()=>store.start(d,next.id,{claimToken:claim.claimToken}),e=>e.status===409);
  }finally{store.close();}
});

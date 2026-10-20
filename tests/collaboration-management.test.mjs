import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CollaborationStore } from '../src/collaboration/store.mjs';
import { createCollaborationHub } from '../src/collaboration/server.mjs';

async function setup(file=':memory:') {
  const store=new CollaborationStore(file);
  const a=await store.register({username:'alice',password:'test-password-alice'});
  const b=await store.register({username:'bob',password:'test-password-bob'});
  const c=await store.register({username:'outsider',password:'test-password-outsider'});
  const room=store.createRoom(a.user.id,{name:'共同项目'});
  store.join(b.user.id,{token:store.invite(a.user.id,room.id).token});
  return {store,a,b,c,room};
}
const status=expected=>error=>error.status===expected;

test('only the owner edits or dissolves a group, and all members see validated metadata',async t=>{
  const {store,a,b,c,room}=await setup();t.after(()=>store.close());
  const members=store.room(a.user.id,room.id).members;
  for(const user of [b.user,c.user]) {
    assert.throws(()=>store.updateRoom(user.id,room.id,{name:'被改名'}),status(403));
    assert.throws(()=>store.dissolveRoom(user.id,room.id,{confirmName:room.name}),status(403));
    assert.throws(()=>store.restoreRoom(user.id,room.id),status(403));
  }
  for(const changes of [{name:''},{name:'字'.repeat(101)},{description:'字'.repeat(2001)},{description:null},{description:'bad\0text'},{ownerId:b.user.id},{dissolved:true},[],{}])
    assert.throws(()=>store.updateRoom(a.user.id,room.id,changes),status(400));
  const changed=store.updateRoom(a.user.id,room.id,{name:' 新项目 ',description:' 项目简介\n下一步 '});
  assert.equal(changed.name,'新项目');assert.equal(changed.description,'项目简介\n下一步');
  assert.equal(store.room(b.user.id,room.id).name,'新项目');
  assert.equal(store.state(store.session(b.token)).rooms[0].description,changed.description);
  assert.equal(store.state(store.session(c.token)).rooms.length,0);
  assert.deepEqual(changed.members,members);
});

test('dissolution preserves history, cancels queued work, stops running work, and restores with a fresh invite',async t=>{
  const {store,a,b,c,room}=await setup();t.after(()=>store.close());
  const registration=store.registerDevice(a.user.id,{name:'测试电脑'}),device=store.device(registration.token);
  const publication={workspaces:[{id:'workspace',name:'测试目录'}],providers:[{id:'codex',name:'Codex',available:true,models:[]}]};
  store.poll(device,{bootId:'boot',published:publication});store.bind(a.user.id,{deviceId:device.id});
  const options={content:'测试调用',provider:'codex',workspaceId:'workspace'};
  const running=store.invoke(a.user.id,room.id,{...options,clientId:'running'});
  const queued=store.invoke(a.user.id,room.id,{...options,clientId:'queued'});
  const claim=store.poll(device,{bootId:'boot',published:publication}).job;store.start(device,claim.id,{claimToken:claim.claimToken});
  store.update(device,running.id,{claimToken:claim.claimToken,seq:1,status:'running',content:'保留的部分回复',approvals:[{id:'approval',kind:'permission'}]});
  store.action(a.user.id,running.id,{clientId:'pending',action:'approval',requestId:'approval',decision:'accept'});
  const policy=store.invitePolicy(a.user.id,room.id,{intervalHours:null}),before=store.roomMessages(a.user.id,room.id);
  assert.throws(()=>store.dissolveRoom(a.user.id,room.id,{confirmName:'错误名称'}),status(400));
  const dissolved=store.dissolveRoom(a.user.id,room.id,{confirmName:room.name});assert.equal(dissolved.dissolved,true);
  assert.equal(dissolved.members.length,2);assert.equal(store.roomMessages(b.user.id,room.id).length,before.length);
  assert.equal(store.getMessage(running.assistantId).content,'保留的部分回复');
  assert.equal(store.job(a.user.id,running.id).status,'interrupted');assert.equal(store.job(a.user.id,queued.id).status,'canceled');
  assert.equal(store.job(a.user.id,running.id).actions[0].status,'error');assert.deepEqual(store.job(a.user.id,running.id).approvals,[]);
  assert.throws(()=>store.update(device,running.id,{claimToken:claim.claimToken,seq:2,status:'complete',content:'晚到结果'}),status(409));
  assert.throws(()=>store.send(b.user.id,room.id,{content:'不应发送',clientId:'blocked'}),status(409));
  assert.throws(()=>store.invoke(a.user.id,room.id,{...options,clientId:'blocked-agent'}),status(409));
  assert.throws(()=>store.invitePolicy(a.user.id,room.id,{enabled:true}),status(409));
  assert.throws(()=>store.updateRoom(a.user.id,room.id,{name:'已解散群修改'}),status(409));
  store.expire();assert.equal(store.invitePolicy(a.user.id,room.id).token,null);
  assert.throws(()=>store.join(c.user.id,{token:policy.token}),status(404));
  const restored=store.restoreRoom(a.user.id,room.id);assert.equal(restored.dissolved,false);assert.deepEqual(restored.members,dissolved.members);
  const fresh=store.invitePolicy(a.user.id,room.id);assert.equal(fresh.intervalHours,null);assert.notEqual(fresh.token,policy.token);
  assert.throws(()=>store.join(c.user.id,{token:policy.token}),status(404));store.join(c.user.id,{token:fresh.token});
  assert.equal(store.poll(device,{bootId:'boot',published:publication}).job,null);
  assert.equal(store.send(b.user.id,room.id,{content:'恢复后继续',clientId:'restored'}).content,'恢复后继续');
  store.invitePolicy(a.user.id,room.id,{enabled:false});store.dissolveRoom(a.user.id,room.id,{confirmName:room.name});store.restoreRoom(a.user.id,room.id);
  assert.equal(store.invitePolicy(a.user.id,room.id).enabled,false);
});

test('legacy groups gain settings without losing members, and saved settings survive restart',async()=>{
  const file=join(await mkdtemp(join(tmpdir(),'starport-room-management-')),'groups.sqlite');
  const {store,a,b,room}=await setup(file);store.send(b.user.id,room.id,{content:'旧记录',clientId:'legacy'});store.close();
  const legacy=new DatabaseSync(file);legacy.exec('DROP TABLE room_settings');legacy.close();
  const migrated=new CollaborationStore(file);
  try{assert.equal(migrated.room(a.user.id,room.id).description,'');assert.equal(migrated.room(a.user.id,room.id).dissolved,false);
    migrated.updateRoom(a.user.id,room.id,{description:'迁移后简介'});migrated.dissolveRoom(a.user.id,room.id,{confirmName:room.name});
  }finally{migrated.close();}
  const restarted=new CollaborationStore(file);
  try{const retained=restarted.room(b.user.id,room.id);assert.equal(retained.description,'迁移后简介');assert.equal(retained.dissolved,true);assert.equal(retained.members.length,2);
    assert.equal(restarted.roomMessages(b.user.id,room.id)[0].content,'旧记录');assert.equal(restarted.invitePolicy(a.user.id,room.id).token,null);
    restarted.restoreRoom(a.user.id,room.id);assert.equal(restarted.room(b.user.id,room.id).dissolved,false);
  }finally{restarted.close();}
});

test('management HTTP routes enforce membership, CSRF, confirmation and owner-only restore',async t=>{
  const hub=createCollaborationHub({port:0,dataDir:await mkdtemp(join(tmpdir(),'starport-room-api-'))});await hub.listen();t.after(()=>hub.close());
  const base=hub.origin();
  async function client(username){const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password:'test-password-'+username})});const auth=await response.json(),cookie=response.headers.getSetCookie()[0].split(';')[0];
    return async(path,method='GET',body,headers={})=>fetch(base+'/api'+path,{method,headers:{Origin:base,Cookie:cookie,'X-Starport-CSRF':auth.csrf,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});}
  const alice=await client('alice'),bob=await client('bob'),room=await (await alice('/rooms','POST',{name:'HTTP群聊'})).json(),path='/rooms/'+room.id;
  const invite=await (await alice(path+'/invites','GET')).json();await bob('/rooms/join','POST',{token:invite.token});
  assert.equal((await bob(path,'PUT',{name:'拒绝修改'})).status,403);
  assert.equal((await alice(path,'PUT',{name:'拒绝请求'},{'X-Starport-CSRF':'wrong'})).status,403);
  assert.equal((await alice(path,'PUT',{name:'新群名',description:'已保存简介'})).status,200);
  assert.equal((await (await bob(path)).json()).description,'已保存简介');
  assert.equal((await alice(path,'DELETE',{confirmName:'HTTP群聊'})).status,400);
  assert.equal((await bob(path,'DELETE',{confirmName:'新群名'})).status,403);
  assert.equal((await alice(path,'DELETE',{confirmName:'新群名'})).status,200);
  assert.equal((await bob(path+'/messages','POST',{content:'被禁止',clientId:'blocked'})).status,409);
  assert.equal((await bob(path+'/restore','POST',{})).status,403);
  assert.equal((await alice(path+'/restore','POST',{})).status,200);
  assert.equal((await (await bob('/state')).json()).rooms[0].dissolved,false);
});

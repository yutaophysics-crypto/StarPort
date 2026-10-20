import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountHub } from '../src/accounts/server.mjs';
import { createCollaborationHub } from '../src/collaboration/server.mjs';
import { DesktopAccount,serviceRequest } from '../src/accounts/desktop.mjs';
import { DesktopLink } from '../src/collaboration/desktop.mjs';
import { AccountStore } from '../src/accounts/store.mjs';

const temp=()=>mkdtemp(join(tmpdir(),'starport-last-group-'));
async function setup(t){const center=createAccountHub({port:0,dataDir:await temp()});await center.listen();const groups=[];for(let i=0;i<2;i++){const group=createCollaborationHub({port:0,dataDir:await temp(),accountCenter:center.origin()});await group.listen();groups.push(group);}t.after(async()=>{for(const g of groups)await g.close();await center.close();});
  await serviceRequest(center.origin(),'/api/register',{method:'POST',native:true,body:{username:'alice',password:'fixture-password-alice'}});
  async function computer(username='alice'){const data=await temp(),desktop=new DesktopAccount({issuer:center.origin(),dataDir:data,desktopLink:new DesktopLink({registry:{},dataDir:data})});await desktop.login({username,password:'fixture-password-'+username});return desktop;}
  return {center,groups,computer};}
async function windowSession(desktop,g,roomId){const launch=await desktop.window({server:g.origin(),roomId}),login=await serviceRequest(g.origin(),'/api/auth/window',{method:'POST',body:{token:launch.launchCode}});return {cookie:login.response.headers.getSetCookie()[0].split(';')[0],csrf:login.data.csrf};}

test('the same account remembers its last viewed room across servers and a fresh computer login',async t=>{
  const {center,groups,computer}=await setup(t),first=await computer(),rooms=[];
  for(const group of groups)rooms.push((await first.create({server:group.origin(),name:'Across servers'})).room);
  const a=await windowSession(first,groups[0],rooms[0].id);
  assert.equal((await serviceRequest(groups[0].origin(),'/api/rooms/'+rooms[0].id+'/select',{method:'POST',...a,body:{}})).data.synced,true);
  const next=await computer();assert.equal((await next.lastGroup()).lastGroup.roomId,rooms[0].id);
  const b=await windowSession(next,groups[1],rooms[1].id);
  assert.equal((await serviceRequest(groups[1].origin(),'/api/rooms/'+rooms[1].id+'/select',{method:'POST',...b,body:{}})).data.synced,true);
  const last=(await first.lastGroup()).lastGroup;assert.equal(last.server,groups[1].origin());assert.equal(last.roomId,rooms[1].id);
  const third=await computer();assert.deepEqual((await third.lastGroup()).lastGroup,last);
  assert.equal((await third.groups()).find(s=>s.server===last.server).rooms[0].id,last.roomId);
  const scope=center.store.db.prepare('SELECT token_hash FROM group_selection_tokens').get();assert.ok(scope.token_hash);const visible=await serviceRequest(groups[1].origin(),'/api/state',{...b});assert.ok(!JSON.stringify(visible.data).includes(groups[1].store.selectionToken(groups[1].store.session(b.cookie.split('=')[1]))));
});

test('last-room writing is scoped to an account and server, cannot log in or read accounts, and ends at parent logout',async t=>{
  const {center,groups,computer}=await setup(t),alice=await computer(),room=(await alice.create({server:groups[0].origin(),name:'Scoped record'})).room;
  const {data}=await alice.account('selection-token','POST',{server:groups[0].origin()}),scope=data.selectionToken,origin=center.origin(),input={userId:alice.profile.user.id,server:groups[0].origin(),roomId:room.id};
  await assert.rejects(serviceRequest(origin,'/api/session',{native:true,token:scope}),e=>e.status===401);
  await assert.rejects(serviceRequest(origin,'/api/last-group',{native:true,token:scope}),e=>e.status===401);
  await assert.rejects(serviceRequest(origin,'/api/grant',{native:true,token:scope,method:'POST',body:{audience:groups[0].origin(),nonce:'x'.repeat(43)}}),e=>e.status===401);
  await assert.rejects(serviceRequest(origin,'/api/last-group',{token:alice.profile.token,method:'PUT',body:input}),e=>e.status===401);
  await assert.rejects(serviceRequest(origin,'/api/last-group',{token:scope,method:'PUT',body:{...input,server:groups[1].origin()}}),e=>e.status===403);
  const bob=(await serviceRequest(origin,'/api/register',{native:true,method:'POST',body:{username:'bob',password:'fixture-password-bob'}})).data;
  await assert.rejects(serviceRequest(origin,'/api/last-group',{token:scope,method:'PUT',body:{...input,userId:bob.user.id}}),e=>e.status===403);
  assert.equal((await serviceRequest(origin,'/api/last-group',{token:scope,method:'PUT',body:input})).data.ok,true);
  assert.equal(center.store.lastGroup(bob.user.id),null);
  const guest=await computer('bob');await guest.group(groups[0].origin(),'/auth/session');
  await assert.rejects(guest.group(groups[0].origin(),'/rooms/'+room.id+'/select','POST',{}),e=>e.status===403);
  const headers={Origin:'https://evil.example',Authorization:'Bearer '+scope,'Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/api/last-group',{method:'PUT',headers,body:JSON.stringify(input)})).status,403);
  await alice.account('logout','POST',{});
  await assert.rejects(serviceRequest(origin,'/api/last-group',{token:scope,method:'PUT',body:input}),e=>e.status===401);
});

test('account-wide last room persists through restart and writer grants expire with their login session',async()=>{
  let now=Date.now();const file=join(await temp(),'accounts.sqlite');let store=new AccountStore(file,{clock:()=>now});
  const identity=await store.register({username:'persistent',password:'fixture-password-persistent'}),user=store.session(identity.token),server='https://groups.example',roomId='11111111-1111-4111-8111-111111111111';store.db.prepare('INSERT INTO servers VALUES(?,?,?)').run(user.id,server,now);
  const token=store.selectionToken(user,server);store.selectGroup(token,{userId:user.id,server,roomId});store.close();store=new AccountStore(file,{clock:()=>now});
  try{assert.equal(store.lastGroup(user.id).roomId,roomId);now+=30*86400000;assert.throws(()=>store.selectGroup(token,{userId:user.id,server,roomId}),e=>e.status===401);store.expire();assert.equal(store.db.prepare('SELECT count(*) AS n FROM group_selection_tokens').get().n,0);assert.equal(store.lastGroup(user.id).server,server);}finally{store.close();}
});

test('opening another window for the same account preserves the first window session and sending permissions',async t=>{
  const {groups,computer}=await setup(t),desktop=await computer(),group=groups[0],room=(await desktop.create({server:group.origin(),name:'Multiple windows'})).room;
  const first=await windowSession(desktop,group,room.id),next=await desktop.window({server:group.origin(),roomId:room.id});
  const reopened=await serviceRequest(group.origin(),'/api/auth/window',{method:'POST',cookie:first.cookie,body:{token:next.launchCode}});
  assert.equal(reopened.response.headers.getSetCookie()[0].split(';')[0],first.cookie);assert.equal(reopened.data.csrf,first.csrf);
  assert.equal((await serviceRequest(group.origin(),'/api/rooms/'+room.id+'/messages',{method:'POST',...first,body:{content:'First window still works',clientId:'window-one'}})).data.content,'First window still works');
  assert.equal((await serviceRequest(group.origin(),'/api/state',{...first})).data.csrf,first.csrf);
  await assert.rejects(serviceRequest(group.origin(),'/api/auth/window',{method:'POST',cookie:first.cookie,body:{token:next.launchCode}}),e=>e.status===401);
});

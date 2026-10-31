import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { createHub } from '../src/server.mjs';

const fakeRegistry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),record:()=>{},list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'测试'}))};
const at=(s,table,id,column,value)=>s.db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value,id);

test('rooms keep the order they are dragged into; new rooms join at the end',()=>{
  const s=new Store(':memory:'),names=()=>s.list().groups.map(g=>g.name);
  const [a,b,c]=['A','B','C'].map((name,i)=>{const g=s.group(name);at(s,'groups',g.id,'created',`2026-01-0${i+1}T00:00:00.000Z`);return g;});
  assert.deepEqual(names(),['A','B','C']);
  s.moveGroup(c.id,a.id);assert.deepEqual(names(),['C','A','B']);
  s.moveGroup(c.id,null);assert.deepEqual(names(),['A','B','C']);
  s.moveGroup(a.id,c.id);assert.deepEqual(names(),['B','A','C']);
  s.group('D');assert.deepEqual(names(),['B','A','C','D']);
  assert.throws(()=>s.moveGroup(b.id,'gone'),e=>e.status===409);
  assert.throws(()=>s.moveGroup('gone',null),e=>e.status===404);
  assert.throws(()=>s.moveGroup(b.id,7),/目标位置无效/);
  assert.deepEqual(names(),['B','A','C','D']);s.close();
});

test('a room lists by activity until rearranged, then keeps its order and takes new and moved-in chats at the top',()=>{
  const s=new Store(':memory:'),room=s.group('R'),other=s.group('O');
  const make=(title,group,day)=>{const c=s.newChat({group_id:group.id,title});at(s,'chats',c.id,'updated',`2026-01-${day}T00:00:00.000Z`);return c;};
  const one=make('one',room,'01'),two=make('two',room,'02'),three=make('three',room,'03'),elsewhere=make('elsewhere',other,'04');
  const titles=group=>s.roomChatIds(group.id).map(id=>s.chat(id).title);
  assert.deepEqual(titles(room),['three','two','one']);
  s.moveChat(three.id,null);assert.deepEqual(titles(room),['two','one','three']);
  at(s,'chats',three.id,'updated','2026-02-01T00:00:00.000Z');s.message(one.id,'user','codex','new activity');
  assert.deepEqual(titles(room),['two','one','three'],'activity no longer reorders a rearranged room');
  s.newChat({group_id:room.id,title:'four'});assert.deepEqual(titles(room),['four','two','one','three']);
  s.updateChat(elsewhere.id,{group_id:room.id});assert.deepEqual(titles(room),['elsewhere','four','two','one','three']);
  // A room never rearranged keeps sorting by activity; a chat moved into it is unplaced there.
  s.updateChat(two.id,{group_id:other.id});assert.equal(s.chat(two.id).sort_order,null);
  assert.deepEqual(s.list().chats.filter(c=>c.group_id===room.id).map(c=>c.sort_order).sort((x,y)=>x-y),[-2,-1,1,2],'the sidebar receives the saved places');
  assert.throws(()=>s.moveChat(one.id,two.id),e=>e.status===409,'a conversation cannot be dropped into another room');
  assert.throws(()=>s.moveChat('gone',null),e=>e.status===404);
  assert.deepEqual(titles(room),['elsewhere','four','one','three']);s.close();
});

test('conversations without a room can be rearranged too',()=>{
  const s=new Store(':memory:'),a=s.newChat({title:'a'}),b=s.newChat({title:'b'});
  at(s,'chats',a.id,'updated','2026-01-01T00:00:00.000Z');at(s,'chats',b.id,'updated','2026-01-02T00:00:00.000Z');
  assert.deepEqual(s.roomChatIds(null),[b.id,a.id]);
  s.moveChat(a.id,b.id);assert.deepEqual(s.roomChatIds(null),[a.id,b.id]);s.close();
});

test('databases from older builds gain the chat order column; the rooms table keeps its old shape',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'hub-order-')),'db.sqlite');let s=new Store(file);
  const room=s.group('old room'),chat=s.newChat({group_id:room.id,title:'old chat'});
  s.db.exec('ALTER TABLE chats DROP COLUMN sort_order;');s.close();
  s=new Store(file);
  assert.equal(s.chat(chat.id).sort_order,null);
  const next=s.group('new room');s.moveGroup(next.id,room.id);
  assert.deepEqual(s.list().groups.map(g=>g.name),['new room','old room']);
  // An older build inserts rooms positionally; that must keep working after this one ran.
  assert.doesNotThrow(()=>s.db.prepare('INSERT INTO groups VALUES(?,?,?)').run('legacy-id','legacy',new Date().toISOString()));
  assert.deepEqual(s.list().groups.map(g=>g.name),['new room','old room','legacy']);s.close();
});

test('HTTP moves rooms and conversations and tells every window to redraw the list only',async t=>{
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'hub-order-http-')),registry:fakeRegistry});const port=await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token};
  const post=(path,data)=>fetch(base+'/api'+path,{method:'POST',headers,body:JSON.stringify(data)});
  const first=hub.store.group('first'),second=hub.store.group('second');
  const a=hub.store.newChat({group_id:first.id,title:'a'}),b=hub.store.newChat({group_id:first.id,title:'b'});
  const events=await fetch(base+'/api/events',{headers}),reader=events.body.getReader(),seen=[];
  t.after(()=>reader.cancel().catch(()=>{}));
  const refreshes=async()=>{for(let i=0;i<20&&!seen.some(chunk=>/event: refresh/.test(chunk));i++){const {value,done}=await reader.read();if(done)break;seen.push(new TextDecoder().decode(value));}return seen.join('');};
  assert.equal((await post('/groups/'+second.id+'/move',{before:first.id})).status,200);
  assert.match(await refreshes(),/event: refresh\ndata: \{"order":true\}/);
  assert.equal((await post('/chats/'+a.id+'/move',{before:b.id})).status,200);
  const state=await(await fetch(base+'/api/state',{headers})).json();
  assert.deepEqual(state.groups.map(g=>g.name),['second','first']);
  assert.deepEqual(hub.store.roomChatIds(first.id),[a.id,b.id]);
  assert.equal((await post('/chats/'+a.id+'/move',{before:'not-in-room'})).status,409);
  assert.equal((await post('/chats/missing/move',{before:null})).status,404);
  assert.equal((await fetch(base+'/api/groups/'+first.id+'/move',{method:'DELETE',headers})).status,404);
  assert.ok(hub.store.list().groups.some(g=>g.id===first.id),'only the delete route removes a room');
});

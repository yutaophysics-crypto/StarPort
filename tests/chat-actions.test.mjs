import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/storage.mjs';
import {createHub} from '../src/server.mjs';

test('deleting a chat cascades its messages, native cursor and import link only',()=>{
  const store=new Store(':memory:'),workspace=mkdtempSync(join(tmpdir(),'starport-delete-'));
  try{
    writeFileSync(join(workspace,'keep.txt'),'workspace data');
    const g=store.group('Keep group'),one=store.newChat({group_id:g.id,workspace}),two=store.newChat({group_id:g.id,workspace});
    store.message(one.id,'user','codex','delete this');store.message(two.id,'user','codex','keep this');
    store.saveSession(one.id,'codex','native-original',null,'runtime');store.saveSession(two.id,'codex','native-sibling',null,'runtime');
    store.db.prepare('INSERT INTO history_imports VALUES(?,?,?,?)').run('codex','source-id',one.id,new Date().toISOString());
    store.deleteChat(one.id);
    assert.equal(store.chat(one.id),null);assert.deepEqual(store.messages(one.id),[]);assert.equal(store.session(one.id,'codex'),undefined);
    assert.equal(store.historyImport('codex','source-id'),undefined);assert.equal(store.messages(two.id)[0].content,'keep this');
    assert.equal(store.session(two.id,'codex').native_id,'native-sibling');assert.equal(store.list().groups[0].id,g.id);
    assert.equal(readFileSync(join(workspace,'keep.txt'),'utf8'),'workspace data');
    assert.equal(store.export().chats.length,1);assert.equal(store.export().messages.length,1);assert.throws(()=>store.deleteChat(one.id),/不存在/);
  }finally{store.close();}
});

test('moving validates the group and preserves workspace, settings and history',()=>{
  const store=new Store(':memory:');try{
    const group=store.group('Target'),options={codex:{model:'saved-model',permissionMode:'ask'}},chat=store.newChat({workspace:process.cwd(),options});
    store.message(chat.id,'user','codex','original');store.saveSession(chat.id,'codex','native-original',null,'runtime');
    const messages=store.messages(chat.id);
    for(const invalid of ['missing',42,{},false])assert.throws(()=>store.updateChat(chat.id,{group_id:invalid}),/分组/);
    assert.equal(store.chat(chat.id).group_id,null);
    const moved=store.updateChat(chat.id,{group_id:group.id});assert.equal(moved.group_id,group.id);assert.equal(moved.workspace,chat.workspace);
    assert.deepEqual(moved.options,options);assert.equal(moved.provider,chat.provider);assert.deepEqual(store.messages(chat.id),messages);
    assert.equal(store.session(chat.id,'codex').native_id,'native-original');assert.equal(store.updateChat(chat.id,{group_id:null}).group_id,null);
  }finally{store.close();}
});

test('HTTP deletion is authenticated, blocks running work, and moving can organize running chats',async t=>{
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),list:async()=>[],record:()=>{}};
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-actions-')),registry,implementations:{codex:async({setControl})=>{await new Promise(resolve=>setControl({stop:resolve}));}}});
  const port=await hub.listen();t.after(()=>hub.close());const base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  const group=hub.store.group('While running'),chat=hub.store.newChat({workspace:process.cwd()});
  const url=base+'/api/chats/'+chat.id;
  assert.equal((await fetch(url,{method:'DELETE'})).status,401);
  assert.equal((await fetch(url,{method:'DELETE',headers:{...headers,Origin:'https://evil.example'}})).status,403);
  await hub.runner.start(chat.id,'Wait');
  assert.equal((await fetch(url,{method:'DELETE',headers})).status,409);assert.ok(hub.store.chat(chat.id));
  const move=await fetch(url,{method:'PATCH',headers,body:JSON.stringify({group_id:group.id})});assert.equal(move.status,200);
  assert.equal((await move.json()).group_id,group.id);assert.equal(hub.runner.active.has(chat.id),true);
  assert.equal((await fetch(url,{method:'PATCH',headers,body:JSON.stringify({group_id:group.id,workspace:'elsewhere'})})).status,409);
  assert.equal((await fetch(url,{method:'PATCH',headers,body:'{"group_id":"missing"}'})).status,400);
  await hub.runner.stop(chat.id);assert.equal((await fetch(url,{method:'DELETE',headers})).status,200);
  assert.equal((await fetch(url,{headers})).status,404);assert.equal((await fetch(url,{method:'DELETE',headers})).status,404);
});

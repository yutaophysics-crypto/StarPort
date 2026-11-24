import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage.mjs';
import { createHub } from '../src/server.mjs';

test('a room keeps a default working folder in settings, listed with it and dropped with it',()=>{
  const store=new Store(':memory:');
  try{
    const room=store.group('对偶'),other=store.group('其他');
    assert.equal(store.rooms().find(g=>g.id===room.id).workspace,null);
    store.setRoomWorkspace(room.id,'D:\\Research\\duality');
    assert.equal(store.list().groups.find(g=>g.id===room.id).workspace,'D:\\Research\\duality');
    assert.equal(store.list().groups.find(g=>g.id===other.id).workspace,null);
    // The groups table keeps its three columns; older builds insert rooms by position.
    assert.deepEqual(store.db.prepare('PRAGMA table_info(groups)').all().map(row=>row.name),['id','name','created']);
    store.setRoomWorkspace(room.id,null);assert.equal(store.rooms().find(g=>g.id===room.id).workspace,null);
    assert.throws(()=>store.setRoomWorkspace('missing','D:\\x'),e=>e.status===404);
    store.setRoomWorkspace(other.id,'D:\\Other');store.deleteGroup(other.id);
    assert.deepEqual(store.roomWorkspaces(),{});
  }finally{store.close();}
});

test('HTTP sets, checks and clears a room default working folder',{timeout:15000},async t=>{
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),list:async()=>[],record:()=>{}};
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-room-workspace-')),registry});
  const port=await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+port+'/api',headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  const room=hub.store.group('对偶'),folder=mkdtempSync(join(tmpdir(),'starport-room-default-'));
  const put=(workspace,auth=headers)=>fetch(base+'/groups/'+room.id+'/workspace',{method:'PUT',headers:auth,body:JSON.stringify({workspace})});
  assert.equal((await put(folder,{'Content-Type':'application/json'})).status,401);
  const set=await put(folder);assert.equal(set.status,200);assert.equal((await set.json()).workspace,folder);
  const state=await (await fetch(base+'/state',{headers})).json();
  assert.equal(state.groups.find(g=>g.id===room.id).workspace,folder);
  assert.equal((await put(join(folder,'missing'))).status,400);
  assert.equal((await put('relative\\path')).status,400);
  assert.equal(hub.store.rooms().find(g=>g.id===room.id).workspace,folder,'a refused folder leaves the default as it was');
  assert.equal((await put(null)).status,200);assert.equal(hub.store.rooms().find(g=>g.id===room.id).workspace,null);
  assert.equal((await fetch(base+'/groups/missing/workspace',{method:'PUT',headers,body:JSON.stringify({workspace:folder})})).status,404);
});

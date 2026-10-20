import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rename,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage.mjs';
import {MemorySync} from '../src/memory-sync.mjs';
import {createHub} from '../src/server.mjs';

const input={kind:'preference',title:'交流方式',content:'请简洁地使用中文交流。'};

test('deleting an empty project and its memories propagates without resurrection or global changes',async()=>{
  const d=await devices();
  try{
    const project=d.a.addProject('Old project','/old-project'),global=d.a.memory.create(input,{confirmed:true});
    const scoped=d.a.memory.create({kind:'knowledge',title:'Scoped note',content:'Project-specific background.',project_id:project.id},{confirmed:true});
    d.a.instructions.update(project.id,{revision:0,content:'Project requirements'});
    await d.pair();await d.settle();assert.ok(d.b.project(project.id));assert.ok(d.b.memory.get(scoped.id));
    d.a.memory.remove(scoped.id,scoped.revision);d.a.db.prepare('DELETE FROM context_instructions WHERE scope=?').run('project:'+project.id);d.a.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    await d.settle();await d.settle();
    for(const store of [d.a,d.b]){
      assert.equal(store.project(project.id),undefined);assert.throws(()=>store.memory.get(scoped.id));
      assert.equal(store.memory.get(global.id).content,input.content);assert.equal(store.db.prepare('SELECT * FROM context_instructions WHERE scope=?').get('project:'+project.id),undefined);
      assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    }
    for(const sync of [d.x,d.y]){assert.equal(sync.status().error,'');assert.equal(sync.status().conflicts.length,0);assert.equal(sync.heads('project:'+project.id)[0].value,null);}
  }finally{await d.close();}
});

test('project tombstone preserves a different device conversation and waits for explicit reassignment',async()=>{
  const d=await devices();
  try{
    const project=d.a.addProject('Old project','/old-project');await d.pair();await d.settle();
    const chat=d.b.newChat({title:'Keep conversation',project_id:project.id});d.b.message(chat.id,'user','codex','Keep my data');
    d.a.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);await d.settle();
    assert.equal(d.a.project(project.id),undefined);assert.ok(d.b.project(project.id));assert.equal(d.b.messages(chat.id)[0].content,'Keep my data');
    assert.ok(d.y.status().conflicts.some(row=>row.key==='project:'+project.id));
    d.b.updateChat(chat.id,{project_id:null});await d.settle();
    assert.equal(d.b.project(project.id),undefined);assert.equal(d.b.messages(chat.id)[0].content,'Keep my data');assert.equal(d.y.status().conflicts.length,0);
  }finally{await d.close();}
});

test('project deletion never cascades into a separately-created remote memory',async()=>{
  const d=await devices();
  try{
    const project=d.a.addProject('Old project','/old-project');await d.pair();await d.settle();
    const extra=d.b.memory.create({kind:'knowledge',title:'New remote note',content:'Needs independent review.',project_id:project.id});
    d.a.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);await d.y.sync();await d.x.sync();await d.y.sync();
    assert.ok(d.b.project(project.id));assert.equal(d.b.memory.get(extra.id).content,'Needs independent review.');
    assert.ok(d.y.status().conflicts.some(row=>row.key==='project:'+project.id));
    d.b.memory.remove(extra.id,extra.revision);await d.settle();assert.equal(d.b.project(project.id),undefined);assert.equal(d.a.project(project.id),undefined);
  }finally{await d.close();}
});
async function devices(){
  const folder=await mkdtemp(join(tmpdir(),'starport-sync-'));
  const a=new Store(':memory:'),b=new Store(':memory:');const x=new MemorySync(a),y=new MemorySync(b);x.name='A';y.name='B';
  return {folder,a,b,x,y,async pair(){await x.configure({enabled:true,folder});await y.configure({enabled:true,folder});},
    async settle(){for(let i=0;i<3;i++){await x.sync();await y.sync();}},async close(){await x.close();await y.close();a.close();b.close();await rm(folder,{recursive:true,force:true});}};
}

test('sync is off by default; shares confirmed memories, candidates and saved preferences without chats, folders or credentials',async()=>{
  const d=await devices();try{
    assert.equal(d.x.config().enabled,false);assert.deepEqual(await readdir(d.folder),[]);
    const project=d.a.addProject('研究','C:\\private-work');const chat=d.a.newChat({title:'private chat',project_id:project.id});
    d.a.message(chat.id,'user','claude','do not sync this chat');d.a.setSetting('credential','do not sync credentials');
    const confirmed=d.a.memory.create(input,{confirmed:true}),candidate=d.a.memory.create({...input,content:'项目候选',project_id:project.id});
    d.a.instructions.update(null,{revision:0,content:'使用简短段落。'});d.a.instructions.update(project.id,{revision:0,content:'保留项目符号。'});
    await d.pair();await d.settle();assert.equal(d.b.memory.get(confirmed.id).status,'confirmed');assert.equal(d.b.memory.get(candidate.id).status,'candidate');
    assert.equal(d.b.memory.recall('研究',{projectId:project.id}).items.some(row=>row.id===candidate.id),false);
    assert.equal(d.b.instructions.get().content,'使用简短段落。');assert.equal(d.b.instructions.get(project.id).content,'保留项目符号。');
    assert.equal(d.b.project(project.id).workspace,'');assert.deepEqual(d.b.list().chats,[]);assert.equal(d.b.setting('credential'),null);
    const files=await readdir(join(d.folder,'StarportMemory','changes'));const bytes=(await Promise.all(files.map(file=>readFile(join(d.folder,'StarportMemory','changes',file),'utf8')))).join('');
    assert.ok(!bytes.includes('private-work')&&!bytes.includes('do not sync'));assert.deepEqual(d.b.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await d.close();}
});

test('candidate approval, edit and deletion propagate; an offline stale device never resurrects deleted memory',async()=>{
  const d=await devices();try{
    const row=d.a.memory.create(input);await d.pair();const approved=d.b.memory.update(row.id,{revision:d.b.memory.get(row.id).revision,confirm:true});
    await d.settle();assert.equal(d.a.memory.get(row.id).status,'confirmed');
    await d.y.configure({enabled:false});d.a.memory.remove(row.id,d.a.memory.get(row.id).revision);await d.x.sync();
    d.b.memory.update(row.id,{revision:approved.revision,content:'离线修改后的中文偏好。'});await d.y.configure({enabled:true,folder:d.folder});await d.settle();
    assert.throws(()=>d.a.memory.get(row.id));assert.throws(()=>d.b.memory.get(row.id));assert.equal(d.y.status().conflicts.length,1);
    const conflict=d.y.status().conflicts[0],deleted=conflict.versions.find(version=>version.value===null);
    await d.y.resolve(conflict.key,{version:deleted.id,heads:conflict.versions.map(v=>v.id)});await d.settle();
    assert.equal(d.x.status().conflicts.length,0);assert.equal(d.y.status().conflicts.length,0);assert.throws(()=>d.b.memory.get(row.id));
  }finally{await d.close();}
});

test('concurrent edits are retained, excluded from model context, revision guarded and explicitly resolved',async()=>{
  const d=await devices();try{
    const row=d.a.memory.create(input,{confirmed:true});await d.pair();
    d.a.memory.update(row.id,{revision:d.a.memory.get(row.id).revision,content:'A 希望使用中文交流。'});d.b.memory.update(row.id,{revision:d.b.memory.get(row.id).revision,content:'B 希望使用英文交流。'});
    await d.settle();for(const sync of [d.x,d.y])assert.equal(sync.status().conflicts.length,1);assert.deepEqual(d.a.memory.search().items,[]);assert.throws(()=>d.a.memory.read([row.id]),error=>error.status===404);
    const conflict=d.y.status().conflicts[0],chosen=conflict.versions.find(version=>version.value.content==='B 希望使用英文交流。');
    await assert.rejects(d.y.resolve(conflict.key,{version:chosen.id,heads:[]}),error=>error.status===409);
    await d.y.resolve(conflict.key,{version:chosen.id,heads:conflict.versions.map(v=>v.id)});await d.settle();
    assert.equal(d.a.memory.get(row.id).content,'B 希望使用英文交流。');assert.equal(d.a.memory.read([row.id]).items.length,1);assert.equal(d.x.status().conflicts.length,0);
  }finally{await d.close();}
});

test('saved preference conflicts stay out of context; local drafts and other settings remain local',async()=>{
  const d=await devices();try{
    d.a.instructions.update(null,{revision:0,content:'original'});await d.pair();
    d.a.instructions.update(null,{revision:d.a.instructions.get().revision,content:'A preference'});d.b.instructions.update(null,{revision:d.b.instructions.get().revision,content:'B preference'});
    await d.settle();assert.equal(d.a.instructions.prompt(),'');assert.equal(d.b.instructions.prompt(),'');
    const conflict=d.x.status().conflicts[0];await d.x.resolve(conflict.key,{version:conflict.versions[0].id,heads:conflict.versions.map(v=>v.id)});await d.settle();assert.ok(d.b.instructions.prompt());
    assert.equal(d.a.instructions.get().content,d.b.instructions.get().content);
  }finally{await d.close();}
});

test('candidate updates preserve their original target version, so stale proposals cannot replace newer confirmed memory',async()=>{
  const d=await devices();try{
    const original=d.a.memory.create(input,{confirmed:true});await d.pair();
    const proposal=d.a.memory.create({...input,content:'新的中文偏好',supersedes:original.id});
    d.a.memory.update(original.id,{revision:original.revision,content:'原记忆又发生了改变'});await d.settle();
    const remote=d.b.memory.get(proposal.id);assert.equal(remote.status,'candidate');
    assert.throws(()=>d.b.memory.update(remote.id,{revision:remote.revision,confirm:true}),error=>error.status===409);
    assert.equal(d.b.memory.get(original.id).content,'原记忆又发生了改变');
  }finally{await d.close();}
});

test('a current candidate update can be approved on another device, including an existing local backup alias',async()=>{
  const d=await devices();try{
    const original=d.a.memory.create(input,{confirmed:true}),local=d.b.memory.create(input,{confirmed:true});await d.pair();
    const proposal=d.a.memory.create({...input,content:'核对后的新偏好',supersedes:original.id});await d.settle();
    const remote=d.b.memory.get(proposal.id);assert.equal(remote.supersedes,local.id);
    d.b.memory.update(remote.id,{revision:remote.revision,confirm:true});await d.settle();
    assert.equal(d.a.memory.get(original.id).content,'核对后的新偏好');assert.throws(()=>d.a.memory.get(proposal.id));
    assert.equal(d.x.status().conflicts.length,0);assert.equal(d.y.status().conflicts.length,0);
  }finally{await d.close();}
});

test('late parent files and interrupted JSON are retried; changed space marker cannot erase local memory',async()=>{
  const d=await devices();try{
    const row=d.a.memory.create(input,{confirmed:true});await d.x.configure({enabled:true,folder:d.folder});
    const changes=join(d.folder,'StarportMemory','changes'),files=await readdir(changes),parent=files[0],saved=await readFile(join(changes,parent),'utf8');
    d.a.memory.update(row.id,{revision:row.revision,content:'第二版中文偏好'});await d.x.sync();await rm(join(changes,parent));
    await d.y.configure({enabled:true,folder:d.folder});assert.ok(d.y.status().waiting>0);assert.throws(()=>d.b.memory.get(row.id));
    await writeFile(join(changes,parent),saved);await d.y.sync();assert.equal(d.b.memory.get(row.id).content,'第二版中文偏好');
    await writeFile(join(changes,'00000000-0000-0000-0000-000000000000.json'),'{');await d.y.sync();assert.ok(d.y.status().waiting>0);
    await writeFile(join(d.folder,'StarportMemory','space.json'),'{}');await d.y.sync();assert.match(d.y.status().error,/标识/);assert.equal(d.b.memory.get(row.id).content,'第二版中文偏好');
  }finally{await d.close();}
});

test('temporary folder loss leaves local edits durable and retries when the same space returns',async()=>{
  const d=await devices();try{
    const row=d.a.memory.create(input,{confirmed:true});await d.pair();const moved=d.folder+'-offline';await rename(d.folder,moved);
    d.a.memory.update(row.id,{revision:d.a.memory.get(row.id).revision,content:'离线的新内容'});await d.x.sync();assert.ok(d.x.status().error);
    await rename(moved,d.folder);await d.settle();assert.equal(d.b.memory.get(row.id).content,'离线的新内容');
  }finally{await d.close();}
});

test('existing backup copies deduplicate by content and preserve their local source IDs',async()=>{
  const d=await devices();try{
    const row=d.a.memory.create(input,{confirmed:true}),copy=d.b.memory.create(input,{confirmed:true});assert.notEqual(row.id,copy.id);
    await d.pair();await d.settle();assert.equal(d.b.memory.list().total,1);assert.equal(d.b.memory.get(copy.id).content,input.content);
    d.b.memory.update(copy.id,{revision:d.b.memory.get(copy.id).revision,content:'两台统一的新内容'});await d.settle();assert.equal(d.a.memory.get(row.id).content,'两台统一的新内容');
  }finally{await d.close();}
});

test('automatic polling works through different local directories without a cloud login or model call',async()=>{
  const d=await devices(),other=await mkdtemp(join(tmpdir(),'starport-sync-other-'));
  // Stands in for a file sync app. It skips in-progress .tmp files, which the writer renames
  // away while polling; copying one mid-rename would fail the copy, not the sync.
  const mirror=()=>cp(join(d.folder,'StarportMemory'),join(other,'StarportMemory'),{recursive:true,filter:source=>!source.endsWith('.tmp')});
  try{
    await d.x.configure({enabled:true,folder:d.folder});await mirror();
    await d.y.configure({enabled:true,folder:other});d.x.interval=30;d.y.interval=30;d.x.start();d.y.start();
    const row=d.a.memory.create(input,{confirmed:true});
    for(let i=0;i<80;i++){await new Promise(resolve=>setTimeout(resolve,20));await mirror();if(d.b.db.prepare('SELECT id FROM shared_memories WHERE id=?').get(row.id))break;}
    assert.equal(d.b.memory.get(row.id).content,input.content);assert.notEqual(d.x.config().folder,d.y.config().folder);
  }finally{await d.close();await rm(other,{recursive:true,force:true});}
});

test('local sync APIs require origin/token and never turn on automatically',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'starport-sync-api-'));
  const registry={list:async()=>[]};const hub=createHub({dataDir,port:0,registry});
  try{
    const port=await hub.listen(),url=`http://127.0.0.1:${port}/api/memory-sync`,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{method:'PATCH',headers:{...headers,Origin:'https://foreign.invalid'},body:'{"enabled":false}'})).status,403);
    assert.equal((await (await fetch(url,{headers})).json()).enabled,false);
    assert.equal((await fetch(url,{method:'PATCH',headers,body:'{"enabled":false}'})).status,200);
    assert.equal((await fetch(url,{method:'PATCH',headers,body:JSON.stringify({enabled:true,folder:dataDir})})).status,400);
    assert.equal((await fetch(url,{method:'PATCH',headers,body:'{"enabled":"yes"}'})).status,400);
  }finally{await hub.close();await rm(dataDir,{recursive:true,force:true});}
});

test('identical concurrent edits converge without manufacturing repeated merge changes',async()=>{
  const d=await devices();try{
    const row=d.a.memory.create(input,{confirmed:true});await d.pair();
    d.a.memory.update(row.id,{revision:d.a.memory.get(row.id).revision,content:'相同的修改'});
    d.b.memory.update(row.id,{revision:d.b.memory.get(row.id).revision,content:'相同的修改'});await d.settle();
    const files=await readdir(join(d.folder,'StarportMemory','changes'));await d.settle();
    assert.equal(d.x.status().conflicts.length,0);assert.equal(d.y.status().conflicts.length,0);
    assert.equal((await readdir(join(d.folder,'StarportMemory','changes'))).length,files.length);
  }finally{await d.close();}
});

test('disk-backed sync resumes after a restart and missing-folder edits survive',async()=>{
  const d=await devices();let persisted,sync;const local=await mkdtemp(join(tmpdir(),'starport-sync-local-'));
  try{
    await d.x.configure({enabled:true,folder:d.folder});persisted=new Store(join(local,'hub.sqlite'));sync=new MemorySync(persisted,{dataDir:local});
    await sync.configure({enabled:true,folder:d.folder});const row=persisted.memory.create(input,{confirmed:true});await sync.sync();await d.x.sync();
    const moved=d.folder+'-offline';await rename(d.folder,moved);persisted.memory.update(row.id,{revision:row.revision,content:'重启后仍保留的离线修改'});await sync.sync();
    await sync.close();persisted.close();persisted=new Store(join(local,'hub.sqlite'));sync=new MemorySync(persisted,{dataDir:local});
    assert.equal(sync.config().enabled,true);await rename(moved,d.folder);await sync.sync();await d.x.sync();
    assert.equal(d.a.memory.get(row.id).content,'重启后仍保留的离线修改');assert.equal(sync.status().conflicts.length,0);
  }finally{if(sync)await sync.close();if(persisted)persisted.close();await d.close();await rm(local,{recursive:true,force:true});}
});

test('two remote projects without local folders retain separate scopes when a backup is imported',async()=>{
  const d=await devices(),restored=new Store(':memory:');try{
    const first=d.a.addProject('项目一','C:\\project-one'),second=d.a.addProject('项目二','C:\\project-two');
    d.a.memory.create({...input,content:'只属于项目一',project_id:first.id},{confirmed:true});
    d.a.memory.create({...input,content:'只属于项目二',project_id:second.id},{confirmed:true});await d.pair();
    assert.equal(d.b.project(first.id).workspace,'');assert.equal(d.b.project(second.id).workspace,'');
    restored.import(d.b.export());assert.equal(restored.projects().length,2);
    const rows=restored.memory.list({view:'candidate'}).items;assert.equal(new Set(rows.map(row=>row.project_id)).size,2);
  }finally{restored.close();await d.close();}
});

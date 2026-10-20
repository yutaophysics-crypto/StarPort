import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage.mjs';
import { createHub } from '../src/server.mjs';

const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),list:async()=>[],record:()=>{}};
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'starport-delete-scope-'));
  const hub=createHub({port:0,dataDir:dir,registry});
  const port=await hub.listen(),base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token};
  return {dir,hub,async remove(id){const response=await fetch(base+'/api/chats/'+id,{method:'DELETE',headers});return {status:response.status,body:await response.json()};}};
}
function files(dir,prefix=''){
  const result={};
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    if(!prefix&&entry.name.startsWith('hub.sqlite'))continue;
    const path=join(dir,entry.name),key=prefix+entry.name;
    if(entry.isDirectory())Object.assign(result,files(path,key+'/'));
    else result[key]=readFileSync(path).toString('base64');
  }
  return result;
}
const attachmentRows=hub=>hub.store.db.prepare('SELECT * FROM attachments ORDER BY id').all();
const upload=(hub,name)=>hub.attachments.upload({name,data:Buffer.from('Synthetic content: '+name).toString('base64')});

test('HTTP deletion retains all attachment records and every related file, including exclusive and draft uploads',async t=>{
  const {dir,hub,remove}=await fixture();t.after(()=>hub.close());
  const workspace=join(dir,'workspace'),backups=join(dir,'backups');
  mkdirSync(workspace);mkdirSync(backups);
  writeFileSync(join(workspace,'source.txt'),'original work file');
  writeFileSync(join(workspace,'generated.txt'),'generated result');
  writeFileSync(join(workspace,'native-history.jsonl'),'synthetic native history');
  writeFileSync(join(backups,'export.json'),'synthetic independent backup');
  const group=hub.store.group('Keep group');
  const one=hub.store.newChat({group_id:group.id,workspace}),two=hub.store.newChat({group_id:group.id,workspace});
  const exclusive=await upload(hub,'exclusive.txt'),shared=await upload(hub,'shared.txt'),draft=await upload(hub,'unsent.txt');
  const folder=await hub.attachments.folder(workspace),web=hub.attachments.web({title:'Reference',url:'https://example.com',text:'Saved page text'});
  hub.store.message(one.id,'user','codex','Delete only this chat','complete',{attachments:[exclusive,shared,folder,web]});
  hub.store.message(two.id,'user','codex','Keep this chat','complete',{attachments:[shared]});
  hub.store.saveSession(one.id,'codex','synthetic-session',null,'fixture');
  hub.store.db.prepare('INSERT INTO history_imports VALUES(?,?,?,?)').run('codex','synthetic-import',one.id,new Date().toISOString());
  const beforeRows=attachmentRows(hub),beforeFiles=files(dir),otherMessages=hub.store.messages(two.id);

  assert.deepEqual(await remove(one.id),{status:200,body:{ok:true}});
  assert.equal(hub.store.chat(one.id),null);assert.deepEqual(hub.store.messages(one.id),[]);
  assert.equal(hub.store.session(one.id,'codex'),undefined);assert.equal(hub.store.historyImport('codex','synthetic-import'),undefined);
  assert.deepEqual(hub.store.messages(two.id),otherMessages);assert.equal(hub.store.list().groups[0].id,group.id);
  assert.deepEqual(attachmentRows(hub),beforeRows,'No attachment rows may be removed or changed');
  assert.deepEqual(files(dir),beforeFiles,'No attachment, workspace, generated, native history or backup files may change');
  assert.ok(hub.attachments.raw(draft.id));
  assert.equal((await remove(one.id)).status,404);
  assert.deepEqual(attachmentRows(hub),beforeRows);assert.deepEqual(files(dir),beforeFiles);
});

test('a failed chat DELETE leaves its messages, attachment records and files intact',async t=>{
  const {dir,hub,remove}=await fixture();t.after(()=>hub.close());
  const chat=hub.store.newChat({workspace:dir}),row=await upload(hub,'retain-on-failure.txt');
  hub.store.message(chat.id,'user','codex','Keep on failure','complete',{attachments:[row]});
  const beforeRows=attachmentRows(hub),beforeFiles=files(dir),beforeMessages=hub.store.messages(chat.id);
  hub.store.db.exec("CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON chats BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  const response=await remove(chat.id);
  assert.equal(response.status,400);assert.equal(response.body.error,'synthetic failure');
  assert.ok(hub.store.chat(chat.id));assert.deepEqual(hub.store.messages(chat.id),beforeMessages);
  assert.deepEqual(attachmentRows(hub),beforeRows);assert.deepEqual(files(dir),beforeFiles);
});

test('legacy purge requests do not compact the database on delete, close or restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'starport-no-auto-purge-')),file=join(dir,'hub.sqlite');
  let store=new Store(file);
  try{
    const chat=store.newChat({workspace:dir});store.message(chat.id,'user','codex','Delete my records only');
    store.setSetting('purge_pending',1);
    // Leave free pages as a witness: an automatic VACUUM would remove them.
    store.db.exec('CREATE TABLE synthetic_free_pages (payload BLOB); INSERT INTO synthetic_free_pages VALUES (zeroblob(262144)); DELETE FROM synthetic_free_pages;');
    const freePages=()=>store.db.prepare('PRAGMA freelist_count').get().freelist_count;
    assert.ok(freePages()>0);
    store.deleteChat(chat.id);assert.equal(store.chat(chat.id),null);assert.ok(freePages()>0,'Deleting a chat must not vacuum');
    store.close();store=null;
    store=new Store(file);
    assert.equal(store.chat(chat.id),null);assert.ok(freePages()>0,'Closing or reopening must not perform a deferred vacuum');
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  }finally{store?.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/storage.mjs';

test('completion is unread until that exact answer is viewed; errors and running turns have no dot',()=>{
  const store=new Store(':memory:');
  try{
    const chat=store.newChat({title:'Fixture'});
    assert.equal(store.chat(undefined),null);assert.equal(store.chat(null),null);assert.equal(store.chat(''),null);
    assert.throws(()=>store.chatStatus.read(undefined,'anything'),/不存在/);
    assert.equal(store.chat(chat.id).unread,false);
    const first=store.message(chat.id,'assistant','codex','done');
    assert.equal(store.list().chats[0].unread,true);
    store.chatStatus.read(chat.id,first.id);assert.equal(store.chat(chat.id).unread,false);
    const next=store.message(chat.id,'assistant','claude','','running');
    assert.equal(store.chat(chat.id).unread,false);
    assert.throws(()=>store.chatStatus.read(chat.id,first.id),/更新/);
    next.status='complete';store.saveMessage(next);assert.equal(store.chat(chat.id).unread,true);
    assert.throws(()=>store.chatStatus.read(chat.id,first.id),/更新/);
    store.chatStatus.read(chat.id,next.id);assert.equal(store.chat(chat.id).unread,false);
    store.message(chat.id,'assistant','codex','','error');assert.equal(store.chat(chat.id).unread,false);
    const other=store.newChat({});const otherAnswer=store.message(other.id,'assistant','codex','done');
    assert.throws(()=>store.chatStatus.read(chat.id,otherAnswer.id),/更新/);
    store.deleteChat(chat.id);assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_read_marks').get().n,0);
    assert.equal(store.chat(other.id).unread,true);
  }finally{store.close();}
});

test('read receipts survive reopen and vacuum; one-time migration does not flag old history',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'starport-read-')),'test.sqlite');
  let store=new Store(file);const chat=store.newChat({});const old=store.message(chat.id,'assistant','codex','old');store.close();
  const legacy=new DatabaseSync(file);legacy.exec('DROP TABLE chat_read_marks');legacy.close();
  store=new Store(file);assert.equal(store.chat(chat.id).unread,false);
  const fresh=store.message(chat.id,'assistant','claude','new');assert.equal(store.chat(chat.id).unread,true);store.close();
  store=new Store(file);assert.equal(store.chat(chat.id).unread,true);store.chatStatus.read(chat.id,fresh.id);
  store.db.exec('VACUUM');assert.equal(store.chat(chat.id).unread,false);store.close();
  store=new Store(file);assert.equal(store.chat(chat.id).read_message_id,fresh.id);assert.notEqual(old.id,fresh.id);store.close();
});

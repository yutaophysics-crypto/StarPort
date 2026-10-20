import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, historyArchivePath } from '../src/storage.mjs';
import { createHub } from '../src/server.mjs';
import { ProjectFolders } from '../src/projects.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'starport-archive-move-'));
  const store = new Store(':memory:');
  const a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const chat = store.newChat({ workspace: a });
  const archive = (owner, text) => { const file = historyArchivePath(owner); mkdirSync(join(owner.workspace, '.starport', 'history'), { recursive: true }); writeFileSync(file, text); return file; };
  return { root, store, a, b, chat, archive };
}

test('moving a chat relocates only its archive, preserving peers, project markers and ledgers', t => {
  const { store, a, b, chat, archive } = fixture(t);
  const peer = store.newChat({ workspace: a });
  const source = archive(chat, 'old history'), other = archive(peer, 'peer history');
  const ledger = join(a, '.starport', 'ledgers', 'workflow'); mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, 'PLAN.md'), 'shared ledger');
  writeFileSync(join(a, '.starport', 'project.json'), 'original project marker');
  const moved = store.updateChat(chat.id, { workspace: b });
  assert.equal(existsSync(source), false); assert.equal(readFileSync(historyArchivePath(moved), 'utf8'), 'old history');
  assert.equal(readFileSync(other, 'utf8'), 'peer history');
  assert.equal(readFileSync(join(ledger, 'PLAN.md'), 'utf8'), 'shared ledger');
  assert.equal(readFileSync(join(a, '.starport', 'project.json'), 'utf8'), 'original project marker');
  assert.equal(existsSync(join(b, '.starport', 'ledgers')), false);
  store.deleteChat(chat.id); assert.equal(existsSync(historyArchivePath(moved)), false); assert.ok(existsSync(other));
});

test('filesystem failure leaves the chat and its original history untouched', t => {
  const { store, b, chat, archive } = fixture(t);
  const source = archive(chat, 'original');
  writeFileSync(join(b, '.starport'), 'a file blocks the destination directory');
  assert.throws(() => store.updateChat(chat.id, { workspace: b }));
  assert.equal(store.chat(chat.id).workspace, chat.workspace);
  assert.equal(readFileSync(source, 'utf8'), 'original');
});

test('database failure restores an existing target archive and the original chat folder', t => {
  const { store, b, chat, archive } = fixture(t);
  const source = archive(chat, 'current archive'), target = archive({ ...chat, workspace: b }, 'previous archive at target');
  store.db.exec("CREATE TRIGGER reject_workspace BEFORE UPDATE OF workspace ON chats BEGIN SELECT RAISE(ABORT,'test write failure'); END");
  assert.throws(() => store.updateChat(chat.id, { workspace: b }), /test write failure/);
  assert.equal(store.chat(chat.id).workspace, chat.workspace);
  assert.equal(readFileSync(source, 'utf8'), 'current archive');
  assert.equal(readFileSync(target, 'utf8'), 'previous archive at target');
});

test('startup repairs stranded archives from old native workspace bindings, idempotently', t => {
  const { store, b, chat, archive } = fixture(t);
  const source = archive(chat, 'stranded original'), old = chat.workspace;
  store.message(chat.id, 'assistant', 'claude', 'answer', 'complete', { context: { binding: JSON.stringify(['claude', old, false, 'opus', '']) } });
  store.db.prepare('UPDATE chats SET workspace=? WHERE id=?').run(b, chat.id);
  assert.deepEqual(store.archives.reconcile(), { moved: 1, errors: [] });
  assert.equal(readFileSync(historyArchivePath({ ...chat, workspace: b }), 'utf8'), 'stranded original');
  assert.equal(existsSync(source), false);
  assert.deepEqual(store.archives.reconcile(), { moved: 0, errors: [] });
});

test('chat deletion retries recorded old archive locations', t => {
  const { store, b, chat, archive } = fixture(t);
  const source = archive(chat, 'old'), current = archive({ ...chat, workspace: b }, 'new');
  store.archives.remember(chat, chat.workspace);
  store.db.prepare('UPDATE chats SET workspace=? WHERE id=?').run(b, chat.id);
  store.deleteChat(chat.id);
  assert.equal(existsSync(source), false); assert.equal(existsSync(current), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM history_archive_locations').get().n, 0);
});

test('renaming an old folder updates tracked archive paths so deletion still cleans them', async t => {
  const { root, store, a, b, chat, archive } = fixture(t);
  archive(chat, 'old copy'); archive({ ...chat, workspace: b }, 'current copy');
  store.archives.remember(chat, a);
  store.db.prepare('UPDATE chats SET workspace=? WHERE id=?').run(b, chat.id);
  const pf = new ProjectFolders(store); pf.sync();
  const renamed = await pf.renameFolder(a, 'renamed');
  assert.equal(renamed.path, join(root, 'renamed'));
  assert.equal(store.db.prepare('SELECT workspace FROM history_archive_locations WHERE chat_id=?').get(chat.id).workspace, renamed.path);
  const oldFile = historyArchivePath({ ...chat, workspace: renamed.path }); assert.ok(existsSync(oldFile));
  store.deleteChat(chat.id); assert.equal(existsSync(oldFile), false);
});

test('HTTP folder changes migrate archives immediately and reject invalid destinations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'starport-archive-http-')), a = join(root,'a'), b = join(root,'b');
  mkdirSync(a); mkdirSync(b);
  const hub = createHub({ port: 0, dataDir: join(root, 'data'), registry: { list: async () => [] } });
  t.after(async () => { await hub.close(); rmSync(root, { recursive: true, force: true }); });
  const port = await hub.listen(), chat = hub.store.newChat({ workspace: a });
  const file = historyArchivePath(chat); mkdirSync(join(a,'.starport','history'),{recursive:true}); writeFileSync(file,'request history');
  const update = async workspace => {
    const response = await fetch(`http://127.0.0.1:${port}/api/chats/${chat.id}`, { method: 'PATCH', headers: { 'X-Hub-Token': hub.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace }) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await update(join(root, 'missing'))).status, 400);
  assert.equal(hub.store.chat(chat.id).workspace, a); assert.ok(existsSync(file));
  const result = await update(b); assert.equal(result.status, 200);
  assert.equal(readFileSync(historyArchivePath(result.data), 'utf8'), 'request history'); assert.equal(existsSync(file), false);
});

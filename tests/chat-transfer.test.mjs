import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';
import { Store, buildContext } from '../src/storage.mjs';
import { Attachments } from '../src/attachments.mjs';
import { ChatTransfer } from '../src/chat-transfer.mjs';
import { createHub } from '../src/server.mjs';
import { Runner } from '../src/runner.mjs';
import { effortChoices } from '../src/effort.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'starport-transfer-'));
  const source = new Store(':memory:'), target = new Store(':memory:');
  t.after(async () => { source.close(); target.close(); await rm(dir, { recursive: true, force: true }); });
  const files = new Attachments(source, join(dir, 'source')), local = new Attachments(target, join(dir, 'target'));
  const exportable = new ChatTransfer(source, files), importer = new ChatTransfer(target, local);
  const group = source.group('Space research'), chat = source.newChat({ title: 'Research α', provider: 'claude', workspace: 'C:/old-machine/research', group_id: group.id,
    options: { codex: { model: 'gpt-test', permissionMode: 'full-access', mode: 'goal' }, claude: { model: 'opus-test', effort: 'high', permissionMode: 'bypassPermissions', worktree: true }, antigravity: { permissionMode: 'allow-all' } } });
  const file = await files.upload({ name: 'notes.md', data: Buffer.from('# Test\n$E=mc^2$\n中文').toString('base64') });
  const web = files.web({ title: 'Reference', url: 'https://example.com/paper', text: 'Reference content' });
  const folder = await files.folder(join(dir, 'source'));
  source.message(chat.id, 'user', 'codex', 'Explain the paper', 'complete', { attachments: [file, web, folder] });
  source.message(chat.id, 'assistant', 'claude', 'The answer is **portable**.\n$$E=mc^2$$', 'complete', {
    sessionId: 'foreign-native', context: { binding: 'foreign-binding', token: 'private-bridge' }, memory: { ids: ['private-memory'] },
    runId: 'old-run', model: 'opus-test', activity: [{ id: 'tool-a', kind: 'tool', status: 'complete', title: 'Read', output: 'read notes', meta: { token: 'private-token', environment: { SECRET: 'private-environment' } } }]
  });
  source.saveSession(chat.id, 'claude', 'foreign-native', null, 'foreign');
  source.queue.add(chat.id, { text: 'queued operation', clientId: 'queue-1' });
  const other = source.newChat({ title: 'Unrelated private conversation' });
  source.message(other.id, 'user', 'codex', 'unrelated-private-message');
  source.setSetting('login-test', { password: 'private-login' });
  target.setSetting('login-test', { password: 'local-login' });
  return { dir, source, target, files, local, exportable, importer, chat, file };
}

test('single chat roundtrip carries attachments/activity/timestamps but no unrelated data or native access', async t => {
  const f = await fixture(t), original = f.source.messages(f.chat.id), data = f.exportable.export(f.chat.id);
  const encoded = JSON.stringify(data);
  for (const text of ['unrelated-private', 'private-login', 'private-memory', 'private-bridge', 'private-token', 'private-environment', 'foreign-native', 'full-access', 'bypassPermissions', 'queued operation']) assert.ok(!encoded.includes(text), text);
  const preview = f.importer.preview(data);
  assert.equal(preview.messages, 2); assert.equal(preview.attachments, 2); assert.equal(preview.externalFolders, 1);
  const result = await f.importer.import(JSON.parse(encoded), { workspace: f.dir, group_name: 'Imported group' });
  const chat = f.target.chat(result.chatId), messages = f.target.messages(chat.id);
  assert.notEqual(chat.id, f.chat.id); assert.equal(chat.title, f.chat.title); assert.equal(chat.workspace, f.dir); assert.equal(chat.project_id, null);
  assert.equal(chat.created, f.chat.created); assert.equal(messages[1].created, original[1].created); assert.equal(messages[1].content, original[1].content);
  assert.equal(chat.options.claude.model, 'opus-test'); assert.equal(chat.options.claude.effort, 'high');
  assert.equal(chat.options.claude.permissionMode, 'default'); assert.equal(chat.options.claude.worktree, false);
  assert.equal(chat.options.codex.permissionMode, 'ask'); assert.equal(chat.options.codex.mode, 'chat'); assert.equal(chat.options.antigravity.permissionMode, 'configured');
  assert.equal(messages[1].details.activity[0].output, 'read notes'); assert.notEqual(messages[1].details.runId, 'old-run');
  assert.equal(f.target.session(chat.id, 'claude'), undefined); assert.equal(f.target.queue.list(chat.id).length, 0);
  assert.equal(f.target.setting('login-test').password, 'local-login'); assert.equal(f.target.list().chats.length, 1);
  const attachment = messages[0].details.attachments[0];
  assert.notEqual(attachment.id, f.file.id); assert.ok(attachment.path.startsWith(join(f.dir, 'target')));
  assert.equal((await readFile(attachment.path)).toString('base64'), f.files.raw(f.file.id).data);
  assert.match(messages[0].details.attachmentContext, /Reference content/); assert.ok(!messages[0].details.attachmentContext.includes('C:/old-machine'));
  assert.equal(messages[0].details.attachments.some(row => row.kind === 'folder'), false);
  assert.match(buildContext(messages).text, /portable/); assert.match(buildContext(messages).text, /Test/);
  assert.deepEqual(f.source.messages(f.chat.id), original); assert.equal(f.source.session(f.chat.id, 'claude').native_id, 'foreign-native');
});

test('reimports are idempotent; concurrent copies do not create orphan files; deleting allows reimport', async t => {
  const f = await fixture(t), data = f.exportable.export(f.chat.id);
  const results = await Promise.all([f.importer.import(data, { workspace: f.dir }), f.importer.import(data, { workspace: f.dir })]);
  assert.deepEqual(new Set(results.map(row => row.status)), new Set(['imported', 'skipped'])); assert.equal(results[0].chatId, results[1].chatId);
  assert.equal(f.target.list().chats.length, 1); assert.equal((await readdir(f.local.dir)).length, 1);
  assert.equal(f.importer.preview(data).alreadyImportedChatId, results[0].chatId);
  const reexport = f.exportable.export(f.chat.id); assert.equal((await f.importer.import(reexport, { workspace: f.dir })).status, 'skipped');
  f.target.deleteChat(results[0].chatId);
  assert.equal((await f.importer.import(data, { workspace: f.dir })).status, 'imported');
});

test('malformed packages fail before writing records/files/groups and cannot traverse paths', async t => {
  const f = await fixture(t), data = f.exportable.export(f.chat.id);
  const mutations = [
    p => p.version = 900, p => p.format = 'harness-hub', p => p.messages[0].role = 'unknown',
    p => p.messages[0].attachmentIds.push('missing'), p => p.attachments[0].data = 'bad!',
    p => p.attachments.push(p.attachments[0]), p => p.messages.push(p.messages[0]),
    p => p.messages[1].details.notices = [{}], p => p.messages[1].created = 'not-a-date',
    p => p.attachments[1].path = 'file:///C:/private', p => p.attachments[1].path = 'https://user:password@example.com',
    p => p.messages[1].details.activity[0].title = { nested: { deeply: Array(30).fill(0).reduce(v => ({ child: v }), 'x') } }
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(data); mutate(bad);
    await assert.rejects(() => f.importer.import(bad, { workspace: f.dir, group_name: 'Must not exist' }));
    assert.equal(f.target.list().chats.length, 0); assert.equal(f.target.list().groups.length, 0); assert.equal(f.target.db.prepare('SELECT count(*) n FROM attachments').get().n, 0);
  }
  const sentinel = join(f.dir, 'sentinel.md'); await writeFile(sentinel, 'keep');
  data.attachments[0].name = '../../sentinel.md'; data.attachments[0].path = sentinel;
  const imported = await f.importer.import(data, { workspace: f.dir });
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  assert.equal(f.target.messages(imported.chatId)[0].details.attachments[0].name, 'sentinel.md');
});

test('transaction failure removes only newly staged files and leaves prior files/records intact', async t => {
  const f = await fixture(t), existing = await f.local.upload({ name: 'keep.md', data: Buffer.from('keep').toString('base64') });
  f.target.db.exec("CREATE TRIGGER fail_transfer BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
  await assert.rejects(() => f.importer.import(f.exportable.export(f.chat.id), { workspace: f.dir, group_name: 'Rolled back' }), /test rollback/);
  assert.equal(f.target.list().chats.length, 0); assert.equal(f.target.list().groups.length, 0);
  assert.equal(f.target.db.prepare('SELECT count(*) n FROM attachments').get().n, 1);
  assert.deepEqual(await readdir(f.local.dir), [existing.id]); assert.equal(await readFile(existing.path, 'utf8'), 'keep');
});

test('partial output stays interrupted and historical user guidance keeps its run ordering', async t => {
  const f = await fixture(t);
  f.source.message(f.chat.id, 'user', 'claude', 'new guidance', 'complete', { guidance: { runId: 'old-run', state: 'accepted' } });
  f.source.message(f.chat.id, 'assistant', 'claude', 'partial', 'running', { runId: 'unfinished', activity: [{ id: 'pending', kind: 'tool', status: 'running' }], subagents: [{ id: 'child', status: 'running' }] });
  const result = await f.importer.import(f.exportable.export(f.chat.id), { workspace: f.dir }), rows = f.target.messages(result.chatId);
  assert.equal(rows.at(-1).status, 'interrupted'); assert.equal(rows.at(-1).details.activity[0].status, 'interrupted'); assert.equal(rows.at(-1).details.subagents[0].status, 'interrupted');
  assert.equal(rows[1].details.runId, rows[2].details.guidance.runId);
  assert.ok(buildContext(rows).text.indexOf('new guidance') < buildContext(rows).text.indexOf('portable'));
});

test('large valid attachments export and import without regex stack overflow', async t => {
  const f = await fixture(t), row = await f.files.upload({ name: 'large.bin', data: Buffer.alloc(2 * 1024 * 1024, 17).toString('base64') });
  f.source.message(f.chat.id, 'user', 'claude', 'binary', 'complete', { attachments: [row] });
  const result = await f.importer.import(f.exportable.export(f.chat.id), { workspace: f.dir });
  assert.equal((await readFile(f.target.messages(result.chatId).at(-1).details.attachments[0].path)).length, 2 * 1024 * 1024);
});

test('answered/skipped questions and local attachment links survive with fresh identifiers', async t => {
  const f = await fixture(t), rows = f.source.messages(f.chat.id);
  rows[1].details.skippedQuestions = ['text-skipped']; f.source.saveMessage(rows[1]);
  f.source.message(f.chat.id, 'user', 'claude', 'Answer', 'complete', { replyTo: { messageId: rows[1].id, questions: ['text-answered'] } });
  f.source.message(f.chat.id, 'assistant', 'claude', '[Download](/api/attachments/' + f.file.id + '/preview)', 'complete');
  const result = await f.importer.import(f.exportable.export(f.chat.id), { workspace: f.dir }), restored = f.target.messages(result.chatId);
  assert.deepEqual(restored[1].details.skippedQuestions, ['text-skipped']); assert.equal(restored[2].details.replyTo.messageId, restored[1].id);
  assert.notEqual(restored[1].id, rows[1].id); assert.deepEqual(restored[2].details.replyTo.questions, ['text-answered']);
  assert.match(restored[3].content, new RegExp(restored[0].details.attachments[0].id)); assert.ok(!restored[3].content.includes(f.file.id));
});

test('first continuation opens a fresh native session and receives the transferred transcript', async t => {
  const f = await fixture(t), result = await f.importer.import(f.exportable.export(f.chat.id), { workspace: f.dir });
  let captured;
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), models: async () => ({ models: [{ id: 'opus-test', effort: effortChoices(['high']) }] }), probe: async () => ({}), record() {} };
  const runner = new Runner(f.target, registry, () => {}, { claude: async params => {
    captured = params; params.emit({ type: 'session', id: 'new-local-session' }); params.emit({ type: 'replace', text: 'Continued locally' });
  } }, f.local);
  await runner.start(result.chatId, 'Continue the discussion'); await runner.active.get(result.chatId).done;
  assert.equal(captured.session, undefined); assert.match(captured.prompt, /Explain the paper/); assert.match(captured.prompt, /portable/);
  assert.match(captured.prompt, /Continue the discussion/); assert.equal(captured.cwd, f.dir);
  assert.equal(f.target.session(result.chatId, 'claude').native_id, 'new-local-session');
  assert.equal(f.target.messages(result.chatId).at(-1).status, 'complete');
});

test('HTTP transfer requires auth/origin, keeps Markdown export, validates local folder and never starts a model', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'starport-transfer-http-'));
  const hub = createHub({ port: 0, dataDir: dir, registry: {} });
  const port = await hub.listen(), base = 'http://127.0.0.1:' + port;
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  const chat = hub.store.newChat({ title: '中文 research', workspace: dir }); hub.store.message(chat.id, 'user', 'codex', 'hello');
  const headers = { 'X-Hub-Token': hub.token, 'Content-Type': 'application/json' };
  const path = '/api/chats/' + chat.id + '/export';
  assert.equal((await fetch(base + path + '?format=starport')).status, 401);
  const exported = await fetch(base + path + '?format=starport', { headers });
  assert.match(exported.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const conversation = await exported.json();
  assert.match(await (await fetch(base + path, { headers })).text(), /# 中文 research/);
  assert.equal((await fetch(base + '/api/chat-transfer/preview', { method: 'POST', headers: { ...headers, Origin: 'https://other.test' }, body: JSON.stringify(conversation) })).status, 403);
  assert.equal((await fetch(base + '/api/chat-transfer/preview', { method: 'POST', headers, body: JSON.stringify(conversation) })).status, 200);
  const request = async workspace => fetch(base + '/api/chat-transfer/import', { method: 'POST', headers, body: JSON.stringify({ conversation, workspace }) });
  assert.equal((await request(join(dir, 'missing'))).status, 400);
  const restored = await request(dir); assert.equal(restored.status, 201);
  assert.equal((await restored.json()).status, 'imported'); assert.equal(hub.runner.active.size, 0);
  assert.equal((await (await request(dir)).json()).status, 'skipped'); assert.equal(hub.store.list().chats.length, 2);
});

test('transfer UI parses and every user-facing transfer label has English text', () => {
  const js = readFileSync(new URL('../public/chat-transfer.js', import.meta.url), 'utf8'); new Script(js);
  const sandbox = { localStorage: { getItem() {} } };
  runInNewContext(readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8'), sandbox);
  for (const match of js.matchAll(/(?:shell|t|toast)\('([^']+)'/g)) assert.ok(Object.hasOwn(sandbox.StarportI18n.english, match[1]), `Missing translation: ${match[1]}`);
});

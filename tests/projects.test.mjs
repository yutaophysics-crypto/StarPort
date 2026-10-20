import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, renameSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import { createHub } from '../src/server.mjs';
import { ProjectFolders, readMarker, markerFile } from '../src/projects.mjs';

const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({ loggedIn: true }), models: async () => ({ models: [] }), record() {}, list: async () => [] };
const until = async (check, label = 'fixture', ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out: ' + label); };
const memory = { kind: 'preference', title: '交流方式', content: '请简洁作答。' };
const folders = (...names) => { const base = mkdtempSync(join(tmpdir(), 'starport-projects-')); for (const name of names) mkdirSync(join(base, name), { recursive: true }); return base; };

test('each exact working folder automatically becomes a project; browsing does not create projects', async () => {
  const base = folders('proj/sub', 'other'), s = new Store(':memory:'), pf = new ProjectFolders(s);
  try {
    const top = s.newChat({ workspace: join(base, 'proj') }), inner = s.newChat({ workspace: join(base, 'proj', 'sub') });
    const peer = s.newChat({ workspace: top.workspace }), outside = s.newChat({ workspace: join(base, 'other') });
    assert.ok(top.project_id); assert.ok(inner.project_id); assert.notEqual(inner.project_id, top.project_id);
    assert.equal(peer.project_id, top.project_id); assert.notEqual(outside.project_id, top.project_id);
    s.message(peer.id,'user','codex','shared signal in the same folder');
    s.message(inner.id,'user','codex','shared signal in a different subfolder');
    const matches = s.search.search({query:'shared signal',projectId:top.project_id,excludeChat:top.id});
    assert.deepEqual(matches.items.map(row=>row.chat_id),[peer.id]);
    assert.throws(()=>s.search.read({chatId:inner.id},top.project_id),e=>e.status===404);
    assert.equal(readMarker(top.workspace), top.project_id);
    assert.match(readFileSync(join(top.workspace, '.starport', '.gitignore'), 'utf8'), /^\*$/m);
    assert.equal((await pf.mark(top.workspace)).created, false);
    const view = pf.describe({ path: top.workspace, folders: [{ name: '.starport', path: join(top.workspace, '.starport') }, { name: 'sub', path: inner.workspace }] });
    assert.equal(view.folders.length, 1); assert.equal(view.project.root, true); assert.equal(view.folders[0].project, true);
    const before = s.projects().length;
    assert.equal(pf.describe({ path: join(inner.workspace, 'unvisited'), folders: [] }).project, null);
    assert.equal(s.projects().length, before, 'browsing has no project-creation side effect');
    assert.throws(() => pf.unmark(top.project_id), e => e.status === 409);
    assert.equal(s.chat(top.id).project_id, top.project_id);
  } finally { s.close(); }
});

test('renamed folders retain project identity, while copies receive their own identity', async () => {
  const base = folders('proj', 'other'), s = new Store(':memory:'), pf = new ProjectFolders(s);
  try {
    const { project } = await pf.mark(join(base, 'proj'));
    renameSync(join(base, 'proj'), join(base, 'renamed'));
    const chat = s.newChat({ workspace: join(base, 'renamed') });
    assert.equal(chat.project_id, project.id);
    assert.equal(s.project(project.id).workspace, chat.workspace); assert.equal(s.project(project.id).name, 'renamed');
    mkdirSync(join(base, 'other', '.starport'));
    cpSync(markerFile(chat.workspace), markerFile(join(base, 'other')));
    const copy = s.newChat({ workspace: join(base, 'other') });
    assert.notEqual(copy.project_id, project.id); assert.ok(copy.project_id);
    assert.equal(readMarker(copy.workspace), copy.project_id);
    assert.equal(s.project(project.id).workspace, chat.workspace);
  } finally { s.close(); }
});

test('existing folders migrate automatically without losing old project data or creating exam projects', async () => {
  const base = folders('proj/sub', 'other', 'seat'), s = new Store(':memory:');
  try {
    const old = s.addProject('proj', join(base, 'proj'));
    const top = s.newChat({ workspace: old.workspace, project_id: old.id });
    const sub = s.newChat({ workspace: join(old.workspace, 'sub'), project_id: old.id });
    const other = s.newChat({ workspace: join(base, 'other') });
    const exam = s.newChat({ workspace: join(base, 'seat'), options: { desk: { parentChatId: top.id, exam: true } }, project_id: old.id });
    const mem = s.memory.create({ ...memory, project_id: old.id }, { confirmed: true });
    s.instructions.update(old.id, { content: '保留项目要求', revision: 0 });
    const pf = new ProjectFolders(s); pf.sync();
    assert.equal(s.chat(top.id).project_id, old.id); assert.notEqual(s.chat(sub.id).project_id, old.id);
    assert.ok(s.chat(other.id).project_id); assert.equal(s.chat(exam.id).project_id, null);
    assert.equal(pf.atRoot(exam.workspace), null); assert.equal(readMarker(exam.workspace), null);
    assert.equal(s.memory.get(mem.id).project_id, old.id); assert.equal(s.instructions.get(old.id).content, '保留项目要求');
    const ids = s.projects().map(p => p.id); pf.sync(); assert.deepEqual(s.projects().map(p => p.id), ids);
    const orphan = s.addProject('旧项目', '');
    const recovered = join(base, 'recovered'); mkdirSync(recovered);
    await pf.attach(orphan.id, recovered); assert.equal(pf.resolve(recovered).id, orphan.id);
    await assert.rejects(pf.attach(orphan.id, other.workspace), e => e.status === 409);
  } finally { s.close(); }
});

test('renaming a folder in Starport moves every conversation and project inside it, or nothing', async () => {
  const base = folders('a/inner', 'b-exists', 'keep'), s = new Store(':memory:');
  const pf = new ProjectFolders(s, { protectedPaths: () => [join(base, 'keep', 'data')] });
  try {
    const { project } = await pf.mark(join(base, 'a'));
    const top = s.newChat({ workspace: join(base, 'a'), title: '上层' }), deep = s.newChat({ workspace: join(base, 'a', 'inner'), title: '深层' }), away = s.newChat({ workspace: join(base, 'keep') });
    pf.sync();

    await assert.rejects(pf.renameFolder(join(base, 'a'), 'b', { isBusy: id => id === deep.id }), e => e.status === 409 && /深层/.test(e.message));
    assert.equal(existsSync(join(base, 'a')), true, 'nothing changes while a conversation inside is running');
    await assert.rejects(pf.renameFolder(join(base, 'a'), 'b-exists'), e => e.status === 409);
    await assert.rejects(pf.renameFolder(join(base, 'a'), 'bad:name'), /文件夹名称无效/);
    await assert.rejects(pf.renameFolder(join(base, 'keep'), 'moved'), e => e.status === 409 && /星港自己的/.test(e.message));
    await assert.rejects(pf.renameFolder(join(base, 'a').slice(0, 3), 'x'), /根目录/);

    const result = await pf.renameFolder(join(base, 'a'), 'b');
    assert.deepEqual(result, { path: join(base, 'b'), chats: 2, projects: 2 });
    assert.equal(existsSync(join(base, 'a')), false); assert.equal(readMarker(join(base, 'b')), project.id);
    assert.equal(s.chat(top.id).workspace, join(base, 'b')); assert.equal(s.chat(deep.id).workspace, join(base, 'b', 'inner'));
    assert.equal(s.chat(away.id).workspace, join(base, 'keep'));
    assert.equal(s.project(project.id).workspace, join(base, 'b')); assert.equal(s.project(project.id).name, 'b');
    assert.equal(s.chat(deep.id).project_id, deep.project_id);

    // If the database cannot be updated, the folder gets its old name back.
    const db = s.db;
    pf.db = new Proxy(db, { get: (target, key) => key === 'exec' ? sql => { if (sql === 'COMMIT') throw new Error('disk full'); return target.exec(sql); } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
    await assert.rejects(pf.renameFolder(join(base, 'b'), 'c'), e => e.status === 500 && /改回/.test(e.message));
    pf.db = db;
    assert.equal(existsSync(join(base, 'b')), true); assert.equal(existsSync(join(base, 'c')), false);
    assert.equal(s.chat(top.id).workspace, join(base, 'b')); assert.equal(s.project(project.id).workspace, join(base, 'b'));
  } finally { s.close(); }
});

test('a native session survives initial project assignment and starts fresh after changing folders', async () => {
  const s = new Store(':memory:'), calls = [], folder = folders('work', 'next');
  const runner = new Runner(s, registry, () => {}, { codex: async args => { calls.push(args); args.emit({ type: 'session', id: 'native-' + calls.length }); args.emit({ type: 'replace', text: '?' }); } });
  const turn = async (chat, text) => { await runner.start(chat.id, text); await until(() => !runner.active.has(chat.id), 'turn'); };
  try {
    s.instructions.update(null, { content: '简洁偏好', revision: 0 });
    const chat = s.newChat({ provider: 'codex', workspace: join(folder, 'work') });
    await turn(chat, '第一句'); assert.equal(calls[0].session, undefined);
    const before = runner.context(chat.id), pf = new ProjectFolders(s); pf.sync();
    const project = s.project(s.chat(chat.id).project_id);
    s.instructions.update(project.id, { content: '项目要求甲', revision: 0 });
    assert.deepEqual(runner.context(chat.id), before);
    await turn(chat, '第二句'); assert.equal(calls[1].session, 'native-1'); assert.match(calls[1].prompt, /项目要求甲/);
    s.updateChat(chat.id, { workspace: join(folder, 'next') });
    await turn(chat, '第三句'); assert.equal(calls[2].session, undefined);
    assert.doesNotMatch(calls[2].prompt, /项目要求甲/);
  } finally { await runner.close(); s.close(); }
});

test('server: choosing folders creates projects automatically and renames preserve exact-folder membership', async () => {
  const base = folders('proj/sub', 'other'), dataDir = mkdtempSync(join(tmpdir(), 'starport-projects-data-'));
  const hub = createHub({ port: 0, dataDir, registry }), url = 'http://127.0.0.1:' + await hub.listen();
  const call = async (path, method = 'GET', data) => { const res = await fetch(url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': hub.token }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: res.status, body: await res.json() }; };
  try {
    const created = await call('/projects', 'POST', { workspace: join(base, 'proj') });
    assert.equal(created.status, 201); assert.equal(created.body.name, 'proj');
    assert.equal((await call('/projects', 'POST', { workspace: join(base, 'proj') })).status, 200);
    const chat = (await call('/chats', 'POST', { provider: 'codex', workspace: join(base, 'proj', 'sub') })).body;
    assert.ok(chat.project_id); assert.notEqual(chat.project_id, created.body.id);
    const ignored = await call('/chats/' + chat.id, 'PATCH', { project_id: null, title: '改个标题' });
    assert.equal(ignored.body.project_id, chat.project_id);
    const moved = (await call('/chats/' + chat.id, 'PATCH', { workspace: join(base, 'other') })).body;
    assert.ok(moved.project_id); assert.notEqual(moved.project_id, chat.project_id);
    await call('/chats/' + chat.id, 'PATCH', { workspace: join(base, 'proj', 'sub') });
    const renamed = await call('/folders/rename', 'POST', { path: join(base, 'proj'), name: '新名字' });
    assert.equal(renamed.status, 200); assert.equal(renamed.body.chats, 1);
    assert.equal(hub.store.chat(chat.id).workspace, join(base, '新名字', 'sub'));
    assert.equal(hub.store.chat(chat.id).project_id, chat.project_id);
    assert.equal((await call('/folders/rename', 'POST', { path: join(base, '新名字'), name: 'other' })).status, 409);
    assert.equal((await call('/projects/' + created.body.id + '/unmark', 'POST', {})).status, 409);
    assert.equal((await call('/chats/' + chat.id, 'PATCH', { workspace: join(base, 'missing') })).status, 400);
  } finally { await hub.close(); }
});

test('conversations in one project share each workflow\'s ledger in the project folder', { timeout: 30000 }, async t => {
  let hold = null;
  const implementations = { codex: async ({ prompt, emit }) => {
    if (hold && prompt.includes('工作流「共享」')) await hold.promise;
    const body = prompt.includes('C1 [open]') ? '复核\n```starport-ledger\n{"log":{"done":["复核"]}}\n```' : '推导\n```starport-ledger\n{"claims_add":[{"text":"命题一"}],"log":{"done":["推导"]}}\n```';
    emit({ type: 'replace', text: body }); emit({ type: 'final-answer', text: body });
  } };
  const base = folders('proj/a', 'proj/b', 'solo'), dataDir = mkdtempSync(join(tmpdir(), 'starport-ledgers-'));
  const hub = createHub({ port: 0, dataDir, registry, implementations }); const url = 'http://127.0.0.1:' + await hub.listen(); t.after(() => hub.close());
  const call = async (path, method = 'GET', data) => { const res = await fetch(url + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': hub.token }, body: data === undefined ? undefined : JSON.stringify(data) }); const json = await res.json(); if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status }); return json; };
  const { store, workflows } = hub, room = store.group('房间');
  workflows.createCompanion({ name: '码农', provider: 'codex' }, { id: 'cx' }); await call('/rooms/' + room.id + '/members', 'POST', { companionId: 'cx' });
  const workflow = await call('/workflows', 'POST', { name: '共享', description: '推进', ledger: true, stages: [{ name: '推导', positions: [{ id: 'p', name: '推导', task: '推导' }] }] });
  const solo = store.newChat({ group_id: room.id, provider: 'codex', workspace: join(base, 'solo') });
  const soloMount = await call('/chats/' + solo.id + '/mounts', 'POST', { workflowId: workflow.id, trigger: { type: 'manual' }, assignments: { p: 'cx' } });
  assert.equal(soloMount.ledgerPath, join(base, 'solo', '.starport', 'ledgers', workflow.id));
  await until(() => existsSync(join(soloMount.ledgerPath, 'PLAN.md')), 'solo ledger');

  const project = await call('/projects', 'POST', { workspace: join(base, 'proj') });
  const a = store.newChat({ group_id: room.id, provider: 'codex', workspace: join(base, 'proj'), title: '对话甲' });
  const b = store.newChat({ group_id: room.id, provider: 'codex', workspace: join(base, 'proj'), title: '对话乙' });
  hub.store.projectFolders.sync();
  const ma = await call('/chats/' + a.id + '/mounts', 'POST', { workflowId: workflow.id, trigger: { type: 'manual' }, assignments: { p: 'cx' } });
  const mb = await call('/chats/' + b.id + '/mounts', 'POST', { workflowId: workflow.id, trigger: { type: 'manual' }, assignments: { p: 'cx' } });
  const shared = join(base, 'proj', '.starport', 'ledgers', workflow.id);
  assert.equal(ma.ledgerPath, shared); assert.equal(mb.ledgerPath, shared); assert.equal(ma.ledgerProject, project.name);

  hold = Promise.withResolvers();
  await call('/mounts/' + ma.id + '/run', 'POST', {});
  await assert.rejects(call('/mounts/' + mb.id + '/run', 'POST', {}), e => e.status === 409 && /对话甲/.test(e.message), 'one run at a time per ledger');
  await assert.rejects(call('/mounts/' + mb.id + '/ledger', 'PATCH', { plan: '# 改' }), e => e.status === 409);
  hold.resolve(); hold = null;
  await until(() => !workflows.runs.size, 'run in 对话甲', 15000);

  const fromB = await call('/mounts/' + mb.id + '/ledger');
  assert.equal(fromB.path, shared); assert.equal(fromB.claims.claims[0].text, '命题一');
  assert.deepEqual(fromB.sharedWith.map(m => m.title), ['对话甲']); assert.equal(fromB.project.name, 'proj');
  assert.match(fromB.changelog, /对话「对话甲」/);
  await call('/mounts/' + mb.id + '/run', 'POST', {}); await until(() => !workflows.runs.size, 'run in 对话乙', 15000);
  const after = await call('/mounts/' + ma.id + '/ledger');
  assert.match(after.changelog, /对话「对话乙」/); assert.equal(after.claims.claims.length, 1, 'the second conversation saw C1 and did not add it again');

  // Changing one chat's folder leaves both the shared and its former private ledger intact.
  const sharedBefore = readFileSync(join(shared, 'claims.json'), 'utf8');
  const legacy = join(dataDir, 'ledgers', ma.id); mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'PLAN.md'), '# 旧私人台账');
  await call('/chats/' + a.id, 'PATCH', { workspace: join(base, 'proj', 'a') });
  const next = await call('/mounts/' + ma.id + '/ledger');
  assert.equal(next.path, join(base, 'proj', 'a', '.starport', 'ledgers', workflow.id));
  assert.equal(next.claims.claims.length, 0); assert.doesNotMatch(next.plan, /旧私人台账/);
  assert.equal(readFileSync(join(shared, 'claims.json'), 'utf8'), sharedBefore);
  assert.equal(readFileSync(join(legacy, 'PLAN.md'), 'utf8'), '# 旧私人台账');
  const stillB = await call('/mounts/' + mb.id + '/ledger');
  assert.equal(stillB.path, shared); assert.equal(stillB.claims.claims.length, 1);
});

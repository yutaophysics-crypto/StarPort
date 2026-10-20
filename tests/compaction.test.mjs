import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, buildContext, contextRows, writeHistoryArchive } from '../src/storage.mjs';
import { Compactor, planCompaction, chunkBlocks, summaryTarget } from '../src/compaction.mjs';
import { HISTORY_CONTEXT_POLICY } from '../src/history-context.mjs';
import { createHub } from '../src/server.mjs';

const row = (id, role, content) => ({ id, role, provider: role === 'assistant' ? 'claude' : 'codex', status: 'complete', content, details: {} });
const long = (tag, n) => tag + '长'.repeat(n);

test('old summaries cannot hide saved companion/failed work; replacement summary policy persists across reopening', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hub-handoff-summary-')), 'test.sqlite');
  let store = new Store(file);
  try {
    const chat = store.newChat({ workspace: process.cwd() });
    const question = store.message(chat.id, 'user', 'claude', '核对记录');
    const failure = store.message(chat.id, 'assistant', 'claude', 'quota exceeded', 'error', {
      activity: [{ id: 'comment', kind: 'text', text: '已检查输入，验证未完成。' }],
      tools: [{ id: 't', name: 'Read', status: 'complete', input: { file_path: 'input.py' }, output: '保存的工具结果' }]
    });
    store.message(chat.id, 'user', 'antigravity', '继续');
    // Simulate the pre-fix database schema and summary.
    store.db.exec('CREATE TABLE chat_summaries (chat_id TEXT PRIMARY KEY, boundary_id TEXT NOT NULL, summary TEXT NOT NULL, covered INTEGER NOT NULL, provider TEXT, model TEXT, created TEXT NOT NULL)');
    store.db.prepare('INSERT INTO chat_summaries VALUES(?,?,?,?,?,?,?)').run(chat.id, failure.id, '遗漏进度的旧摘要', 2, 'claude', '', new Date().toISOString());
    const compactor = new Compactor({ store, runner: {} });
    const legacy = compactor.summaryFor(chat.id);
    assert.match(buildContext(store.messages(chat.id), null, { summary: legacy }).text, /保存的工具结果/);
    const rows = contextRows(store.messages(chat.id));
    const huge = rows.map(message => ({ ...message, content: message.content + '长'.repeat(4000) }));
    const plan = planCompaction(huge, legacy, { maxTokens: 5000 });
    assert.equal(plan.previous, null);
    assert.equal(plan.rows[0].id, question.id);
    assert.match(plan.rows.find(message => message.id === failure.id).content, /已检查输入，验证未完成/);
    compactor.summarize = async () => '公开进度与工具证据已整理；任务未完成。';
    store.setSetting('context.settings', { summarizers: [{ provider: 'codex', model: '' }] });
    const result = await compactor.compact(chat, plan, {});
    assert.equal(result.summary.historyPolicy, HISTORY_CONTEXT_POLICY);
    store.close(); store = new Store(file);
    const reopened = new Compactor({ store, runner: {} });
    assert.equal(reopened.current(chat.id).historyPolicy, HISTORY_CONTEXT_POLICY);
    assert.equal(reopened.plan(chat.id, { maxTokens: 100000 }), null);
  } finally { store.close(); }
});

test('compaction is planned only when the history outgrows the budget, and ends on a whole exchange', () => {
  const rows = [row('u1', 'user', '问一'), row('a1', 'assistant', long('答一', 3000)), row('u2', 'user', '问二'), row('a2', 'assistant', long('答二', 3000)), row('u3', 'user', '问三')];
  assert.equal(planCompaction(rows, null, { maxTokens: 10000 }), null, 'everything fits');
  const plan = planCompaction(rows, null, { maxTokens: 5000 });
  assert.ok(plan);
  assert.equal(plan.boundaryId, 'a2', 'the kept part starts at a user message');
  assert.deepEqual(plan.rows.map(r => r.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(plan.covered, 4);
  // With that summary in place a model switch adds nothing new to summarise.
  const summary = { text: '摘要', boundaryId: 'a2' };
  assert.equal(planCompaction(rows, summary, { maxTokens: 5000 }), null, 'a model switch reuses the summary');
  // A summary whose boundary is gone is ignored.
  assert.equal(planCompaction(rows, { text: '旧', boundaryId: 'missing' }, { maxTokens: 5000 }).previous, null);
  // A byte cap alone can also require compaction.
  assert.ok(planCompaction(rows, null, { maxBytes: 12000 }));
});

test('a later compaction folds the previous summary in and only summarises what came after it', () => {
  const rows = [row('u1', 'user', '问一'), row('a1', 'assistant', '答一'), row('u2', 'user', '问二'), row('a2', 'assistant', long('答二', 4000)), row('u3', 'user', '问三'), row('a3', 'assistant', long('答三', 4000)), row('u4', 'user', '问四')];
  const plan = planCompaction(rows, { text: '前情', boundaryId: 'a1' }, { maxTokens: 6000 });
  assert.equal(plan.previous.text, '前情');
  assert.equal(plan.rows[0].id, 'u2');
  assert.equal(plan.covered, 6);
});

test('a fresh session gets the summary in place of the summarised messages and the archive keeps them', () => {
  const rows = [row('u1', 'user', '最早的问题'), row('a1', 'assistant', '最早的回答'), row('u2', 'user', '第二问'), row('a2', 'assistant', '第二答'), row('u3', 'user', '最新请求')];
  const context = buildContext(rows, null, { maxTokens: 50000, summary: { text: '用户想做甲。', boundaryId: 'a1' }, historyFile: 'X:/h.md' });
  assert.match(context.text, /<对话摘要>\n用户想做甲。\n<\/对话摘要>/);
  assert.equal(context.text.includes('最早的问题'), false);
  assert.match(context.text, /第二问[\s\S]*最新请求$/);
  assert.equal(context.summarized, 2);
  assert.equal(context.earlier.length, 2);
  assert.match(context.text, /X:\/h\.md/);
  // A continuing native session only receives what came after its cursor, never the summary.
  assert.equal(buildContext(rows, 'a2', { summary: { text: '用户想做甲。', boundaryId: 'a1' } }).text, '最新请求');
  assert.equal(contextRows(rows).length, 5);
});

test('oversized material is split for the summariser and one summary fits every tool', () => {
  const chunks = chunkBlocks(['甲'.repeat(30000), '乙'.repeat(30000), '丙'.repeat(300000)], { maxBytes: 120000 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk.join('\n')) <= 120000 + chunk.length);
  assert.equal(summaryTarget({ a: 100, b: 60 }), 9000);
  assert.equal(summaryTarget({ a: 8 }), 1500);
});

const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({ loggedIn: true, nativeAutoReview: true }), models: async () => ({ models: [] }), record() {}, list: async () => [] };

test('a long conversation is compacted once, switches reuse the summary, and deleting the chat removes its archive', { timeout: 30000 }, async t => {
  const prompts = [], summaries = [];
  let turn = 0;
  const deepseek = async ({ prompt, emit }) => {
    if (prompt.includes('你是星港的对话整理员')) {
      summaries.push(prompt);
      const text = '1. 用户的目标：测试压缩。2. 用户原话：最早几问……';
      emit({ type: 'replace', text }); emit({ type: 'final-answer', text });
      return;
    }
    prompts.push(prompt); turn++;
    const text = `第${turn}答` + '答'.repeat(2000);
    emit({ type: 'replace', text }); emit({ type: 'final-answer', text });
  };
  const claude = async () => { throw new Error('压缩一选不可用'); };
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-compact-')), workspace = mkdtempSync(join(tmpdir(), 'hub-compact-ws-'));
  const hub = createHub({ port: 0, dataDir, registry, implementations: { deepseek, claude } }); await hub.listen(); t.after(() => hub.close());
  const base = 'http://127.0.0.1:' + hub.server.address().port;
  const call = async (path, method = 'GET', data) => { const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': hub.token, Origin: base }, body: data === undefined ? undefined : JSON.stringify(data) }); const json = await res.json(); if (!res.ok) throw Object.assign(new Error(json.error), { status: res.status }); return json; };

  const defaults = await call('/context/settings');
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.budgets.antigravity, 60);
  await assert.rejects(call('/context/settings', 'PUT', { budgets: { deepseek: 2 } }), /8–1000/);
  await call('/context/settings', 'PUT', { budgets: { deepseek: 8 }, summarizers: [{ provider: 'claude', model: '' }, { provider: 'deepseek', model: '' }] });

  const { store, runner } = hub, chat = store.newChat({ provider: 'deepseek', workspace, title: '压缩测试' });
  const ask = async text => { const sent = await call('/chats/' + chat.id + '/messages', 'POST', { text }); await runner.active.get(chat.id)?.done; return sent; };
  let compactedAt = -1;
  for (let i = 1; i <= 8 && compactedAt < 0; i++) { await ask(`第${i}问`); if (summaries.length) compactedAt = i; }
  assert.ok(compactedAt > 1, 'the conversation was compacted once it outgrew the budget');
  assert.equal(summaries.length, 1, 'the failing first choice fell through to the second');
  const last = prompts.at(-1);
  assert.match(last, /<对话摘要>[\s\S]*测试压缩[\s\S]*<\/对话摘要>/);
  assert.equal(last.includes('第1问'), false, 'summarised messages are not repeated verbatim');
  assert.ok(last.endsWith(`第${compactedAt}问`), 'the newest request is delivered whole');
  assert.match(summaries[0], /第1问/);
  const reply = store.messages(chat.id).filter(m => m.role === 'assistant').at(-1);
  assert.ok(reply.details.compaction?.covered > 0);
  assert.ok(reply.details.notices.some(n => /已把较早的 \d+ 条消息压缩成摘要（由 deepseek 整理）/.test(n)), reply.details.notices.join('\n'));
  const archive = join(workspace, '.starport', 'history', chat.id + '.md');
  assert.ok(existsSync(archive));
  assert.match(readFileSync(archive, 'utf8'), /## 摘要[\s\S]*测试压缩[\s\S]*第1问/);
  assert.equal(store.list().chats.some(c => c.title.startsWith('[工位]')), false);
  assert.equal(hub.store.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE title='[工位] 压缩'").get().n, 0, 'summariser desks are removed');

  // The next turn reuses the summary instead of compacting again.
  await ask('再问一句');
  assert.equal(summaries.length, 1);
  assert.match(prompts.at(-1), /<对话摘要>/);

  await call('/chats/' + chat.id, 'DELETE');
  assert.equal(existsSync(archive), false, 'deleting the chat removes its archive');
  assert.equal(hub.store.db.prepare('SELECT COUNT(*) AS n FROM chat_summaries').get().n, 0);
});

test('with compaction off the oldest messages are dropped as before and no model is asked', { timeout: 20000 }, async t => {
  let summarized = 0, last = '';
  const deepseek = async ({ prompt, emit }) => {
    if (prompt.includes('你是星港的对话整理员')) summarized++;
    last = prompt; const text = '答'.repeat(3000); emit({ type: 'replace', text }); emit({ type: 'final-answer', text });
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-compact-off-')), workspace = mkdtempSync(join(tmpdir(), 'hub-compact-off-ws-'));
  const hub = createHub({ port: 0, dataDir, registry, implementations: { deepseek } }); await hub.listen(); t.after(() => hub.close());
  hub.store.setSetting('context.settings', { enabled: false, budgets: { deepseek: 8 } });
  const chat = hub.store.newChat({ provider: 'deepseek', workspace, title: '关闭压缩' });
  for (let i = 1; i <= 5; i++) { await hub.runner.start(chat.id, `问${i}`).then(r => r.done); }
  assert.equal(summarized, 0);
  assert.match(last, /较早的 \d+ 条消息因上下文长度未附带/);
  assert.ok(last.endsWith('问5'));
});

test('stopping a turn while it compacts stops the summariser and never starts the answer', { timeout: 20000 }, async t => {
  let answered = 0, summarising = null;
  const deepseek = async ({ prompt, emit, setControl }) => {
    if (prompt.includes('你是星港的对话整理员')) { await new Promise(resolve => { summarising = resolve; setControl({ stop: resolve }); }); throw Object.assign(new Error('stopped'), { canceled: true }); }
    answered++; const text = '答'.repeat(3000); emit({ type: 'replace', text }); emit({ type: 'final-answer', text });
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-compact-stop-')), workspace = mkdtempSync(join(tmpdir(), 'hub-compact-stop-ws-'));
  const hub = createHub({ port: 0, dataDir, registry, implementations: { deepseek } }); await hub.listen(); t.after(() => hub.close());
  hub.store.setSetting('context.settings', { enabled: true, budgets: { deepseek: 8 }, summarizers: [{ provider: 'deepseek', model: '' }] });
  const chat = hub.store.newChat({ provider: 'deepseek', workspace, title: '停止压缩' });
  for (let i = 1; i <= 8 && !summarising; i++) {
    const turn = await hub.runner.start(chat.id, `问${i}`);
    for (let w = 0; w < 50 && !summarising && hub.runner.active.has(chat.id); w++) await new Promise(r => setTimeout(r, 20));
    if (summarising) {
      const before = answered;
      await hub.runner.stop(chat.id); await turn.done;
      assert.equal(answered, before, 'the answer never started');
      const reply = hub.store.messageById(chat.id, turn.assistant.id);
      assert.equal(reply.status, 'interrupted');
      assert.equal(hub.store.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE title='[工位] 压缩'").get().n, 0);
    } else await turn.done;
  }
  assert.ok(summarising, 'compaction started');
});

test('deleting a room with its conversations removes their archives', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hub-compact-room-ws-'));
  const store = new Store(':memory:');
  try {
    const room = store.group('科研'), chat = store.newChat({ group_id: room.id, provider: 'deepseek', workspace, title: '房间里的对话' });
    const file = join(workspace, '.starport', 'history', chat.id + '.md');
    const rows = [row('a', 'user', '旧'.repeat(50000)), row('b', 'assistant', '旧'.repeat(50000)), row('c', 'user', '新')];
    writeHistoryArchive(file, chat, buildContext(rows, null, { maxBytes: 100000, historyFile: file }));
    assert.ok(existsSync(file));
    store.deleteGroup(room.id, { mode: 'move' });
    assert.ok(existsSync(file), 'moving the conversations out keeps their archives');
    const other = store.group('另一间');
    store.updateChat(chat.id, { group_id: other.id });
    store.deleteGroup(other.id, { mode: 'delete' });
    assert.equal(existsSync(file), false);
  } finally { store.close(); }
});

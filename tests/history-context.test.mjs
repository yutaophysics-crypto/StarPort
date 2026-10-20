import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store, buildContext } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import { historyRows, historyMessage, HISTORY_CONTEXT_POLICY, compatibleHistorySummary } from '../src/history-context.mjs';
import { sessionFingerprint } from '../src/context.mjs';
import { MEMORY_RECALL_POLICY } from '../src/memory-relevance.mjs';

const row = (id, role, content, extra = {}) => ({ id, chat_id: 'chat', role, provider: 'claude', content, status: 'complete', details: {}, ...extra });
const card = () => row('card', 'assistant', 'UI excerpt', { details: { workflowRun: { title: '核查', status: 'done', steps: [
  { companionId: 'c1', companionName: '探子', task: '核对输入', status: 'done', output: '伙伴完整结论：参数需要修正。' },
  { companionId: 'c2', companionName: '复核员', status: 'failed', output: '复核尚未完成。', error: '额度不足' }
] } } });
const failed = () => row('failed', 'assistant', 'quota exceeded', { status: 'error', details: {
  finalAnswer: 'quota exceeded', error: 'quota exceeded', runId: 'run', activity: [
    { id: 'text1', kind: 'text', text: '已经检查两个输入文件，接下来验证边界。' },
    { id: 'hidden', kind: 'reasoning', text: 'PRIVATE_REASONING_DO_NOT_FORWARD' },
    { id: 'read', kind: 'tool', name: 'Read', status: 'complete', input: { file_path: 'C:/work/input.py' }, output: 'public source' }
  ], tools: [
    { id: 'read', name: 'Read', status: 'complete', input: { file_path: 'C:/work/input.py' }, output: 'public source' },
    { id: 'test', name: 'Bash', status: 'error', input: { command: 'python test.py' }, output: 'assertion failed' },
    { id: 'write', name: 'Edit', status: 'denied', input: { file_path: 'C:/work/output.py' }, output: 'permission denied' }
  ]
} });

test('normal history includes attributed companion answers and prior requests without mutating stored records', () => {
  const messages = [row('u', 'user', '@探子 核对输入', { details: { dispatch: { companions: ['c1'] } } }), card(), row('next', 'user', '你怎么看伙伴的结论？')];
  const original = JSON.stringify(messages), context = buildContext(messages).text;
  assert.match(context, /此前交给伙伴的用户请求，仅作历史参考/);
  assert.match(context, /伙伴 探子 · 已完成[\s\S]*伙伴完整结论/);
  assert.match(context, /伙伴 复核员 · 失败[\s\S]*额度不足/);
  assert.ok(context.endsWith('你怎么看伙伴的结论？'));
  assert.equal(context.includes('UI excerpt'), false);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(historyRows(messages, 'card').map(m => m.id), ['next']);
});

test('a quota/interruption keeps public progress and actual tool statuses, omitting reasoning and deduplicating tool events', () => {
  for (const status of ['error', 'interrupted']) {
    const message = failed(); message.status = status;
    const text = historyMessage(message).content;
    assert.match(text, /未完成的助手回合/);
    assert.match(text, /已经检查两个输入文件/);
    assert.match(text, /Read · 已结束[\s\S]*C:\/work\/input.py/);
    assert.match(text, /Bash · 出错[\s\S]*assertion failed/);
    assert.match(text, /Edit · 未获批准/);
    assert.match(text, /quota exceeded/);
    assert.equal(text.includes('PRIVATE_REASONING_DO_NOT_FORWARD'), false);
    assert.equal(text.match(/- Read /g).length, 1);
    assert.match(text, /chatId=chat，messageId=failed/);
  }
  assert.equal(historyMessage(row('live', 'assistant', 'still running', { status: 'running' })), null);
  const noOutput = historyMessage(row('empty', 'assistant', '', { status: 'error', details: { error: 'startup failed' } })).content;
  assert.match(noOutput, /startup failed/);
  assert.equal(noOutput.includes('工具执行记录'), false);
});

test('delivered guidance precedes interrupted work, but undelivered guidance stays out', () => {
  const messages = [row('u', 'user', '开工'), failed(),
    row('g', 'user', '先检查输入', { details: { guidance: { runId: 'run', state: 'delivered' } } }),
    row('unsent', 'user', '尚未送达', { status: 'error', details: { guidance: { runId: 'run', state: 'not-delivered' } } })];
  assert.deepEqual(historyRows(messages).map(m => m.id), ['u', 'g', 'failed']);
});

test('results added to an older run card are delivered past a native cursor and invalidate an older summary', () => {
  const run = card(); run.created = '2026-10-18T10:00:00Z'; run.details.workflowRun.ended = '2026-10-18T10:02:00Z';
  const first = row('cursor', 'assistant', '先回复', { created: '2026-10-18T10:01:00Z' });
  const latest = row('latest', 'user', '现在看看伙伴的结果', { created: '2026-10-18T10:03:00Z' });
  assert.deepEqual(historyRows([run, first, latest], 'cursor').map(m => m.id), ['card', 'latest']);
  const after = row('after', 'assistant', '已收到伙伴结果', { created: '2026-10-18T10:04:00Z' });
  assert.deepEqual(historyRows([run, first, latest, after], 'after'), []);
  const summary = { text: '只整理到中途', boundaryId: 'cursor', created: first.created, historyPolicy: HISTORY_CONTEXT_POLICY };
  assert.equal(compatibleHistorySummary(summary, historyRows([run, first, latest])), null);
});

test('tool excerpts stay bounded, retain first and last calls, and full paged history exposes saved public evidence', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const chat = store.newChat({ workspace: process.cwd() });
  const details = failed().details;
  details.tools = Array.from({ length: 40 }, (_, i) => ({ id: 't' + i, name: 'call-' + i, status: i === 39 ? 'error' : 'complete',
    input: { path: 'C:/work/file-' + i, api_key: 'UNSAFE_KEY', password: 'UNSAFE_PASSWORD' }, output: 'x'.repeat(6000) + 'END-' + i }));
  const message = store.message(chat.id, 'assistant', 'claude', 'quota exceeded', 'error', details);
  const compact = historyMessage(message).content;
  assert.ok(compact.length < 24000);
  assert.match(compact, /call-0/); assert.match(compact, /call-39 · 出错/); assert.match(compact, /END-39/);
  assert.equal(compact.includes('UNSAFE_KEY'), false); assert.equal(compact.includes('UNSAFE_PASSWORD'), false);
  let start = 0, joined = '', count = 0;
  do {
    const page = store.search.read({ chatId: chat.id, messageId: message.id, start, maxChars: 20000 });
    joined += page.text; start = page.nextStart; count++;
  } while (start !== null);
  assert.ok(count > 2);
  assert.match(joined, /END-39/); assert.match(joined, /已经检查两个输入文件/);
  assert.equal(joined.includes('PRIVATE_REASONING_DO_NOT_FORWARD'), false);
  assert.equal(joined.includes('UNSAFE_KEY'), false);
  assert.throws(() => store.search.read({ chatId: chat.id, messageId: message.id }, 'other-project'));
  store.deleteChat(chat.id);
  assert.throws(() => store.search.read({ chatId: chat.id, messageId: message.id }), error => error.status === 404);
});

test('legacy summaries that omitted companion or failed turns are ignored; compatible summaries stay usable', () => {
  const messages = [row('u', 'user', '查一下'), card(), failed(), row('next', 'user', '继续')];
  const rows = historyRows(messages);
  const old = { text: '旧摘要缺少执行记录', boundaryId: 'failed' };
  assert.equal(compatibleHistorySummary(old, rows), null);
  assert.match(buildContext(messages, null, { summary: old }).text, /伙伴完整结论/);
  const updated = { ...old, historyPolicy: HISTORY_CONTEXT_POLICY };
  assert.equal(compatibleHistorySummary(updated, rows), updated);
  assert.equal(compatibleHistorySummary({ text: '普通旧摘要', boundaryId: 'u' }, rows).text, '普通旧摘要');
});

const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}), record() {} };
const runTurn = async (runner, chatId, text) => { const turn = await runner.start(chatId, text); await (turn.done || runner.active.get(chatId)?.done); return turn; };
test('switching away from a quota-limited Claude turn sends saved progress and tool evidence to Antigravity', async t => {
  const store = new Store(':memory:');
  let received = '';
  const runner = new Runner(store, registry, () => {}, {
    claude: async ({ emit }) => {
      emit({ type: 'session', id: 'claude-session' });
      emit({ type: 'activity', item: { id: 'comment', kind: 'text', text: '已阅读 input.py，尚未完成验证。', status: 'complete' } });
      emit({ type: 'tool', id: 'read', name: 'Read', status: 'complete', input: { file_path: 'C:/work/input.py' }, output: 'saved source' });
      emit({ type: 'replace', text: 'quota exceeded' }); emit({ type: 'final-answer', text: 'quota exceeded' });
      throw new Error('quota exceeded');
    },
    antigravity: async ({ emit, prompt }) => { received = prompt; emit({ type: 'replace', text: '接手' }); }
  });
  t.after(async () => { await runner.close(); store.close(); });
  const chat = store.newChat({ provider: 'claude', workspace: process.cwd() });
  await runTurn(runner, chat.id, '检查输入');
  assert.equal(store.lastAssistant(chat.id).status, 'error');
  store.updateChat(chat.id, { provider: 'antigravity' });
  await runTurn(runner, chat.id, '接着刚才的工作做');
  assert.match(received, /已阅读 input.py，尚未完成验证/);
  assert.match(received, /Read · 已结束[\s\S]*saved source/);
  assert.match(received, /quota exceeded/);
  assert.match(received, /未记录的操作不能视为已执行/);
});

test('a continuing native model receives new companion results without an explicit reply-to-card', async t => {
  const store = new Store(':memory:'); const calls = [];
  const runner = new Runner(store, registry, () => {}, { codex: async ({ emit, prompt, session }) => {
    calls.push({ prompt, session }); emit({ type: 'session', id: 'native' }); emit({ type: 'replace', text: '完成' });
  } });
  t.after(async () => { await runner.close(); store.close(); });
  const chat = store.newChat({ provider: 'codex', workspace: process.cwd() });
  await runTurn(runner, chat.id, '你好');
  store.message(chat.id, 'user', 'codex', '@探子 核查', 'complete', { dispatch: { companions: ['c1'] } });
  store.message(chat.id, 'assistant', 'codex', 'UI excerpt', 'complete', card().details);
  await runTurn(runner, chat.id, '总结伙伴的结论');
  assert.equal(calls.at(-1).session, 'native');
  assert.match(calls.at(-1).prompt, /伙伴完整结论/);
  assert.equal(calls.at(-1).prompt.match(/伙伴完整结论/g).length, 1);
});

test('old native fingerprints are refreshed once under the shared-history policy', () => {
  const runtime = registry.resolve(), chat = { workspace: process.cwd() };
  const old = createHash('sha256').update(JSON.stringify({ runtime, workspace: chat.workspace, worktree: false, memoryPolicy: MEMORY_RECALL_POLICY })).digest('hex');
  const current = sessionFingerprint(runtime, chat, {});
  assert.notEqual(current, old);
  assert.equal(current, sessionFingerprint(runtime, chat, {}));
});

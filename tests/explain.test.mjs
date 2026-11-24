import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/server.mjs';
import { DEFAULT_EXPLAIN, explainPrompt, validateExplainSettings } from '../src/explain.mjs';

const thinking = { choices: [{ value: 'off', label: '不思考' }, { value: 'on', label: '思考' }] };
const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}),
  models: async id => ({ models: id === 'ollama' ? [{ id: 'qwen3:4b', effort: thinking }] : [] }), record() {}, list: async () => [] };
async function hubWith(t, implementations) {
  const hub = createHub({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hub-explain-')), registry, implementations });
  await hub.listen(); t.after(() => hub.close());
  const base = 'http://127.0.0.1:' + hub.server.address().port;
  const call = async (path, method = 'GET', data, signal) => {
    const res = await fetch(base + '/api' + path, { method, signal, headers: { 'Content-Type': 'application/json', 'X-Hub-Token': hub.token }, body: data === undefined ? undefined : JSON.stringify(data) });
    const json = await res.json();
    if (!res.ok) throw new Error(res.status + ': ' + json.error);
    return json;
  };
  return { hub, call };
}
const desks = hub => hub.store.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE title='[工位] 解释'").get().n;

test('the default is a small Antigravity model with the three-sentence prompt', () => {
  assert.deepEqual({ provider: DEFAULT_EXPLAIN.provider, model: DEFAULT_EXPLAIN.model, prompt: DEFAULT_EXPLAIN.prompt },
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', prompt: '用三句话解释这个词语/短语/句子' });
  assert.equal(explainPrompt(' 用三句话解释 ', '\n serendipity \n'), '用三句话解释\n\nserendipity');
  assert.throws(() => validateExplainSettings({ provider: 'nope' }), /工具/);
  assert.throws(() => validateExplainSettings({ prompt: '  ' }), /提示词/);
  assert.throws(() => validateExplainSettings({ effort: 'a b' }), /思考强度/);
  assert.equal(validateExplainSettings({ provider: 'codex', service: 'x' }).service, '', 'only DeepSeek has a model service');
});

test('each explanation is a new hidden chat that sees only the prompt and the selection, then is deleted', { timeout: 20000 }, async t => {
  const calls = [];
  const antigravity = async args => {
    calls.push(args);
    args.emit({ type: 'session', id: 'agy-' + calls.length, model: args.options.model });
    args.emit({ type: 'delta', text: '偶然发现美好事物的运气。' });
    args.emit({ type: 'final-answer', text: '偶然发现美好事物的运气。' });
  };
  const { hub, call } = await hubWith(t, { antigravity });
  // Requirements and memories that ordinary chats receive must not reach the explain model.
  hub.store.instructions.update(null, { revision: hub.store.instructions.get().revision, content: '全局要求：总是用英文回答' });
  assert.match(hub.store.instructions.prompt(null), /总是用英文回答/);
  const settings = await call('/explain/settings');
  assert.equal(settings.provider, 'antigravity');
  assert.equal(settings.defaults.prompt, '用三句话解释这个词语/短语/句子');
  for (const round of [1, 2]) {
    const result = await call('/explain', 'POST', { text: '  serendipity ' });
    assert.deepEqual(result, { text: '偶然发现美好事物的运气。', provider: 'antigravity', model: 'gemini-3.8-flash-low' });
    assert.equal(calls.length, round);
  }
  for (const args of calls) {
    assert.equal(args.prompt, '用三句话解释这个词语/短语/句子\n\nserendipity');
    assert.equal(args.session, undefined, 'never resumes an earlier explanation');
    assert.equal(args.contextTools, null);
    assert.equal(args.options.model, 'gemini-3.8-flash-low');
    assert.equal(args.options.permissionMode, 'configured', 'read-only: anything that asks is declined');
    assert.match(args.cwd, /starport-explain$/);
  }
  assert.equal(desks(hub), 0);
  assert.equal(hub.store.list().chats.length, 0, 'nothing appears in the sidebar');
});

test('settings choose another tool and prompt; bad input and long selections are refused', { timeout: 20000 }, async t => {
  const calls = [];
  const ollama = async args => { calls.push(args); args.emit({ type: 'final-answer', text: 'A lucky find.' }); };
  const { call } = await hubWith(t, { ollama });
  await assert.rejects(call('/explain/settings', 'PUT', { provider: 'unknown' }), /400: 请选择解释用的工具/);
  await assert.rejects(call('/explain/settings', 'PUT', { prompt: '' }), /400: 提示词需要/);
  const saved = await call('/explain/settings', 'PUT', { provider: 'ollama', model: 'qwen3:4b', effort: 'off', prompt: 'Translate into English' });
  assert.deepEqual(saved, { provider: 'ollama', model: 'qwen3:4b', effort: 'off', service: '', prompt: 'Translate into English' });
  assert.equal((await call('/explain/settings', 'PUT', { prompt: '一句话解释' })).model, 'qwen3:4b', 'a partial update keeps the model');
  assert.equal((await call('/explain', 'POST', { text: '偶然' })).text, 'A lucky find.');
  assert.equal(calls[0].prompt, '一句话解释\n\n偶然');
  assert.equal(calls[0].options.effort, 'off');
  await assert.rejects(call('/explain', 'POST', { text: '   ' }), /400: 请先选中/);
  await assert.rejects(call('/explain', 'POST', { text: 'x'.repeat(4001) }), /400: 选中的文字太长/);
});

test('a failed model reports its error, and closing the request stops the hidden chat', { timeout: 20000 }, async t => {
  let started, stopped = false;
  const antigravity = async ({ prompt, signal }) => {
    if (prompt.endsWith('失败')) throw new Error('quota exceeded');
    started?.();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { stopped = true; reject(Object.assign(new Error('已停止'), { canceled: true })); }, { once: true }));
  };
  const { hub, call } = await hubWith(t, { antigravity });
  await assert.rejects(call('/explain', 'POST', { text: '失败' }), /502: quota exceeded/);
  const controller = new AbortController();
  const running = new Promise(resolve => { started = resolve; });
  const request = call('/explain', 'POST', { text: '慢' }, controller.signal).catch(error => error);
  await running;
  controller.abort();
  assert.equal((await request).name, 'AbortError');
  for (let i = 0; i < 100 && (desks(hub) || hub.runner.active.size); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped, true);
  assert.equal(hub.runner.active.size, 0);
  assert.equal(desks(hub), 0);
});

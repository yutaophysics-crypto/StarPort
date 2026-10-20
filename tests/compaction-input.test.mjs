import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compactor, chunkBlocks } from '../src/compaction.mjs';
import { Store, estimateTokens, messageBlock } from '../src/storage.mjs';
import { validateInput } from '../src/interactions.mjs';
import { INPUT_BYTE_LIMITS } from '../src/runner.mjs';
import { createHub } from '../src/server.mjs';

const row = (id, content) => ({ id, role: 'user', provider: 'claude', status: 'complete', content, details: {} });

test('summarizer chunks preserve every character, including oversized messages and emoji', () => {
  const blocks = ['a'.repeat(220000), '中'.repeat(90000), '🧭'.repeat(70000)];
  const limits = { maxChars: 80000, maxBytes: 120000, maxTokens: 50000 };
  const chunks = chunkBlocks(blocks, limits);
  assert.equal(chunks.flat().join(''), blocks.join(''), 'no middle of a long message is discarded');
  for (const chunk of chunks) {
    const text = chunk.join('\n');
    assert.ok(text.length <= limits.maxChars);
    assert.ok(Buffer.byteLength(text) <= limits.maxBytes);
    assert.ok(estimateTokens(text) <= limits.maxTokens);
    assert.ok(text.isWellFormed(), 'splitting does not break a surrogate pair');
  }
  assert.throws(() => chunkBlocks(['test'], { maxChars: 0 }), /预算|长度/);
});

test('summarizer budgets include the wrapper and the actual growing summary on every request', async () => {
  const rows = [row('a', 'x'.repeat(140000)), row('b', '中'.repeat(90000)), row('c', '🧭'.repeat(60000))];
  for (const provider of ['codex', 'claude', 'antigravity', 'deepseek']) {
    const store = new Store(':memory:');
    try {
      const compactor = new Compactor({ store, runner: {} });
      const prompts = [];
      compactor.runDesk = async (chat, model, prompt) => {
        validateInput(prompt);
        if (INPUT_BYTE_LIMITS[provider]) assert.ok(Buffer.byteLength(prompt) <= INPUT_BYTE_LIMITS[provider] - 8000);
        prompts.push(prompt);
        return 'S'.repeat(prompts.length === 1 ? 70000 : 45000);
      };
      const result = await compactor.summarize({ title: '长历史压缩' }, { provider }, { rows, previous: { text: '原摘要'.repeat(9000) } }, 9000, undefined, () => {});
      assert.ok(result.length > 0);
      assert.ok(prompts.length > 1);
      const supplied = prompts.map(prompt => prompt.slice(prompt.lastIndexOf('<对话原文>\n') + '<对话原文>\n'.length, prompt.lastIndexOf('\n</对话原文>')));
      assert.equal(supplied.join('').replaceAll('\n', ''), rows.map(messageBlock).join('').replaceAll('\n', ''));
    } finally { store.close(); }
  }
});

test('an overlong previous summary fails explicitly without silently dropping history', async () => {
  const store = new Store(':memory:');
  try {
    const compactor = new Compactor({ store, runner: {} });
    compactor.runDesk = async () => assert.fail('no overlong request should reach a model');
    await assert.rejects(compactor.summarize({ title: '测试' }, { provider: 'claude' }, { rows: [row('a', '历史')], previous: { text: 'x'.repeat(100000) } }, 9000, undefined, () => {}), /摘要.*过长|预算/);
  } finally { store.close(); }
});

test('a history over 100000 characters compacts through real runner validation and model fallback', { timeout: 30000 }, async t => {
  const summaries = [], answers = [];
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({ loggedIn: true }), models: async () => ({ models: [] }), record() {}, list: async () => [] };
  const hub = createHub({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hub-compact-input-')), registry, implementations: {
    codex: async () => { throw new Error('first model unavailable'); },
    claude: async ({ prompt, emit }) => { summaries.push(prompt); emit({ type: 'replace', text: '摘要保留用户目标、已做决定和未完任务。' }); },
    deepseek: async ({ prompt, emit }) => { answers.push(prompt); emit({ type: 'replace', text: '继续回答。' }); }
  } });
  await hub.listen(); t.after(() => hub.close());
  hub.store.setSetting('context.settings', { budgets: { deepseek: 8 }, summarizers: [{ provider: 'codex' }, { provider: 'claude' }, { provider: 'deepseek' }] });
  const chat = hub.store.newChat({ provider: 'deepseek', workspace: mkdtempSync(join(tmpdir(), 'hub-compact-input-ws-')), title: '复现截图' });
  for (let i = 0; i < 30; i++) {
    hub.store.message(chat.id, 'user', 'claude', `User message ${i}: ` + 'a'.repeat(4000));
    hub.store.message(chat.id, 'assistant', 'claude', `Reply ${i}: ` + 'b'.repeat(4000));
  }
  const turn = await hub.runner.start(chat.id, '请继续未完的任务');
  await turn.done;
  const reply = hub.store.messageById(chat.id, turn.assistant.id);
  assert.equal(reply.status, 'complete');
  assert.ok(summaries.length > 1, 'the long history is delivered in multiple valid requests');
  assert.equal(answers.length, 1, 'answering begins only after a successful summary');
  assert.match(answers[0], /<对话摘要>[\s\S]*用户目标/);
  assert.ok(answers[0].endsWith('请继续未完的任务'));
  assert.ok(reply.details.compaction?.covered > 0);
  assert.ok(!reply.details.notices.some(note => note.includes('压缩没有成功')));
  assert.ok(!hub.store.list().chats.some(chat => chat.options?.desk?.compact));
});


test('a native session with a failed compaction rebuilds history, then resumes normally', { timeout: 30000 }, async t => {
  let unavailable = true;
  const answers = [], summaries = [];
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({ loggedIn: true }), models: async () => ({ models: [] }), record() {}, list: async () => [] };
  const hub = createHub({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hub-compact-recovery-')), registry, implementations: {
    claude: async ({ prompt, session, emit }) => {
      if (prompt.includes('你是星港的对话整理员')) {
        if (unavailable) throw new Error('summarizer unavailable');
        summaries.push(prompt);
        emit({ type: 'replace', text: 'Recovered user goals and decisions.' });
      } else {
        answers.push({ prompt, session });
        emit({ type: 'session', id: answers.length === 1 ? 'incomplete-session' : 'repaired-session' });
        emit({ type: 'replace', text: 'Answer.' });
      }
    }
  } });
  await hub.listen(); t.after(() => hub.close());
  hub.store.setSetting('context.settings', { budgets: { claude: 8 }, summarizers: [{ provider: 'claude' }] });
  const chat = hub.store.newChat({ provider: 'claude', workspace: mkdtempSync(join(tmpdir(), 'hub-compact-recovery-ws-')) });
  for (let i = 0; i < 20; i++) {
    hub.store.message(chat.id, 'user', 'claude', `Original goal ${i}: ` + 'a'.repeat(4000));
    hub.store.message(chat.id, 'assistant', 'claude', 'b'.repeat(4000));
  }
  const failed = await hub.runner.start(chat.id, 'First request'); await failed.done;
  assert.equal(hub.store.messageById(chat.id, failed.assistant.id).details.contextCompaction.status, 'error');
  const old = hub.store.session(chat.id, 'claude');
  // Also recover sessions that continued after the failed handoff on the old server.
  const continued = hub.store.message(chat.id, 'assistant', 'claude', 'Later answer with incomplete context.', 'complete', { sessionId: old.native_id });
  hub.store.saveSession(chat.id, 'claude', old.native_id, continued.id, old.fingerprint);
  unavailable = false;
  const recovered = await hub.runner.start(chat.id, 'Recover missing context'); await recovered.done;
  assert.equal(answers[1].session, undefined, 'do not resume the incomplete native history');
  assert.match(summaries.join('\n'), /Original goal 0/);
  assert.match(answers[1].prompt, /Recovered user goals and decisions/);
  assert.equal(hub.store.messageById(chat.id, recovered.assistant.id).details.contextCompaction.status, 'complete');
  const count = summaries.length;
  const next = await hub.runner.start(chat.id, 'A short follow-up'); await next.done;
  assert.equal(answers[2].session, 'repaired-session');
  assert.equal(summaries.length, count, 'a repaired session does not compact on every message');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createHub } from '../src/server.mjs';

const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({ loggedIn: true }), models: async () => ({ models: [] }), record() {}, list: async () => [] };
async function until(condition) {
  for (let i = 0; i < 250; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('fixture did not reach expected phase');
}

for (const outcome of ['complete', 'error', 'interrupted']) test(`compaction progress survives snapshots and settles on ${outcome}`, { timeout: 15000 }, async t => {
  let releaseSummary, releaseAnswer, answering = false;
  const deepseek = async ({ prompt, emit, setControl }) => {
    if (prompt.includes('你是星港的对话整理员')) {
      await new Promise(resolve => { releaseSummary = resolve; setControl({ stop: resolve }); });
      if (outcome === 'error') throw new Error('synthetic summary failure');
      emit({ type: 'replace', text: '较早对话摘要。用户希望继续任务。' });
      return;
    }
    answering = true;
    await new Promise(resolve => { releaseAnswer = resolve; setControl({ stop: resolve }); });
    emit({ type: 'replace', text: '完成' });
  };
  const hub = createHub({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hub-progress-')), registry, implementations: { deepseek } });
  await hub.listen(); t.after(() => hub.close());
  const workspace = mkdtempSync(join(tmpdir(), 'hub-progress-ws-'));
  hub.store.setSetting('context.settings', { budgets: { deepseek: 8 }, summarizers: [{ provider: 'deepseek', model: '' }] });
  const chat = hub.store.newChat({ provider: 'deepseek', workspace, title: '进度测试' });
  for (let i = 0; i < 3; i++) {
    hub.store.message(chat.id, 'user', 'deepseek', `问题${i} ` + '旧'.repeat(4000));
    hub.store.message(chat.id, 'assistant', 'deepseek', '答'.repeat(4000), 'complete');
  }
  const turn = await hub.runner.start(chat.id, '请继续最新任务');
  await until(() => releaseSummary);
  const base = 'http://127.0.0.1:' + hub.server.address().port;
  const snapshot = await fetch(base + '/api/chats/' + chat.id, { headers: { 'X-Hub-Token': hub.token } }).then(r => r.json());
  assert.equal(snapshot.run.phase, 'compacting');
  assert.equal(snapshot.messages.at(-1).details.contextCompaction.status, 'running');
  assert.equal(snapshot.messages.at(-1).details.contextCompaction.provider, 'deepseek');
  assert.equal(hub.runner.live(chat.id).run.phase, 'compacting');
  if (outcome === 'interrupted') {
    await hub.runner.stop(chat.id); await turn.done;
    assert.equal(answering, false);
  } else {
    releaseSummary();
    await until(() => answering);
    assert.equal(hub.runner.state(chat.id).phase, 'answering');
    assert.equal(hub.store.messageById(chat.id, turn.assistant.id).details.contextCompaction.status, outcome);
    releaseAnswer(); await turn.done;
  }
  const final = hub.store.messageById(chat.id, turn.assistant.id);
  assert.equal(final.details.contextCompaction.status, outcome);
  assert.ok(final.details.contextCompaction.endedAt);
  assert.equal(hub.runner.state(chat.id), null);
  assert.equal(final.details.notices.some(n => /正在.*压缩/.test(n)), false);
  if (outcome === 'error') assert.ok(final.details.notices.some(n => /压缩没有成功/.test(n)));
});

// Exercise the actual renderer at all detail levels, without a browser or native model call.
function ui() {
  const ctx = vm.createContext({ localStorage: { getItem() {}, setItem() {} }, document: {} });
  vm.runInContext(readFileSync(new URL('../public/activity-model.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8'), ctx);
  function el(tag, attrs = {}, children = []) {
    const node = { tag, attrs, children: [], dataset: {}, append(...items) { this.children.push(...items.filter(x => x != null)); } };
    node.append(...children); return node;
  }
  const nodes = root => root && typeof root === 'object' ? [root, ...root.children.flatMap(nodes)] : [];
  return { ctx, el, nodes };
}
test('compaction remains visible with execution details hidden and never says thinking while compacting', () => {
  const { ctx, el, nodes } = ui();
  for (const level of ['hidden', 'overview', 'full']) {
    ctx.StarportActivityModel.setLevel(level);
    const message = { id: 'm', provider: 'deepseek', status: 'running', created: new Date().toISOString(), details: { contextCompaction: { status: 'running', part: 1, parts: 2 } } };
    const rendered = ctx.StarportActivity.render(message, { el, t: s => s, markdown: s => el('p', { text: s }), chatId: 'c' });
    const all = nodes(rendered);
    const banner = all.find(n => n.attrs.class === 'context-compaction-status');
    assert.ok(banner, level);
    assert.equal(banner.attrs.role, 'status');
    assert.equal(banner.attrs['aria-live'], 'polite');
    assert.ok(all.some(n => n.attrs.text === '正在压缩上下文…'));
    assert.equal(all.some(n => n.attrs.text === '正在思考'), false);
    for (const status of ['complete', 'error', 'interrupted']) {
      message.status = status;
      const settled = ctx.StarportActivity.render(message, { el, t: s => s, markdown: s => el('p', { text: s }), chatId: 'c' });
      assert.equal(nodes(settled).some(n => n.attrs.class === 'context-compaction-status'), false);
    }
  }
});
test('composer status explicitly names compaction instead of normal processing', () => {
  const source = readFileSync(new URL('../public/app-messages.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function runStatusLine('), source.indexOf('\nfunction renderComposerAction'));
  const ctx = vm.createContext({ state: { messages: [] }, t: s => s, formatDuration: () => '1s', Date });
  vm.runInContext(fn, ctx);
  const label = ctx.runStatusLine({ phase: 'compacting', started: new Date().toISOString(), approvals: [] });
  assert.match(label, /正在压缩上下文/);
  assert.doesNotMatch(label, /正在处理/);
});

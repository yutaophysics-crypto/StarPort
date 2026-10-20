import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import { Workflows } from '../src/workflows.mjs';
import { CompanionClock } from '../src/companion-limits.mjs';

const minute = 60000;
const until = async check => { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('fixture timed out'); };
const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}), record() {} };

function fixture(t, saved = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-step-limits-')), store = new Store(join(dataDir, 'test.sqlite'));
  store.setSetting('workflows.settings', saved);
  let release, emit, stopCount = 0, logicalNow = 0, logicalActivity = 0, polls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const runner = new Runner(store, registry, () => {}, { codex: async args => {
    emit = args.emit;
    args.setControl({ stop: async () => { stopCount++; release(); } });
    emit({ type: 'activity', item: { id: 'comment', kind: 'text', text: '已检查输入，验证尚未完成。', status: 'complete' } });
    emit({ type: 'activity', item: { id: 'secret', kind: 'reasoning', text: 'PRIVATE_REASONING', status: 'complete' } });
    emit({ type: 'tool', id: 'read', name: 'Read', status: 'complete', input: { file_path: 'input.py' }, output: '已保存的工具结果' });
    await gate;
    if (args.signal.aborted) throw Object.assign(new Error('已停止'), { canceled: true });
    emit({ type: 'replace', text: '全部完成' }); emit({ type: 'final-answer', text: '全部完成' });
  } });
  const workflows = new Workflows({ store, runner, dataDir, clockFactory: options => {
    const clock = new CompanionClock({ ...options, startedAt: 0 });
    // Advance logical time without waiting 30 minutes or changing the live process clock.
    return { deadlineAt: null, get expired() { return clock.expired; }, snapshot: () => clock.snapshot(),
      poll: () => { polls++; return clock.poll(logicalNow, logicalActivity); } };
  } });
  const chat = store.newChat({ workspace: dataDir });
  workflows.createCompanion({ name: '测试伙伴', provider: 'codex' }, { id: 'test' });
  const user = store.message(chat.id, 'user', 'codex', '@测试伙伴 检查输入');
  const run = workflows.createRun(chat, { title: '时限测试', trigger: 'dispatch' });
  const step = { key: 's', companionId: 'test', companionName: '测试伙伴', order: 1, task: '检查输入', notes: [], status: 'waiting', attempt: 0 };
  run.card.details.workflowRun.steps.push(step);
  run.promise = workflows.runStep(run, chat, step, { mode: 'adhoc', rows: [step], outputs: [], userMessageId: user.id, cardId: run.card.id, text: user.content });
  t.after(async () => { release(); await run.promise; workflows.runs.clear(); await runner.close(); store.close(); });
  return { store, runner, workflows, run, step, release, get stopCount() { return stopCount; },
    ready: () => until(() => { if (step.status === 'failed') throw new Error(step.error); return !!emit && !!step.runtime; }),
    advance: async (now, active = false) => { const before = polls; logicalNow = now; if (active) logicalActivity = now; await until(() => polls > before); },
    activity: () => { logicalActivity = logicalNow; emit({ type: 'activity', item: { id: 'more', kind: 'text', text: '又完成一步，继续验证。', status: 'complete' } }); }
  };
}

test('legacy defaults cannot stop a real companion desk after 31 minutes of ongoing work', { timeout: 15000 }, async t => {
  const f = fixture(t, { stepMinutes: 30 }); await f.ready();
  assert.equal(f.workflows.settings().stepLimitEnabled, false);
  assert.equal(f.run.card.details.workflowRun.timeLimitMinutes, 0);
  await f.advance(31 * minute, true);
  assert.equal(f.stopCount, 0); assert.equal(f.step.status, 'running');
  assert.equal(f.step.runtime.deadlineAt, null);
  f.release(); await f.run.promise;
  assert.equal(f.step.status, 'done'); assert.equal(f.step.output, '全部完成');
});

test('a stalled companion is reminded without stopping and clears its stalled state on activity', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.ready();
  await f.advance(6 * minute);
  assert.equal(f.step.runtime.stalled, true); assert.match(f.step.notes.at(-1), /不会因无活动自动停止/);
  await f.advance(35 * minute);
  assert.equal(f.step.notes.filter(n => n.includes('未收到新活动')).length, 1);
  assert.equal(f.stopCount, 0); assert.equal(f.step.status, 'running');
  f.activity(); await f.advance(36 * minute, true);
  assert.equal(f.step.runtime.stalled, false); assert.match(f.step.notes.at(-1), /继续工作/);
  f.release(); await f.run.promise;
});

test('an explicit deadline warns, saves evidence, then stops only its own desk', { timeout: 15000 }, async t => {
  const f = fixture(t, { stepLimitEnabled: true, stepMinutes: 3 }); await f.ready();
  const unrelated = f.store.newChat({ workspace: process.cwd() });
  await f.advance(90 * 1000, true);
  assert.match(f.step.notes.at(-1), /即将达到你设置的 3 分钟时限/);
  assert.equal(f.step.checkpoint.reason, 'deadline-warning'); assert.equal(f.step.checkpoint.toolCount, 1);
  assert.equal(f.step.checkpoint.status, 'running'); assert.equal(f.stopCount, 0);
  await f.advance(3 * minute, true); await f.run.promise;
  assert.equal(f.stopCount, 1); assert.equal(f.step.status, 'failed');
  assert.match(f.step.error, /达到你设置的 3 分钟时限/);
  assert.match(f.step.output, /已检查输入，验证尚未完成/);
  assert.match(f.step.output, /已保存的工具结果/);
  assert.equal(f.step.output.includes('PRIVATE_REASONING'), false);
  const deskMessage = f.store.messageById(f.step.deskChatId, f.step.deskMessageId);
  assert.deepEqual(deskMessage.details.checkpoints.map(c => c.reason), ['deadline-warning', 'deadline']);
  assert.equal(deskMessage.details.tools[0].output, '已保存的工具结果');
  assert.equal(f.store.chat(unrelated.id).workspace, process.cwd());
});

test('users can still stop unlimited companion tasks', { timeout: 15000 }, async t => {
  const f = fixture(t); await f.ready();
  f.workflows.stopRun(f.run.id); await f.run.promise;
  assert.equal(f.step.status, 'stopped'); assert.equal(f.stopCount, 1);
});

test('settings preserve an explicit limit only when its switch was enabled', () => {
  const store = new Store(':memory:');
  try {
    const workflows = new Workflows({ store, runner: {}, dataDir: mkdtempSync(join(tmpdir(), 'hub-step-settings-')) });
    store.setSetting('workflows.settings', { stepMinutes: 30 });
    assert.equal(workflows.saveSettings({ stepMinutes: 60 }).stepLimitEnabled, false);
    assert.equal(workflows.saveSettings({ stepLimitEnabled: true, stepMinutes: 120 }).stepLimitEnabled, true);
    assert.equal(workflows.saveSettings({ verifyRetries: 2 }).stepLimitEnabled, true);
    assert.equal(workflows.saveSettings({ stepLimitEnabled: false }).stepLimitEnabled, false);
    assert.throws(() => workflows.saveSettings({ stepLimitEnabled: 'true' }), e => e.status === 400);
  } finally { store.close(); }
});

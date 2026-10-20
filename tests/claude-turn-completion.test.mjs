import test from 'node:test';
import assert from 'node:assert/strict';
import { runClaude } from '../src/adapters/claude.mjs';
import { parseClaudeEvent } from '../src/adapters/claude-events.mjs';
import { fileURLToPath } from 'node:url';

const base = { runtime: { command: process.execPath }, options: { permissionMode: 'default' },
  prompt: '请回答我的问题', cwd: process.cwd(), session: 'previous', setControl() {} };
const orphan = { type: 'system', subtype: 'task_notification', task_id: 'old-task', status: 'stopped',
  summary: "Background shell command didn't finish before the previous session ended" };
const emptyResult = { type: 'result', subtype: 'success', session_id: 'previous', is_error: false,
  result: '', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
const restartedTask = { ...orphan, reason: 'worker_restart', summary: 'A task from the previous worker stopped.' };
const aggregateTask = { ...orphan, summary: 'Orphaned by a previous Claude Code process exit and reported in an aggregate summary.' };

for (const [format, notice] of [['worker-restart', restartedTask], ['aggregate-summary', aggregateTask]]) {
  for (const interleaved of [false, true]) {
    test(`Claude waits for its answer after ${format}${interleaved ? ' interleaved with active output' : ''}`, async () => {
      const events = [];
      let inputs = 0, closed = false;
      const makeQuery = ({ prompt }) => ({ close() { closed = true; }, async *[Symbol.asyncIterator]() {
        const first = (await prompt[Symbol.asyncIterator]().next()).value; inputs++;
        yield notice;
        if (interleaved) yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: '本次回答' } } };
        yield emptyResult;
        assert.equal(closed, false, 'old task completion must not close the active request');
        yield { type: 'result', subtype: 'success', result: '本次回答已完成', num_turns: 1,
          user_message_uuids: [first.uuid] };
      } });
      await runClaude({ ...base, makeQuery, emit: e => events.push(e) });
      assert.equal(inputs, 1);
      assert.deepEqual(events.filter(e => e.type === 'final-answer').map(e => e.text), ['本次回答已完成']);
      assert.ok(!events.some(e => e.type === 'activity' && e.item.kind === 'task'));
      assert.equal(events.filter(e => e.code === 'claude-unrelated-result').length, 1);
    });
  }
}

test('actual SDK transport survives resumed-worker housekeeping without resending or closing early', async () => {
  const events = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    await runClaude({ ...base,
      runtime: { command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/claude-resume-turn.mjs', import.meta.url))] },
      signal: controller.signal, emit: e => events.push(e),
      sdkOptions: { persistSession: false, settingSources: [], env: { CLAUDECODE: undefined } } });
  } finally { clearTimeout(timer); }
  assert.deepEqual(events.filter(e => e.type === 'final-answer').map(e => e.text), ['The current request completed; input count: 1.']);
  assert.equal(events.filter(e => e.code === 'claude-unrelated-result').length, 1);
  assert.ok(!events.some(e => e.type === 'activity' && e.item.kind === 'task'));
});

for (const format of ['uuid', 'queued', 'legacy']) {
  test(`Claude waits past a previous-session notification result (${format})`, async () => {
    const events = [], inputs = [];
    let closed = 0, answered = false;
    const makeQuery = ({ prompt }) => ({ close() { closed++; }, async *[Symbol.asyncIterator]() {
      const input = prompt[Symbol.asyncIterator]();
      inputs.push((await input.next()).value);
      yield { type: 'system', subtype: 'init', session_id: 'previous' };
      yield orphan;
      yield { ...emptyResult, ...(format === 'uuid' ? { user_message_uuid: 'orphan-notification', user_message_uuids: ['orphan-notification'] }
        : format === 'queued' ? { queued_turn_count: 1 } : {}) };
      assert.equal(closed, 0);
      answered = true;
      yield { type: 'result', subtype: 'success', result: '这是本次问题的回答', num_turns: 1,
        ...(format === 'uuid' ? { user_message_uuid: inputs[0].uuid, user_message_uuids: [inputs[0].uuid] } : {}) };
    } });
    await runClaude({ ...base, makeQuery, emit: event => events.push(event) });
    assert.equal(answered, true, 'a housekeeping result must not finish the user request');
    assert.equal(closed, 1);
    assert.equal(inputs.length, 1, 'do not resend a potentially executing request');
    assert.match(inputs[0].uuid, /^[0-9a-f-]{36}$/);
    assert.equal(inputs[0].message.content, base.prompt);
    assert.equal(events.filter(e => e.type === 'final-answer').at(-1).text, '这是本次问题的回答');
    assert.ok(events.some(e => e.type === 'diagnostic' && e.code === 'claude-unrelated-result'));
    assert.ok(!events.some(e => e.type === 'activity' && e.item.kind === 'task'));
  });
}

test('Claude ignores a nonempty result for another send without replacing the answer', async () => {
  const events = [];
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield { type: 'result', subtype: 'success', result: '旧通知的结果', user_message_uuids: ['another-send'] };
    yield { type: 'result', subtype: 'success', result: '用户问题的回答', user_message_uuids: [first.uuid] };
  } });
  await runClaude({ ...base, makeQuery, emit: e => events.push(e) });
  assert.deepEqual(events.filter(e => e.type === 'final-answer').map(e => e.text), ['用户问题的回答']);
});

test('a stream ending after housekeeping is an explicit failure, never an empty success', async () => {
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    await prompt[Symbol.asyncIterator]().next(); yield orphan; yield emptyResult;
  } });
  await assert.rejects(runClaude({ ...base, makeQuery, emit() {} }), /本次请求.*完成/);
});

test('a real native failure still fails immediately after a previous-session notice', async () => {
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    await prompt[Symbol.asyncIterator]().next(); yield orphan;
    yield { ...emptyResult, is_error: true, result: 'Rate limit reached' };
    assert.fail('native failures must not be retried');
  } });
  await assert.rejects(runClaude({ ...base, makeQuery, emit() {} }), /Rate limit reached/);
});

test('a zero-work result bound to the actual send reports failure instead of a blank completion', async () => {
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield { ...emptyResult, user_message_uuids: [first.uuid] };
  } });
  await assert.rejects(runClaude({ ...base, makeQuery, emit() {} }), /未对本次请求产生回答/);
});

test('the user can stop while waiting past a housekeeping result without resending input', async () => {
  const controller = new AbortController();
  let release, control, sent = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const makeQuery = ({ prompt }) => ({ close() { release(); }, async *[Symbol.asyncIterator]() {
    await prompt[Symbol.asyncIterator]().next(); sent++;
    yield orphan; yield emptyResult;
    controller.abort(); await wait;
  } });
  await assert.rejects(runClaude({ ...base, makeQuery, signal: controller.signal,
    setControl: value => { control = value; }, emit() {} }), e => e.canceled === true);
  assert.equal(sent, 1);
  assert.equal(control.canSend(), false);
});

test('an explicit local slash-command completion is not mistaken for housekeeping', async () => {
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    await prompt[Symbol.asyncIterator]().next();
    yield { ...emptyResult, local_command: 'help' };
  } });
  await runClaude({ ...base, prompt: '/help', makeQuery, emit() {} });
});

test('previous-session task notices are informational; tasks started here keep their lifecycle', () => {
  for (const notice of [orphan, restartedTask, aggregateTask]) {
    const events = parseClaudeEvent(notice, {});
    assert.ok(events.some(e => e.type === 'notice' && e.text.includes('上一轮')));
    assert.ok(!events.some(e => e.type === 'activity'));
    const state = {};
    parseClaudeEvent({ type: 'system', subtype: 'task_started', task_id: notice.task_id, task_type: 'local_bash' }, state);
    assert.ok(parseClaudeEvent(notice, state).some(e => e.type === 'activity' && e.item.status === 'interrupted'));
  }
});

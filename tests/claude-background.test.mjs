import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../src/adapters/claude.mjs';

const base = { runtime: { command: process.execPath }, options: { permissionMode: 'default' },
  prompt: '帮我写一份工作流设置教程', cwd: process.cwd(), setControl() {} };
const usage = { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const init = { type: 'system', subtype: 'init', session_id: 'session', model: 'test' };
const agent = { task_id: 'agent-1', task_type: 'local_agent', description: 'Find workflow UI' };
const shell = { task_id: 'shell-1', task_type: 'local_bash', description: 'npm run dev' };
const started = task => ({ type: 'system', subtype: 'task_started', ...task, tool_use_id: 'call-' + task.task_id,
  subagent_type: task.task_type === 'local_agent' ? 'Explore' : undefined, is_backgrounded: true });
const level = (...tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
const done = task => ({ type: 'system', subtype: 'task_notification', task_id: task.task_id, status: 'completed', summary: 'done' });
const text = value => ({ type: 'assistant', message: { id: 'm-' + value.length, content: [{ type: 'text', text: value }] } });
const result = (value, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: value, num_turns: 1, usage, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const answers = events => events.filter(e => e.type === 'final-answer').map(e => e.text);
const taskStatus = (events, id) => events.filter(e => e.type === 'activity' && e.item.id === 'claude-task:' + id).at(-1)?.item.status;

test('a background agent keeps the turn open and its follow-up answer completes the same reply', async () => {
  const events = [];
  let closed = 0;
  const makeQuery = ({ prompt }) => ({ close() { closed++; }, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield init; yield started(agent); yield level(agent);
    yield text('正在查，查完后给你写教程。');
    yield result('正在查，查完后给你写教程。', { user_message_uuids: [first.uuid] });
    await tick();
    assert.equal(closed, 0, 'the CLI hosting the background agent must stay alive');
    assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.phase), ['background']);
    yield done(agent); yield level();
    yield init; yield text('教程如下。');
    yield result('教程如下。');
  } });
  await runClaude({ ...base, makeQuery, emit: e => events.push(e) });
  assert.deepEqual(answers(events), ['正在查，查完后给你写教程。', '教程如下。']);
  assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.phase), ['background', 'answering']);
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['正在查，查完后给你写教程。', '\n\n', '教程如下。']);
  assert.equal(taskStatus(events, agent.task_id), 'complete');
  assert.ok(!events.some(e => e.type === 'notice'));
  assert.equal(closed, 1);
});

test('without the level signal, task edges still hold the turn for a background agent', async () => {
  const events = [];
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield started(agent); yield result('稍等。', { user_message_uuids: [first.uuid] });
    yield done(agent); yield text('查到了。'); yield result('查到了。');
  } });
  await runClaude({ ...base, makeQuery, emit: e => events.push(e) });
  assert.equal(answers(events).at(-1), '查到了。');
});

test('background shells end with the turn, as under claude -p, and the reply says so', async () => {
  const events = [];
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield started(shell); yield level(shell);
    yield result('开发服务器已启动。', { user_message_uuids: [first.uuid] });
    assert.fail('a background shell must not hold the turn');
  } });
  await runClaude({ ...base, makeQuery, emit: e => events.push(e) });
  assert.equal(taskStatus(events, shell.task_id), 'interrupted');
  const notice = events.find(e => e.type === 'notice')?.text || '';
  assert.match(notice, /后台命令已随本轮停止：npm run dev/);
  assert.match(notice, /claude -p/);
});

test('Stop while waiting ends the wait, keeps the reply and marks the agent stopped', async () => {
  let control, release;
  const events = [], wait = new Promise(resolve => { release = resolve; });
  const makeQuery = ({ prompt }) => ({ close() { release(); }, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield started(agent); yield level(agent);
    yield result('正在查。', { user_message_uuids: [first.uuid] });
    await wait;
  } });
  const running = runClaude({ ...base, makeQuery, setControl: value => { control = value; }, emit: e => events.push(e) });
  await tick(); await tick();
  assert.equal(control.canSend(), true, 'the user may still add to the conversation while it waits');
  await control.stop();
  await running;
  assert.equal(control.canSend(), false);
  assert.equal(taskStatus(events, agent.task_id), 'interrupted');
  assert.equal(events.filter(e => e.type === 'subagent').at(-1).status, 'interrupted');
  assert.match(events.find(e => e.type === 'notice').text, /已停止等待后台任务.*Find workflow UI/);
});

test('a guidance message sent while waiting is answered and the wait continues', async () => {
  let control;
  const events = [];
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const input = prompt[Symbol.asyncIterator]();
    const first = (await input.next()).value;
    yield started(agent); yield level(agent);
    yield result('正在查。', { user_message_uuids: [first.uuid] });
    const guidance = (await input.next()).value;
    assert.equal(guidance.uuid, 'guide-1');
    yield { type: 'user', isReplay: true, uuid: guidance.uuid, message: guidance.message };
    yield text('收到补充。'); yield result('收到补充。', { user_message_uuids: [guidance.uuid] });
    await tick();
    assert.equal(events.filter(e => e.type === 'phase').at(-1).phase, 'background', 'still waiting for the agent after the guidance turn');
    yield done(agent); yield level(); yield text('最终教程。'); yield result('最终教程。');
  } });
  const running = runClaude({ ...base, makeQuery, setControl: value => { control = value; }, emit: e => events.push(e) });
  await tick(); await tick();
  await control.steer('顺便写上定时触发', { id: 'guide-1' });
  await running;
  assert.ok(events.some(e => e.type === 'input-consumed' && e.id === 'guide-1'));
  assert.equal(answers(events).at(-1), '最终教程。');
});

test('a finished agent without a follow-up turn settles instead of waiting forever', async () => {
  let release;
  const events = [], wait = new Promise(resolve => { release = resolve; });
  const makeQuery = ({ prompt }) => ({ close() { release(); }, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield started(agent); yield level(agent);
    yield result('正在查。', { user_message_uuids: [first.uuid] });
    yield done(agent); yield level();
    await wait;
  } });
  await runClaude({ ...base, makeQuery, backgroundSettleMs: 20, emit: e => events.push(e) });
  assert.deepEqual(answers(events), ['正在查。']);
  assert.ok(!events.some(e => e.type === 'notice'));
});

test('a failed follow-up turn is reported, not hidden behind the earlier reply', async () => {
  const makeQuery = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const first = (await prompt[Symbol.asyncIterator]().next()).value;
    yield started(agent); yield level(agent);
    yield result('正在查。', { user_message_uuids: [first.uuid] });
    yield done(agent); yield level();
    yield { ...result('Rate limit reached'), is_error: true, subtype: 'error_during_execution' };
  } });
  await assert.rejects(runClaude({ ...base, makeQuery, emit() {} }), /Rate limit reached/);
});

for (const mode of ['follow-up', 'silent']) {
  test(`actual SDK transport keeps the CLI for a background agent (${mode})`, async () => {
    const events = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      await runClaude({ ...base, backgroundSettleMs: 100,
        runtime: { command: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/claude-background-agent.mjs', import.meta.url)), mode] },
        signal: controller.signal, emit: e => events.push(e),
        sdkOptions: { persistSession: false, settingSources: [], env: { CLAUDECODE: undefined } } });
    } finally { clearTimeout(timer); }
    assert.equal(controller.signal.aborted, false);
    assert.deepEqual(answers(events), ['Looking it up; I will reply when it finishes.',
      ...(mode === 'follow-up' ? ['Here is the step-by-step tutorial.'] : [])]);
    assert.equal(taskStatus(events, agent.task_id), 'complete');
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CompanionClock, companionLimits, validateCompanionLimits, companionCheckpoint } from '../src/companion-limits.mjs';

const minute = 60000;
test('default and legacy saved durations never opt the user into stopping tasks', () => {
  for (const saved of [{}, { stepMinutes: 30 }, { stepMinutes: 180 }, { stepLimitEnabled: 'true', stepMinutes: 30 }])
    assert.equal(companionLimits(saved).stepLimitEnabled, false);
  assert.deepEqual(companionLimits({ stepLimitEnabled: true, stepMinutes: 120 }), { stepLimitEnabled: true, stepMinutes: 120 });
  assert.equal(companionLimits({ stepLimitEnabled: true, stepMinutes: -1 }).stepLimitEnabled, false);
  const old = companionLimits({ stepMinutes: 30 });
  assert.equal(validateCompanionLimits({ stepMinutes: 60 }, old).stepLimitEnabled, false, 'saving a duration without the explicit switch must not enable stopping');
});

test('only a boolean explicit switch enables a valid custom limit', () => {
  assert.deepEqual(validateCompanionLimits({ stepLimitEnabled: true, stepMinutes: 240 }), { stepLimitEnabled: true, stepMinutes: 240 });
  const enabled = { stepLimitEnabled: true, stepMinutes: 45 };
  assert.deepEqual(validateCompanionLimits({}, enabled), enabled);
  assert.equal(validateCompanionLimits({ stepLimitEnabled: false }, enabled).stepLimitEnabled, false);
  for (const stepMinutes of [0, 2, 241, 3.5, 'bad', Infinity]) assert.throws(() => validateCompanionLimits({ stepLimitEnabled: true, stepMinutes }), e => e.status === 400);
  for (const stepLimitEnabled of ['true', 1, null]) assert.throws(() => validateCompanionLimits({ stepLimitEnabled }), e => e.status === 400);
});

test('an unlimited task can keep working for hours without a warning or deadline', () => {
  const clock = new CompanionClock({ startedAt: 0 });
  assert.equal(clock.snapshot().deadlineAt, null);
  for (const now of [29, 30, 31, 240, 1000].map(n => n * minute)) assert.deepEqual(clock.poll(now, now), []);
  assert.equal(clock.expired, false);
});

test('long silence produces one reminder, never a deadline; resumed activity resets the reminder', () => {
  const clock = new CompanionClock({ startedAt: 0 });
  assert.deepEqual(clock.poll(4 * minute, 0), []);
  assert.deepEqual(clock.poll(5 * minute, 0).map(e => e.type), ['idle']);
  assert.deepEqual(clock.poll(40 * minute, 0), []);
  assert.equal(clock.expired, false);
  assert.equal(clock.snapshot().stalled, true);
  assert.deepEqual(clock.poll(41 * minute, 41 * minute).map(e => e.type), ['resumed']);
  assert.equal(clock.snapshot().stalled, false);
  assert.deepEqual(clock.poll(46 * minute, 41 * minute).map(e => e.type), ['idle']);
});

test('an explicitly limited task gets advance warning and one deadline, including while it is active', () => {
  const clock = new CompanionClock({ startedAt: 0, minutes: 30 });
  assert.deepEqual(clock.poll(27 * minute, 27 * minute), []);
  const warning = clock.poll(28 * minute, 28 * minute);
  assert.equal(warning[0].type, 'warning'); assert.equal(warning[0].remainingSeconds, 120);
  assert.deepEqual(clock.poll(29 * minute, 29 * minute), []);
  assert.deepEqual(clock.poll(30 * minute, 30 * minute).map(e => e.type), ['deadline']);
  assert.deepEqual(clock.poll(31 * minute, 31 * minute), []);
  assert.equal(clock.expired, true);
});

test('short limits warn before expiry; a late poll expires once without a misleading advance notice', () => {
  const short = new CompanionClock({ startedAt: 0, minutes: 3 });
  assert.deepEqual(short.poll(90 * 1000, 90 * 1000).map(e => e.type), ['warning']);
  const late = new CompanionClock({ startedAt: 0, minutes: 3 });
  assert.deepEqual(late.poll(4 * minute, 4 * minute).map(e => e.type), ['deadline']);
  assert.deepEqual(late.poll(6 * minute, 4 * minute), []);
});

test('a checkpoint preserves public evidence references and actual tool statuses without reasoning or mutation', () => {
  const message = { id: 'm', chat_id: 'desk', status: 'running', content: '部分回复', details: {
    activity: [{ id: 'secret', kind: 'reasoning', text: 'PRIVATE_REASONING' }, { id: 'comment', kind: 'text', text: '已检查输入，等待验证。' },
      { id: 'tool', kind: 'tool', name: 'Read', status: 'running' }],
    tools: [{ id: 'tool', name: 'Read', status: 'error' }]
  } };
  const before = JSON.stringify(message), saved = companionCheckpoint(message, 'deadline-warning', 1000);
  assert.equal(saved.preview, '已检查输入，等待验证。');
  assert.deepEqual(saved.latestTool, { name: 'Read', status: 'error' });
  assert.equal(saved.toolCount, 1); assert.equal(saved.chatId, 'desk'); assert.equal(saved.messageId, 'm');
  assert.equal(saved.status, 'running'); assert.equal(JSON.stringify(saved).includes('PRIVATE_REASONING'), false);
  assert.equal(JSON.stringify(message), before);
});

test('limit policy and runtime reminders are available in English while provider diagnostics remain intact', () => {
  const context = vm.createContext({ localStorage: { getItem() {}, setItem() {} } });
  vm.runInContext(readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8'), context);
  const i18n = context.StarportI18n; i18n.setLanguage('en');
  assert.equal(i18n.t('不限总时长'), 'No time limit');
  assert.match(i18n.notice('连续 5 分钟未收到新活动，任务仍在运行；不会因无活动自动停止。'), /will not be stopped for inactivity/);
  assert.match(i18n.notice('即将达到你设置的 30 分钟时限，剩余约 2 分钟；到时将停止，已有进度和执行记录会保留。'), /30-minute limit.*2 minutes left/);
  assert.match(i18n.notice('达到你设置的 30 分钟时限，已停止；进度和执行记录已保留。'), /Progress and activity have been kept/);
  const raw = 'Provider: native failure E_123'; assert.equal(i18n.notice(raw), raw);
});

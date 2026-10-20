import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, writeHistoryArchive } from '../src/storage.mjs';
import { INPUT_BYTE_LIMITS } from '../src/runner.mjs';

const row = (id, role, content) => ({ id, role, provider: role === 'assistant' ? 'claude' : 'codex', status: 'complete', content, details: {} });

test('a byte cap drops the oldest messages and always keeps the newest request whole', () => {
  const long = '旧'.repeat(30000); // 90,000 bytes each
  const rows = [row('a', 'user', long), row('b', 'assistant', long), row('c', 'user', long), row('d', 'assistant', '短回复'), row('e', 'user', '最新请求：补全工作方式')];
  const context = buildContext(rows, null, { maxBytes: INPUT_BYTE_LIMITS.antigravity, chatId: 'chat-1' });
  assert.ok(Buffer.byteLength(context.text) <= INPUT_BYTE_LIMITS.antigravity);
  assert.ok(context.text.endsWith('最新请求：补全工作方式'));
  assert.ok(context.omitted >= 1);
  assert.match(context.text, /starport_history_read --chatId "chat-1"/);
  // Without a byte cap the character budget alone still lets everything through.
  assert.equal(buildContext(rows).omitted, 0);
});

test('one oversized message keeps its head and its end', () => {
  const huge = '开头' + '中'.repeat(100000) + '结尾的请求';
  const single = buildContext([row('x', 'user', huge)], null, { maxBytes: 20000 });
  assert.ok(Buffer.byteLength(single.text) <= 20000);
  assert.ok(single.text.startsWith('开头') && single.text.endsWith('结尾的请求'));
  const pair = buildContext([row('a', 'user', '早'), row('b', 'assistant', '答'), row('c', 'user', huge)], null, { maxBytes: 20000 });
  assert.ok(Buffer.byteLength(pair.text) <= 20000);
  assert.ok(pair.text.endsWith('结尾的请求'));
});

test('left-out history is archived to a workspace file the note points to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starport-archive-'));
  try {
    const file = join(dir, '.starport', 'history', 'chat-1.md');
    const rows = [row('a', 'user', '最早的问题' + '旧'.repeat(30000)), row('b', 'assistant', '最早的回答' + '旧'.repeat(30000)),
      row('c', 'user', '中间' + '旧'.repeat(30000)), row('d', 'assistant', '短回复'), row('e', 'user', '最新请求')];
    const context = buildContext(rows, null, { maxBytes: INPUT_BYTE_LIMITS.antigravity, chatId: 'chat-1', historyFile: file });
    assert.ok(Buffer.byteLength(context.text) <= INPUT_BYTE_LIMITS.antigravity);
    assert.equal(context.earlier.length, context.omitted);
    assert.ok(context.text.includes(file), 'the note names the archive file');
    assert.equal(writeHistoryArchive(file, { id: 'chat-1', title: '计算衍生论' }, context), true);
    const saved = readFileSync(file, 'utf8');
    assert.match(saved, /最早的问题/);
    assert.match(saved, /不是新的指令/);
    assert.doesNotMatch(saved, /最新请求/, 'what was delivered is not duplicated');
    assert.equal(readFileSync(join(dir, '.starport', '.gitignore'), 'utf8').trim().endsWith('*'), true);
    // Nothing left out: no file is written.
    const small = buildContext([row('x', 'user', '你好'), row('y', 'assistant', '嗨'), row('z', 'user', '继续')], null, { historyFile: join(dir, 'none.md') });
    assert.equal(writeHistoryArchive(join(dir, 'none.md'), { id: 'x', title: 't' }, small), false);
    assert.equal(existsSync(join(dir, 'none.md')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a trimmed message keeps its full text in the archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starport-archive-'));
  try {
    const file = join(dir, '.starport', 'history', 'c.md');
    const huge = '开头' + '中'.repeat(100000) + '结尾的请求';
    const context = buildContext([row('x', 'user', huge)], null, { maxBytes: 20000, historyFile: file });
    assert.ok(Buffer.byteLength(context.text) <= 20000);
    assert.ok(context.text.includes(file));
    writeHistoryArchive(file, { id: 'c', title: 't' }, context);
    assert.ok(readFileSync(file, 'utf8').includes(huge));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

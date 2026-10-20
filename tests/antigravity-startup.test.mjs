import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from '../src/adapters/cli.mjs';
import { temporaryAntigravityStartup, withAntigravityStartupRetry } from '../src/adapters/antigravity-startup.mjs';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';

const failure = 'Eligibility check failed: failed to fetch user info: 500 Internal Server Error';
test('only explicit transient eligibility bootstrap errors are eligible for retry', () => {
  for (const code of [500, 502, 503, 504]) assert.equal(temporaryAntigravityStartup(failure.replace('500', code)), true);
  assert.equal(temporaryAntigravityStartup('Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF'), true);
  for (const text of ['HTTP 500', 'API error (attempt 1): INTERNAL (code 500)', failure.replace('500', '403'), failure.replace('500', '401'), failure.replace('500', '429'), 'Eligibility check failed: not eligible (500)', 'Eligibility check failed: account disabled (500)']) assert.equal(temporaryAntigravityStartup(text), false, text);
});

test('retry is bounded with backoff and plain errors never retry', async () => {
  const waits = [], events = []; let attempts = 0;
  await assert.rejects(() => withAntigravityStartupRetry(async () => { attempts++; throw Object.assign(new Error(failure), { antigravityStartupFailure: true }); }, { wait: async ms => waits.push(ms), emit: event => events.push(event) }), error => error.antigravityStartupFailure && /重试 2 次/.test(error.message));
  assert.equal(attempts, 3); assert.deepEqual(waits, [1000, 3000]); assert.equal(events.filter(e => e.type === 'diagnostic').length, 3);
  attempts = 0;
  await assert.rejects(() => withAntigravityStartupRetry(async () => { attempts++; throw new Error('API error 500 after output'); }), /after output/); assert.equal(attempts, 1);
});

async function fixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'agy-startup-')), file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ launches: 0, prompts: [] })); t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = { command: process.execPath, prefixArgs: [resolve('tests/fixtures/antigravity-startup-cli.mjs'), file, mode] };
  return { runtime, state: async () => JSON.parse(await readFile(file, 'utf8')), run: extra => runCli({ provider: 'antigravity', runtime, options: { mode: 'plan' }, session: 'existing-session', prompt: 'initial', cwd: process.cwd(), emit() {}, setControl() {}, ...extra }) };
}

test('fresh process retry preserves queued guidance and delivers each prompt exactly once', { timeout: 7000 }, async t => {
  const f = await fixture(t, 'recover'), events = []; let queued = false;
  await f.run({ emit: event => events.push(event), setControl: control => { if (!queued) { queued = true; control.steer('guidance', { id: 'input-1' }); } } });
  assert.deepEqual(await f.state(), { launches: 2, prompts: ['initial', 'guidance'] });
  assert.deepEqual(events.filter(e => e.type === 'replace').map(e => e.text), ['OK initial', 'OK guidance']);
  assert.equal(events.filter(e => e.type === 'input-consumed').length, 1); assert.ok(events.some(e => e.type === 'notice' && /已恢复/.test(e.text)));
});

test('a zero-turn stream-json refusal on stdout is retried like the stderr form', { timeout: 7000 }, async t => {
  const f = await fixture(t, 'json-recover'), events = [];
  await f.run({ emit: event => events.push(event) });
  assert.deepEqual(await f.state(), { launches: 2, prompts: ['initial'] });
  assert.equal(events.filter(e => e.type === 'replace').at(-1).text, 'OK initial');
  assert.ok(events.some(e => e.type === 'diagnostic' && e.kind === 'antigravity-startup-temporary'));
});

for (const mode of ['forbidden', 'executed', 'raw-output', 'json-after-step']) test('never replays an access refusal or any stdout: ' + mode, async t => {
  const f = await fixture(t, mode);
  await assert.rejects(() => f.run(), error => !error.antigravityStartupFailure);
  assert.equal((await f.state()).launches, 1);
});

test('stop interrupts backoff promptly and no extra native process is started', { timeout: 2500 }, async t => {
  const f = await fixture(t, 'cancel'); let control;
  await assert.rejects(() => f.run({ setControl: value => control = value, emit: event => { if (event.type === 'notice') control.stop(); } }), error => error.canceled && error.antigravityStartupFailure);
  assert.equal((await f.state()).launches, 1);
});

test('unrecovered startup keeps the existing native session and cursor; tools never get replayed', { timeout: 9000 }, async t => {
  const f = await fixture(t, 'exhaust'), store = new Store(':memory:'); t.after(() => store.close());
  const registry = { resolve: () => f.runtime, probe: async () => ({}), record() {} };
  let first = true;
  const runner = new Runner(store, registry, () => {}, { antigravity: async args => {
    if (first) { first = false; args.emit({ type: 'session', id: 'prior-native' }); args.emit({ type: 'replace', text: 'prior completed response' }); }
    else await runCli(args);
  } });
  t.after(() => runner.close());
  const chat = store.newChat({ provider: 'antigravity', workspace: process.cwd() });
  await runner.start(chat.id, 'prior user'); await runner.active.get(chat.id).done;
  const session = { ...store.session(chat.id, 'antigravity') };
  await runner.start(chat.id, 'new user'); await runner.active.get(chat.id).done;
  assert.deepEqual({ ...store.session(chat.id, 'antigravity') }, session);
  assert.equal(store.messages(chat.id).length, 4); assert.equal(store.lastAssistant(chat.id).status, 'error');
  assert.match(store.lastAssistant(chat.id).details.error, /重试 2 次/);
  assert.equal((await f.state()).launches, 3); assert.deepEqual((await f.state()).prompts, []);
});

test('ordinary mid-turn errors still clear an unsafe native session', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}), record() {} };
  let first = true;
  const runner = new Runner(store, registry, () => {}, { antigravity: async args => { args.emit({ type: 'session', id: 'native' }); if (!first) throw new Error(failure); first = false; args.emit({ type: 'replace', text: 'done' }); } });
  t.after(() => runner.close());
  const chat = store.newChat({ provider: 'antigravity', workspace: process.cwd() });
  await runner.start(chat.id, 'one'); await runner.active.get(chat.id).done;
  await runner.start(chat.id, 'two'); await runner.active.get(chat.id).done;
  assert.equal(store.session(chat.id, 'antigravity'), undefined);
});

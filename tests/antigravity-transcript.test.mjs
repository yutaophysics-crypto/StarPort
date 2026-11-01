import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { runCli } from '../src/adapters/cli.mjs';
import { mergeActivity } from '../src/activity.mjs';
import { transcriptEntry, transcriptEvents, transcriptReady } from '../src/adapters/antigravity-transcript.mjs';

const runtime = { command: process.execPath, prefixArgs: [resolve('tests/fixtures/antigravity-transcript-cli.mjs')] };
const session = 'cd5fff48-e25b-4a76-991c-349b7e1adcb2';
async function turn({ home = mkdtempSync(join(tmpdir(), 'starport-agy-home-')), pause = 0, base = 0, resumed = null } = {}) {
  const events = [], activity = [];
  await runCli({ provider: 'antigravity', runtime, options: { mode: 'auto' }, session: resumed, prompt: 'read notes', cwd: process.cwd(), nativeHome: home,
    contextEnv: { AGY_FIXTURE_HOME: home, AGY_FIXTURE_PAUSE: String(pause), AGY_FIXTURE_BASE: String(base) },
    setControl: () => {}, emit: event => { events.push(event); if (event.type === 'tool' || event.type === 'activity') mergeActivity(activity, event); } });
  return { events, activity, home };
}
const shape = rows => rows.map(row => `${row.id} ${row.kind}${row.name ? ' ' + row.name : ''}`);

test('agy thought summaries go in front of their steps and whole tool results replace the stream count', { timeout: 20000 }, async () => {
  const { activity } = await turn();
  assert.deepEqual(shape(activity), ['agy:1:thinking thinking', 'agy:1 text', 'agy:2 tool read_file', 'agy:3:thinking thinking', 'agy:3 text']);
  assert.equal(activity[0].text, 'The answer needs both values, so read the file first.');
  assert.equal(activity[0].status, 'complete');
  assert.equal(activity[2].output, 'Showing lines 1-2 of 2\n1: alpha=3\n2: beta=4');
  assert.deepEqual(activity[2].input, { Path: 'D:\\work\\notes.txt' });
});

test('agy transcript records reach the reply while the turn is still running', { timeout: 20000 }, async () => {
  const { events } = await turn({ pause: 2600 });
  const at = predicate => events.findIndex(predicate);
  const lastStep = at(e => e.type === 'delta' && e.text === 'alpha * beta = 12');
  assert.ok(at(e => e.item?.id === 'agy:1:thinking') < lastStep, 'the first thought arrives before the turn goes on');
  assert.ok(at(e => e.type === 'tool' && e.output?.startsWith('Showing lines')) < lastStep, 'the whole read result arrives before the turn goes on');
});

test('a resumed agy conversation relays only what this turn appends to its transcript', { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'starport-agy-home-')), logs = join(home, 'brain', session, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'transcript_full.jsonl'), JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'An earlier turn' }) + '\n');
  const { activity, events } = await turn({ home, base: 10, resumed: session });
  assert.equal(events.some(e => e.item?.text === 'An earlier turn'), false);
  assert.deepEqual(shape(activity).filter(row => row.includes('thinking')), ['agy:11:thinking thinking', 'agy:13:thinking thinking']);
  assert.match(readFileSync(join(logs, 'transcript_full.jsonl'), 'utf8'), /An earlier turn/, 'agy keeps its own record; Starport only reads it');
});

test('a whole result waits for the stream to finish its step and never replaces real output', () => {
  const output = transcriptEntry({ step_index: 2, type: 'GENERIC', content: 'Created At: x\nCompleted At: y\nfull' });
  assert.deepEqual(output, { step: 2, output: 'full' });
  const tools = new Map([['agy:2', { output: undefined, done: false }]]);
  assert.equal(transcriptReady(output, new Set(['agy:2']), tools), false);
  assert.equal(transcriptReady(output, new Set(['agy:2']), tools, true), true, 'agy has exited: no later stream update can follow');
  const earlier = { step: 1, thinking: 'a step this turn never streamed' };
  assert.equal(transcriptReady(earlier, new Set(['agy:2']), tools, true), false);
  assert.equal(transcriptReady({ step: 7, output: 'x' }, new Set(), tools, true), false);
  tools.get('agy:2').done = true;
  assert.equal(transcriptReady(output, new Set(['agy:2']), tools), true);
  assert.deepEqual(transcriptEvents(output, tools), [{ type: 'tool', id: 'agy:2', output: 'full' }]);
  const command = new Map([['agy:2', { output: 'real command output', done: true }]]);
  assert.deepEqual(transcriptEvents(output, command), []);
  assert.equal(transcriptEntry({ step_index: 4, type: 'PLANNER_RESPONSE', thinking: '  ' }), null);
  assert.equal(transcriptEntry({ type: 'PLANNER_RESPONSE', thinking: 'no step' }), null);
});

test('a row placed before another keeps its place when later updates arrive', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  mergeActivity(rows, { type: 'activity', before: 'b', item: { id: 'b:thinking', kind: 'thinking', text: 'x' } });
  mergeActivity(rows, { type: 'activity', before: 'missing', item: { id: 'c' } });
  mergeActivity(rows, { type: 'activity', before: 'a', item: { id: 'b:thinking', status: 'complete' } });
  assert.deepEqual(rows.map(row => row.id), ['a', 'b:thinking', 'b', 'c']);
  assert.equal('before' in rows[1], false);
});

test('the process view skips empty response steps and names the file an agy step works on', () => {
  const ctx = vm.createContext({ localStorage: { getItem() {}, setItem() {} }, document: {} });
  for (const file of ['activity-model.js', 'activity.js']) vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), ctx);
  const el = (tag, attrs = {}, children = []) => {
    const node = { tag, attrs, children: [], dataset: {}, append(...items) { this.children.push(...items.filter(x => x != null)); } };
    node.append(...children); return node;
  };
  const nodes = root => root && typeof root === 'object' ? [root, ...root.children.flatMap(nodes)] : [];
  const message = { id: 'm', provider: 'antigravity', status: 'running', created: new Date().toISOString(), content: '', details: { activity: [
    { id: 'agy:1:thinking', kind: 'thinking', text: 'Read the file first.', status: 'complete' },
    { id: 'agy:1', kind: 'text', nativeType: 'agent_response', status: 'complete' },
    { id: 'agy:2', kind: 'tool', name: 'read_file', input: { Path: 'D:\\work\\notes.txt', StartLine: 1 }, status: 'complete' },
    { id: 'agy:3', kind: 'tool', name: 'run_command', input: { CommandLine: 'npm test' }, status: 'running' }] } };
  assert.equal(ctx.StarportActivityModel.entries(message).length, 3);
  const all = nodes(ctx.StarportActivity.render(message, { el, t: s => s, markdown: s => el('p', { text: s }), chatId: 'c' }));
  const text = cls => all.filter(n => n.attrs.class === cls).map(n => n.attrs.text);
  assert.deepEqual(text('native-name'), ['思考摘要', 'read_file', 'run_command']);
  assert.deepEqual(text('native-preview'), ['Read the file first.', 'D:\\work\\notes.txt', 'npm test']);
});

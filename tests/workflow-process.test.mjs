import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Store } from '../src/storage.mjs';
import { Workflows } from '../src/workflows.mjs';
import { handleWorkflowRoutes } from '../src/workflows/routes.mjs';

const source = file => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');

// A small DOM: enough for el(), activity.js, the run cards and the conversation's row reconcile.
function dom() {
  const camel = key => key.replace(/-(\w)/g, (m, c) => c.toUpperCase());
  class Node {
    constructor(tag) {
      Object.assign(this, { tag, children: [], attrs: {}, dataset: {}, className: '', parent: null, textContent: '' });
    }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { const list = this.parent?.children || []; return list[list.indexOf(this) + 1] || null; }
    get childNodes() { return this.children; }
    get isConnected() { return true; }
    detach() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    append(...nodes) { for (const node of nodes) if (node != null && node !== false && node !== '') this.insertBefore(typeof node === 'string' ? text(node) : node, null); }
    insertBefore(node, ref) { node.detach?.(); const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, node); node.parent = this; }
    remove() { this.detach(); }
    replaceChildren(...nodes) { for (const node of [...this.children]) node.detach?.(); this.append(...nodes); }
    replaceWith(node) { const parent = this.parent; if (!parent) return; parent.insertBefore(node, this); this.detach(); }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key.startsWith('data-')) this.dataset[camel(key.slice(5))] = String(value); }
    getAttribute(key) { return this.attrs[key]; }
    addEventListener() {}
    closest() { return null; }
    contains(node) { return all(this).includes(node); }
    getClientRects() { return [1]; }
    focus() {}
    get classList() { return { add: (...names) => { this.className += ' ' + names.join(' '); }, contains: name => this.className.split(/\s+/).includes(name), toggle() {}, remove() {} }; }
    querySelectorAll(selector) {
      const desk = /^\[data-desk-key="(.+)"\]$/.exec(selector);
      return all(this).slice(1).filter(node => desk ? node.attrs?.['data-desk-key'] === desk[1]
        : selector === 'details[data-disclosure-key]' ? node.tag === 'details' && node.attrs?.['data-disclosure-key']
        : selector === '[data-activity-focus]' ? node.dataset?.activityFocus : false);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const text = value => ({ tag: '#text', textContent: value, detach() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } });
  const all = node => [node, ...(node.children || []).flatMap(all)];
  const body = new Node('body');
  const document = { body, activeElement: null, createElement: tag => new Node(tag), createTextNode: text, addEventListener() {},
    querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector) };
  return { document, body, all, words: root => all(root).map(node => node.textContent || '').join('\n') };
}

test('a desk turn is read with the prompt that opened it, and the live turn wins while it runs', () => {
  const store = new Store(':memory:');
  const desk = store.newChat({ provider: 'codex', workspace: process.cwd() });
  store.message(desk.id, 'user', 'codex', 'first prompt');
  const first = store.message(desk.id, 'assistant', 'codex', 'first answer');
  store.message(desk.id, 'user', 'codex', 'second prompt');
  const second = store.message(desk.id, 'assistant', 'codex', 'second answer', 'running');
  const workflows = { store, runner: { active: new Map() } };
  const turn = (id, w = workflows) => Workflows.prototype.deskTurn.call(w, desk.id, id);
  assert.equal(turn(first.id).prompt, 'first prompt');
  assert.equal(turn(first.id).message.content, 'first answer');
  assert.equal(turn(second.id).prompt, 'second prompt');
  const live = { ...second, content: 'streaming…' };
  assert.equal(turn(second.id, { store, runner: { active: new Map([[desk.id, { message: live }]]) } }).message.content, 'streaming…');
  assert.throws(() => turn('missing'), error => error.status === 404);
  assert.throws(() => turn(store.messages(desk.id)[0].id), error => error.status === 404);
});

test('the desk-turn route passes both ids through', async () => {
  const calls = [];
  const result = await handleWorkflowRoutes({ deskTurn: (desk, id) => (calls.push([desk, id]), { prompt: 'p' }) }, 'GET', '/api/desks/d-1/turns/m-2', async () => ({}));
  assert.deepEqual(calls, [['d-1', 'm-2']]);
  assert.equal(result.data.prompt, 'p');
  assert.equal(await handleWorkflowRoutes({}, 'POST', '/api/desks/d-1/turns/m-2', async () => ({})), null);
});

test('the live stream hands other chats\' turns to run cards and says which chat a refresh is about', () => {
  const context = vm.createContext({});
  const desk = [];
  context.StarportWorkflows = { deskMessage: (chatId, message) => desk.push([chatId, message.id]) };
  vm.runInContext(source('live.js'), context);
  const listeners = new Map();
  const events = { addEventListener: (type, fn) => listeners.set(type, fn), close() {} };
  const state = { chat: { id: 'chat' }, messages: [], run: null, active: [] };
  const refreshes = [];
  context.StarportLive.create({ state, api: async () => ({}), viewRevision: () => 0, events, onRefresh: data => refreshes.push(data), document: null, window: null, setInterval: () => 1, clearInterval() {} });
  const turn = { id: 'turn', role: 'assistant', status: 'running', created: '2026-10-27T00:00:00Z', content: '', details: {} };
  listeners.get('message')({ data: JSON.stringify({ chatId: 'desk', message: turn }) });
  listeners.get('message')({ data: JSON.stringify({ chatId: 'chat', message: { ...turn, id: 'own' } }) });
  assert.deepEqual(desk, [['desk', 'turn']]);
  assert.deepEqual(state.messages.map(m => m.id), ['own']);
  listeners.get('refresh')({ data: JSON.stringify({ chatId: 'desk' }) });
  listeners.get('refresh')({ data: '' });
  assert.equal(JSON.stringify(refreshes), JSON.stringify([{ chatId: 'desk' }, {}]));
});

function cards(api = async () => ({}), workflowState = () => ({})) {
  const { document, body, all, words } = dom();
  const calls = [];
  const context = vm.createContext({ document, window: { addEventListener() {} }, state: { providers: [], chat: { id: 'chat' }, messages: [] },
    Date, URLSearchParams, setTimeout, clearTimeout, CSS: { escape: value => value }, localStorage: { getItem: () => 'zh', setItem() {} },
    toast() {}, renderMessages() {}, api: async (path, ...rest) => { calls.push(path); return path === '/workflows/state' ? { companions: [], rooms: {}, workflows: [], mounts: [], settings: {}, defaults: {}, ...workflowState() } : api(path, ...rest); } });
  context.globalThis = context;
  for (const file of ['i18n.js', 'ui-kit.js', 'live.js', 'activity-model.js', 'activity.js', 'workflows.js', 'workflow-cards.js', 'workflow-process.js'])
    vm.runInContext(source(file), context);
  context.StarportI18n.setLanguage('zh');
  const W = context.StarportWorkflows;
  const draw = run => { const card = W.renderCard({ id: 'm', details: { workflowRun: run } }); body.replaceChildren(card); return card; };
  return { W, draw, all, words, calls, body };
}
const step = (status, extra = {}) => ({ key: 's', companionId: 'c1', companionName: 'Opus', provider: 'claude', model: 'opus', status,
  started: '2026-10-27T10:00:00Z', ended: status === 'running' ? undefined : '2026-10-27T10:05:00Z', deskChatId: 'desk', deskMessageId: 'turn', output: status === 'done' ? '我负责：查文献\n结论在这里' : '', notes: [], ...extra });
const run = s => ({ id: 'r', title: 'test', trigger: 'dispatch', started: '2026-10-27T10:00:00Z', status: s.status === 'running' ? 'running' : 'done', steps: [s] });
const liveTurn = (status, extra = {}) => ({ id: 'turn', role: 'assistant', provider: 'claude', status, created: '2026-10-27T10:00:00Z', content: 'partial answer',
  details: { activity: [{ id: 't1', kind: 'tool', name: 'Read', status: 'complete', input: 'a.md' }, { id: 't2', kind: 'tool', name: 'Bash', status: status === 'running' ? 'running' : 'complete', input: 'ls' }], ...extra } });

test('a companion step shows its process inline, closed, the way the main model does', () => {
  const f = cards();
  const card = f.draw(run(step('running')));
  const block = f.all(card).find(node => node.className === 'wf-step-process');
  assert.ok(block, 'inline process block');
  const details = f.all(block).find(node => node.tag === 'details' && node.className === 'native-workflow');
  assert.equal(details.open, false);
  assert.match(f.words(block), /正在思考/);
  assert.equal(f.all(card).some(node => node.textContent === '过程'), false, 'no separate desk button');
  // No desk yet (waiting for its turn): no block.
  assert.equal(f.all(f.draw(run(step('running', { deskChatId: null })))).some(node => node.className === 'wf-step-process'), false);
});

test('live desk packets fill the block; the answer streams there only while the step runs', () => {
  const f = cards();
  f.draw(run(step('running')));
  f.W.deskMessage('desk', liveTurn('running'));
  f.W.deskMessage('other-desk', { ...liveTurn('running'), id: 'turn' });
  let card = f.draw(run(step('running')));
  assert.match(f.words(card), /2 个步骤/);
  assert.match(f.words(card), /partial answer/);
  f.W.deskMessage('desk', liveTurn('complete', { finalAnswer: 'partial answer' }));
  card = f.draw(run(step('done')));
  const block = f.all(card).find(node => node.className === 'wf-step-process');
  assert.match(f.words(block), /查看任务过程/);
  assert.doesNotMatch(f.words(block), /partial answer/);
});

test('a turn whose end the stream missed follows the step, and opening it reads the turn and its prompt', async () => {
  const f = cards(async path => path === '/desks/desk/turns/turn' ? { prompt: '完整提示原文', message: liveTurn('complete') } : {});
  f.draw(run(step('done')));
  f.W.deskMessage('desk', liveTurn('running'));
  const card = f.draw(run(step('done')));
  const details = f.all(card).find(node => node.tag === 'details' && node.className === 'native-workflow');
  assert.match(f.words(details), /查看任务过程/);
  assert.doesNotMatch(f.words(details), /正在思考/);
  details.open = true;
  details.ontoggle();
  assert.ok(f.calls.includes('/desks/desk/turns/turn'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(f.words(f.body), /完整提示原文/);
  assert.match(f.words(f.body), /交给 Opus 的完整提示/);
  assert.match(f.words(f.body), /无人值守/);
});

test('a card is redrawn for its own companions and toggles, not for other work going on', async () => {
  let state = { companions: [{ id: 'c1', name: 'Opus', avatar: 'O' }, { id: 'c2', name: 'Sol', avatar: 'S' }], running: [] };
  const f = cards(undefined, () => state);
  await f.W.load();
  const msg = { id: 'm', details: { workflowRun: run(step('running')) } };
  const before = f.W.cardContext(msg);
  state = { ...state, running: [{ companions: ['c2'], steps: [{ companionId: 'c2', started: '2026-10-27T10:01:00Z' }] }],
    companions: [state.companions[0], { id: 'c2', name: 'Sol', avatar: 'Σ' }] };
  await f.W.load();
  assert.equal(f.W.cardContext(msg), before, 'another companion at work');
  state = { ...state, companions: [{ id: 'c1', name: 'Opus', avatar: 'Ω' }, state.companions[1]] };
  await f.W.load();
  assert.notEqual(f.W.cardContext(msg), before, 'its own companion avatar');
  // Opening a long output is this card's own toggle.
  const long = { id: 'm', details: { workflowRun: run(step('done', { output: '我负责：写\n' + 'x'.repeat(1200) })) } };
  const closed = f.W.cardContext(long);
  const card = f.draw(long.details.workflowRun);
  f.all(card).find(node => node.textContent === '展开全文').onclick();
  assert.notEqual(f.W.cardContext(long), closed);
});

test('the conversation redraws only rows whose message or surroundings changed', () => {
  const { document, all } = dom();
  const root = document.createElement('div');
  const rebuilt = [];
  const context = vm.createContext({ document, window: { addEventListener() {} },
    $: selector => selector === '#messages' ? root : { scrollHeight: 0, scrollTop: 0, clientHeight: 0, scrollTo() {} },
    state: { chat: { id: 'chat', title: 'T', options: {} }, chats: [], messages: [] },
    StarportLive: { orderedMessages: messages => messages },
    StarportActivity: { render: msg => { rebuilt.push(msg.id); return document.createElement('div'); }, remember() {}, restoreFocus() {} },
    provider: () => ({ name: 'Codex' }), mark: () => null, t: value => value, notice: value => value, i18n: { language: 'zh', locale: 'zh-CN' },
    renderRun() {}, markViewed() {} });
  context.globalThis = context;
  vm.runInContext(source('ui-kit.js'), context);
  context.el = context.StarportUI.el;
  vm.runInContext(source('app-messages.js'), context);
  // The composer and status line are not part of this test.
  Object.assign(context, { renderRun() {}, markViewed() {} });
  const msg = (id, content, status = 'complete') => ({ id, role: 'assistant', provider: 'codex', status, content, created: '2026-10-27T10:00:00Z', details: {} });
  context.state.messages = [msg('a', 'one'), msg('b', 'two', 'running')];
  context.renderMessages();
  const [a, b] = root.children;
  assert.deepEqual(rebuilt, ['a', 'b']);
  // The running reply changes; the finished one is kept as is, even when refetched as a new object.
  const inserted = [];
  const insert = root.insertBefore.bind(root);
  root.insertBefore = (node, ref) => (inserted.push(node.attrs['data-message-id']), insert(node, ref));
  context.state.messages = [msg('a', 'one'), msg('b', 'two and more', 'running'), msg('c', 'three')];
  context.renderMessages();
  assert.deepEqual(inserted, ['b', 'c']);
  assert.deepEqual(rebuilt, ['a', 'b', 'b', 'c']);
  assert.equal(root.children[0], a);
  assert.notEqual(root.children[1], b);
  assert.deepEqual(root.children.map(node => node.attrs['data-message-id']), ['a', 'b', 'c']);
  // A changed row near the top is replaced in place; the rows after it are not moved.
  const [, b2, c] = root.children;
  context.state.messages = [msg('a', 'one!'), ...context.state.messages.slice(1)];
  context.renderMessages();
  assert.deepEqual(inserted, ['b', 'c', 'a']);
  assert.deepEqual(root.children.slice(1), [b2, c]);
  assert.deepEqual(root.children.map(node => node.attrs['data-message-id']), ['a', 'b', 'c']);
  // Removing a message removes its row; a language change redraws everything.
  context.state.messages = [context.state.messages[0], context.state.messages[2]];
  context.renderMessages();
  assert.deepEqual(root.children.map(node => node.attrs['data-message-id']), ['a', 'c']);
  context.i18n.language = 'en';
  context.renderMessages();
  assert.deepEqual(rebuilt.slice(-2), ['a', 'c']);
  // Another chat starts from scratch.
  context.state.chat = { id: 'other', title: 'O', options: {} };
  context.state.messages = [msg('a', 'one')];
  context.renderMessages();
  assert.equal(rebuilt.at(-1), 'a');
  assert.equal(root.children.length, 1);
  assert.ok(all(root).length > 1);
});

test('a refresh about other chats rereads only the chat list', async () => {
  const app = source('app.js');
  const code = app.slice(app.indexOf('function applyStateList('), app.indexOf('async function openChat('));
  const paths = [], drawn = [];
  const state = { chat: { id: 'chat' }, chats: [], messages: [{ id: 'kept' }] };
  const context = vm.createContext({ state, viewRevision: 0, refreshSequence: 0, saveChain: Promise.resolve(), preferenceChain: Promise.resolve(), liveSync: { revision: 0 },
    api: async path => { paths.push(path); return { groups: [], chats: [{ id: 'chat' }, { id: 'desk' }], providers: [], active: ['desk'] }; },
    renderGroups: () => drawn.push('groups'), renderHeader: () => drawn.push('header'), renderFeatures: () => drawn.push('features'), renderMessages: () => drawn.push('messages'),
    refresh: async () => drawn.push('full'), globalThis: {} });
  vm.runInContext(code, context);
  await context.refreshList();
  assert.deepEqual(paths, ['/state']);
  assert.deepEqual(state.active, ['desk']);
  assert.deepEqual(state.messages, [{ id: 'kept' }]);
  assert.equal(drawn.includes('messages'), false);
  // The open chat was deleted elsewhere: a full refresh handles it.
  state.chat = { id: 'gone' };
  await context.refreshList();
  assert.equal(drawn.at(-1), 'full');
});

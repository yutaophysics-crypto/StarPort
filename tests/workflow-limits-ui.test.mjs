import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function ui(settings = { planners: [], stepMinutes: 30, stepLimitEnabled: false }, language = 'zh', extra = {}) {
  const all = node => [node, ...(node.children || []).flatMap(all)];
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.value = ''; this.className = ''; this.checked = false; this.disabled = false; }
    append(...nodes) { for (const node of nodes.filter(Boolean)) { this.children.push(node); if (typeof node === 'object') node.parent = this; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    replaceWith(node) { const list = this.parent?.children, i = list ? list.indexOf(this) : -1; if (i >= 0) { list[i] = node; node.parent = this.parent; } }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value); }
    getAttribute(key) { return this.attrs[key]; }
    addEventListener() {}
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    get options() { return this.children.filter(n => n.tag === 'option'); }
    get selectedOptions() { return this.options.filter(n => n.value === this.value); }
    get classList() { return { add: (...names) => { this.className += ' ' + names.join(' '); }, contains: name => this.className.split(/\s+/).includes(name), toggle() {}, remove() {} }; }
    querySelector(selector) { return all(this).find(n => selector.includes('type=submit') ? n.attrs?.type === 'submit' : selector.startsWith('.') && n.className?.split(/\s+/).includes(selector.slice(1))); }
  }
  const body = new Node('body'), document = { body, activeElement: null, createElement: tag => new Node(tag), createTextNode: text => ({ tag: '#text', textContent: text }), addEventListener() {},
    getElementById: id => all(body).find(node => node.attrs?.id === id) };
  const data = { settings, companions: [], rooms: {}, workflows: [], mounts: [], running: [], defaults: { planners: [] }, ...extra }, calls = [];
  const context = vm.createContext({ document, window: { addEventListener() {} }, state: { providers: [], chat: null, messages: [] }, Date, URLSearchParams, setTimeout, clearTimeout,
    localStorage: { getItem: () => language, setItem() {} }, toast() {}, renderMessages() {},
    api: async (path, method, input) => { calls.push({ path, method, input }); if (path === '/workflows/settings' && input) data.settings = { ...data.settings, ...input }; return path === '/workflows/state' ? data : {}; } });
  vm.runInContext(readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8'), context);
  context.StarportI18n.setLanguage(language);
  vm.runInContext(readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8'), context);
  for (const file of ['workflows', 'workflow-cards', 'workflow-editor', 'workflow-mount', 'workflow-ledger', 'workflow-exam']) {
    vm.runInContext(readFileSync(new URL(`../public/${file}.js`, import.meta.url), 'utf8'), context);
  }
  return { context, all, body, calls, document, text: root => all(root).map(n => n.textContent || '').join('\n') };
}

test('unlimited is the default, the switch enables a labeled numeric field, and saving sends explicit consent', async () => {
  const f = ui(); await f.context.StarportWorkflows.load(); f.context.StarportWorkflows.openSettings();
  const nodes = f.all(f.body), checkbox = nodes.find(n => n.attrs?.type === 'checkbox');
  const minutes = nodes.find(n => n.attrs?.type === 'number');
  assert.equal(checkbox.checked, false); assert.equal(minutes.disabled, true); assert.equal(minutes.required, false);
  assert.equal(checkbox.getAttribute('aria-label'), '启用单步时限');
  assert.match(f.text(f.body), /默认不限总时长/);
  checkbox.checked = true; checkbox.onchange(); minutes.value = '120';
  assert.equal(minutes.disabled, false); assert.equal(minutes.required, true);
  const form = nodes.find(n => n.tag === 'form'); await form.onsubmit({ preventDefault() {} });
  const saved = f.calls.find(call => call.method === 'PUT').input;
  assert.equal(saved.stepLimitEnabled, true); assert.equal(saved.stepMinutes, 120);
});

test('turning off a limit ignores a disabled blank duration and persists the off switch', async () => {
  const f = ui({ planners: [], stepLimitEnabled: true, stepMinutes: 60 });
  await f.context.StarportWorkflows.load(); f.context.StarportWorkflows.openSettings();
  const nodes = f.all(f.body), checkbox = nodes.find(n => n.attrs?.type === 'checkbox'), minutes = nodes.find(n => n.attrs?.type === 'number');
  minutes.value = ''; checkbox.checked = false; checkbox.onchange();
  await nodes.find(n => n.tag === 'form').onsubmit({ preventDefault() {} });
  const saved = f.calls.find(call => call.method === 'PUT').input;
  assert.equal(saved.stepLimitEnabled, false); assert.equal(saved.stepMinutes, 60);
});

test('a busy old backend cannot be presented as already running without a time limit', async () => {
  const f = ui({ planners: [], stepMinutes: 30 }); await f.context.StarportWorkflows.load(); f.context.StarportWorkflows.openSettings();
  assert.match(f.text(f.body), /更新前仍沿用旧规则/);
  assert.equal(f.all(f.body).some(n => n.tag === 'form'), false);
  assert.equal(f.calls.some(call => call.method === 'PUT'), false);
});

test('cards distinguish unlimited work, explicit limits, inactivity and saved progress in both languages', async () => {
  for (const language of ['zh', 'en']) {
    const f = ui(undefined, language); await f.context.StarportWorkflows.load();
    const run = { id: 'r', title: 'test', trigger: 'dispatch', started: new Date().toISOString(), status: 'running', timeLimitMinutes: 0, steps: [
      { key: 's', companionName: 'Opus', status: 'running', started: new Date().toISOString(), timeLimitMinutes: 0, runtime: { stalled: true },
        checkpoint: { reason: 'deadline-warning' }, notes: ['连续 5 分钟未收到新活动，任务仍在运行；不会因无活动自动停止。'] }
    ] };
    const card = f.context.StarportWorkflows.renderCard({ id: 'm', details: { workflowRun: run } });
    assert.match(f.text(card), language === 'en' ? /No time limit/ : /不限总时长/);
    assert.match(f.text(card), language === 'en' ? /No recent activity/ : /未收到新活动/);
    assert.match(f.text(card), language === 'en' ? /Progress saved/ : /进度已保留/);
    assert.match(f.text(card), language === 'en' ? /will not be stopped for inactivity/ : /不会因无活动自动停止/);
    run.timeLimitMinutes = 60;
    const limited = f.context.StarportWorkflows.renderCard({ id: 'm', details: { workflowRun: run } });
    assert.match(f.text(limited), language === 'en' ? /60-minute limit per step/ : /单步限时 60 分钟/);
    delete run.timeLimitMinutes; delete run.steps[0].timeLimitMinutes;
    const legacy = f.context.StarportWorkflows.renderCard({ id: 'old', details: { workflowRun: run } });
    assert.equal(f.text(legacy).includes(language === 'en' ? 'No time limit' : '不限总时长'), false);
  }
});

function examRun() {
  return { id: 'r1', kind: 'exam', title: '考场「模拟」', trigger: 'exam', status: 'proposed', started: new Date().toISOString(), notes: [], steps: [],
    exam: { name: '模拟', instruction: '把 sim.py 调到误差最小', minutes: 120,
      seats: [{ companionId: 'c1', companionName: 'Opus', knowledge: true }, { companionId: 'c2', companionName: 'GPT', knowledge: true }],
      paper: { path: 'C:\\work\\paper', files: 3, bytes: 2048, top: ['sim.py', 'data'] },
      knowledge: [{ path: 'C:\\refs\\notes.md', name: 'notes.md', kind: 'file', files: 1, bytes: 10 }] } };
}
const examCompanions = { companions: [{ id: 'c1', name: 'Opus', avatar: '🦉' }, { id: 'c2', name: 'GPT', avatar: '🐙' }, { id: 'c3', name: 'DS', avatar: '🐳' }] };

test('an exam proposal sends nothing until the user presses Start, then sends the seats, books and limit they chose', async () => {
  const f = ui(undefined, 'zh', examCompanions); await f.context.StarportWorkflows.load();
  const msg = { id: 'm1', chat_id: 'c', details: { workflowRun: examRun() } };
  const box = f.document.createElement('div'); box.append(f.context.StarportWorkflows.renderCard(msg));
  const nodes = () => f.all(box.children[0]), text = () => f.text(box.children[0]);
  assert.match(text(), /待开考/); assert.match(text(), /看不到这个对话、长期记忆和彼此/);
  assert.match(text(), /C:\\work\\paper/); assert.match(text(), /3 个文件 · 2\.0 KB/); assert.match(text(), /把 sim\.py 调到误差最小/);
  assert.equal(f.calls.some(call => call.path.includes('/exams/')), false);
  // Close the second seat's book, add a third seat and shorten the limit; the card redraws each time.
  nodes().filter(n => n.className === 'wf-exam-toggle')[1].onclick();
  assert.match(text(), /闭卷/);
  const add = nodes().find(n => n.attrs['aria-label'] === '添加考位'); add.value = 'c3'; add.onchange({ target: add });
  const limit = nodes().find(n => n.attrs['aria-label'] === '每个考位的时限'); limit.value = '30'; limit.onchange({ target: limit });
  assert.equal(nodes().filter(n => n.className === 'wf-exam-seat').length, 3);
  await nodes().find(n => n.className.includes('wf-exam-start')).onclick();
  const start = f.calls.find(call => call.path === '/chats/c/exams/m1/start');
  assert.deepEqual(JSON.parse(JSON.stringify(start.input)), {
    seats: [{ companionId: 'c1', knowledge: true }, { companionId: 'c2', knowledge: false }, { companionId: 'c3', knowledge: true }], minutes: 30 });
  const other = { id: 'm2', chat_id: 'c', details: { workflowRun: { ...examRun(), id: 'r2' } } };
  await f.all(f.context.StarportWorkflows.renderCard(other)).find(n => n.attrs?.title === '不开考，收起这个提议').onclick();
  assert.ok(f.calls.some(call => call.path === '/chats/c/exams/m2/cancel'));
});

test('a finished exam shows each seat folder and its checks, and one unfinished seat does not fail the exam', async () => {
  for (const language of ['zh', 'en']) {
    const f = ui(undefined, language, examCompanions); await f.context.StarportWorkflows.load();
    const run = { ...examRun(), status: 'done', timeLimitMinutes: 30, ended: new Date().toISOString() };
    run.exam.folder = 'C:\\Desktop\\StarPortExams\\2026-10-19 1200 模拟';
    const clean = { modified: [], deleted: [], changed: 0, added: 0, addedSample: [], stray: { count: 0, samples: [] } };
    run.steps = [
      { key: 'seat1', label: '考位 1', companionId: 'c1', companionName: 'Opus', status: 'done', output: '答案 A', timeLimitMinutes: 30,
        seat: { dir: run.exam.folder + '\\考位1-Opus', knowledge: true, audit: { ...clean, modified: ['sim.py'], changed: 1, added: 2, addedSample: ['out.txt'],
          stray: { count: 1, samples: [{ tool: 'shell', text: 'type ..\\考位2-GPT\\answer.md' }] } } } },
      { key: 'seat2', label: '考位 2', companionId: 'c2', companionName: 'GPT', status: 'failed', error: '超时', timeLimitMinutes: 30,
        seat: { dir: run.exam.folder + '\\考位2-GPT', knowledge: false, audit: clean } }
    ];
    const card = f.context.StarportWorkflows.renderCard({ id: 'm1', chat_id: 'c', details: { workflowRun: run } }), text = f.text(card);
    assert.equal(card.className.includes('failed-run'), false);
    assert.match(text, /考位1-Opus/); assert.match(text, /考位2-GPT/);
    const expected = language === 'en'
      ? [/1\/2 seats handed in · 1 unfinished · 1 to check/, /Paper files changed: 1/, /Outside the seat: 1/, /Paper unchanged/, /Stayed in the seat/, /30-minute limit/, /Exam folder/]
      : [/1\/2 个考位已交卷 · 1 个没有完成 · 1 个需要核对/, /改动了 1 个试卷文件/, /1 次越界/, /试卷未改动/, /没有越界/, /限时 30 分钟/, /考场文件夹/];
    for (const pattern of expected) assert.match(text, pattern);
    assert.equal(/单步限时/.test(text), false);
    const stray = f.all(card).find(n => n.className === 'wf-exam-check bad');
    assert.match(stray.attrs.title, /考位2-GPT/);
  }
});

test('companions at work show a clock that keeps counting, and a request waiting its turn shows 排队中', async () => {
  const started = new Date(Date.now() - 192000).toISOString();
  const f = ui(undefined, 'zh', { running: [
    { id: 'r1', companions: ['a', 'b'], steps: [{ companionId: 'a', started, queued: false }, { companionId: 'b', started, queued: true }] },
    { id: 'r2', companions: ['a'], steps: [{ companionId: 'a', started: new Date().toISOString(), queued: true }] }
  ] });
  const W = f.context.StarportWorkflows; await W.load();
  assert.deepEqual({ ...W.companionWork('a') }, { started }, 'the step at work wins over one queued behind it');
  assert.deepEqual({ ...W.companionWork('b') }, { queued: true });
  assert.equal(W.companionWork('c'), null);

  const run = { id: 'r', title: 'test', trigger: 'dispatch', started, status: 'running', steps: [
    { key: 'a', companionId: 'a', companionName: '甲', status: 'running', started },
    { key: 'b', companionId: 'b', companionName: '乙', status: 'running', started, queued: true }
  ] };
  const card = W.renderCard({ id: 'm', details: { workflowRun: run } });
  const clocks = f.all(card).filter(n => n.attrs?.['data-live-since']);
  assert.equal(clocks.length, 2, 'the card and the working step count; the queued step does not');
  assert.match(f.text(card), /已 3 分 1\d 秒/);
  assert.match(f.text(card), /排队中/);
  assert.match(f.text(card), /甲 工作中…/);

  // The page's one-second tick moves every clock without drawing the card again.
  f.body.append(card);
  f.document.querySelectorAll = () => f.all(f.body).filter(n => n.attrs?.['data-live-since']);
  for (const clock of clocks) clock.setAttribute('data-live-since', new Date(Date.now() - 3725000).toISOString());
  W.tick();
  assert.deepEqual(clocks.map(clock => clock.textContent), ['已 1 小时 2 分', '已 1 小时 2 分']);

  run.steps = [run.steps[1]];
  const queued = W.renderCard({ id: 'm', details: { workflowRun: run } });
  assert.match(f.text(queued), /乙 排队中，做完手上的事就开始/);
  assert.match(f.text(queued), /已等 3 分/);
  assert.equal(f.all(queued).find(n => n.className?.startsWith('wf-status')).className, 'wf-status queued');

  // A step stopped while it waited is shown as stopped, whatever flag it kept.
  run.status = 'stopped'; run.ended = new Date().toISOString(); run.steps[0].status = 'stopped';
  const stopped = f.text(W.renderCard({ id: 'm', details: { workflowRun: run } }));
  assert.equal(stopped.includes('排队中'), false); assert.match(stopped, /已停止/);
});

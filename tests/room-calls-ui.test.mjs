import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/room-companions.js', import.meta.url), 'utf8');

// Just enough page for the roster dialog: plain element records, and the dialog it asks to show.
function page({ members, calls = {}, onCall = () => {} }) {
  const el = (tag, attrs = {}, children = []) => {
    const node = { tag, ...attrs, children: [] };
    node.append = (...nodes) => node.children.push(...nodes.filter(n => n != null && n !== ''));
    node.append(...[].concat(children));
    return node;
  };
  const dialogs = [];
  const room = { groupId: 'g', title: '科研', members };
  const context = vm.createContext({ toast: message => dialogs.push({ toast: message }), state: { messages: [], chats: [] } });
  Object.assign(context, {
    StarportWorkflows: {
      status: 'ready',
      MAIN: { id: 'main', name: '主模型', avatar: '主' },
      companions: () => members,
      memoryOf: () => ({ read: true, propose: false }),
      callsOf: (gid, callerId) => (gid === 'g' && calls[callerId]) || [],
      call: async (path, method, body) => onCall(path, method, body)
    },
    StarportUI: {
      el,
      icon: () => null,
      avatar: c => el('span', { class: 'room-avatar', text: c.avatar }),
      textAction: text => el('button', { text }),
      field: () => null,
      showDialog: dialog => dialogs.push(dialog),
      closeDialog: () => {},
      confirmDialog: () => {},
      modelPicker: () => ({})
    },
    StarportAgentsRoom: {
      roomInfo: () => room,
      currentGroupId: () => 'g',
      currentRoom: () => room,
      roomMounts: () => [],
      modelLine: () => '',
      toggleMention: () => {}
    }
  });
  vm.runInContext(source, context);
  return { Room: context.StarportAgentsRoom, dialogs };
}
const walk = node => (node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : []);
// Each caller's row: who it is, and the companions it may be ticked to call.
function callRows(dialog) {
  const rows = walk({ children: dialog.body }).filter(node => node.tag === 'li');
  return rows.map(row => {
    const name = walk(row).find(node => node.class === 'room-member-name')?.text;
    const box = walk(row).find(node => node.class?.includes('room-member-calls'));
    const choices = box
      ? walk(box)
          .filter(node => node.tag === 'label')
          .map(label => ({ input: label.children[0], who: label.children[1].text }))
      : null;
    return { name, choices };
  });
}

test('the roster dialog lets 主模型 and each member be allowed to call the other members, and saves the ticked set', async () => {
  const members = [
    { id: 'a', name: '甲', avatar: '🦉' },
    { id: 'b', name: '乙', avatar: '🦊' }
  ];
  const sent = [];
  const { Room, dialogs } = page({ members, calls: { main: ['b'] }, onCall: (...args) => sent.push(args) });
  Room.openRosterManager('g');
  const rows = callRows(dialogs[0]);
  assert.deepEqual(
    rows.map(row => [row.name, row.choices?.map(c => c.who + (c.input.checked ? '✓' : ''))]),
    [
      ['主模型', ['🦉 甲', '🦊 乙✓']],
      ['甲', ['🦊 乙']],
      ['乙', ['🦉 甲']]
    ],
    '主模型 comes first; nobody is offered itself; only granted calls are ticked'
  );
  const tick = rows[0].choices[0].input;
  tick.checked = true;
  await tick.onchange();
  // The payload is built inside the page's realm; compare its content.
  assert.equal(JSON.stringify(sent), JSON.stringify([['/rooms/g/calls/main', 'PUT', { callees: ['a', 'b'] }]]));
  assert.equal(tick.disabled, false);

  const failing = page({ members, onCall: () => Promise.reject(new Error('房间不存在')) });
  failing.Room.openRosterManager('g');
  const box = callRows(failing.dialogs[0])[1].choices[0].input;
  box.checked = true;
  await box.onchange();
  assert.equal(box.checked, false, 'a refused change is undone');
  assert.equal(failing.dialogs.at(-1).toast, '房间不存在');
});

test('with one member there is nobody else for it to call; 主模型 can still be allowed to call it', () => {
  const { Room, dialogs } = page({ members: [{ id: 'a', name: '甲', avatar: '🦉' }] });
  Room.openRosterManager('g');
  assert.deepEqual(
    callRows(dialogs[0]).map(row => [row.name, row.choices?.map(c => c.who) ?? null]),
    [
      ['主模型', ['🦉 甲']],
      ['甲', null]
    ]
  );
});

function companionDialogEnv({ apiImpl, onWorkflowCall = async () => ({}) } = {}) {
  const all = node => [node, ...(node.children || []).flatMap(all)];
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attrs = {};
      this.dataset = {};
      this.value = '';
      this.className = '';
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
    }
    append(...nodes) {
      for (const node of nodes.filter(n => n != null && n !== false)) {
        this.children.push(node);
        if (typeof node === 'object') node.parent = this;
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
    }
    getAttribute(key) {
      return this.attrs[key];
    }
    addEventListener(type, fn) {
      this['_on_' + type] = fn;
    }
    focus() {
      document.activeElement = this;
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this._on_close?.();
    }
    get options() {
      return this.children.filter(n => n.tag === 'option');
    }
    get selectedOptions() {
      const explicit = this.options.filter(n => n.selected);
      return explicit.length ? explicit : this.options.filter(n => n.value === this.value);
    }
    querySelector(selector) {
      return all(this).find(n => (selector.includes('type=submit') ? n.attrs?.type === 'submit' : false));
    }
  }
  const body = new Node('body');
  const document = {
    body,
    activeElement: null,
    createElement: tag => new Node(tag),
    createTextNode: text => ({ tag: '#text', textContent: text }),
    addEventListener() {},
    getElementById: id => all(body).find(node => node.attrs?.id === id)
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    state: {
      providers: [{ id: 'antigravity', installed: true }, { id: 'codex', installed: true }],
      chat: { id: 'c1', workspace: 'D:\\DeletedWorkspace' },
      workspace: 'D:\\StarPort',
      messages: [],
      chats: []
    },
    Date,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => 'zh', setItem() {} },
    toast() {},
    api: apiImpl
  });
  vm.runInContext(readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8'), context);
  context.StarportI18n.setLanguage('zh');
  vm.runInContext(readFileSync(new URL('../public/ui-kit.js', import.meta.url), 'utf8'), context);
  context.StarportWorkflows = {
    status: 'ready',
    PROVIDER_LABELS: context.StarportUI.PROVIDER_LABELS,
    data: { mounts: [], deskFields: { antigravity: [] } },
    MAIN: { id: 'main', name: '主模型', avatar: '主' },
    companions: () => [],
    memoryOf: () => ({ read: true, propose: false }),
    callsOf: () => [],
    call: onWorkflowCall
  };
  context.StarportAgentsRoom = {
    roomInfo: () => ({ groupId: 'g', title: '科研', members: [] }),
    currentGroupId: () => 'g',
    currentRoom: () => ({ groupId: 'g', title: '科研', members: [] }),
    roomMounts: () => [],
    modelLine: () => '',
    toggleMention: () => {}
  };
  vm.runInContext(source, context);
  return { context, body, all };
}

test('companion settings recover from unavailable or stale Antigravity catalogs, fallback on missing workspace, and save Gemini 4 Carbon', async () => {
  const requests = [];
  const saved = [];
  let mode = 'unavailable';
  let releasePending = null;
  const carbonCatalog = {
    source: 'native',
    models: [
      { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
      { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
      { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }
    ],
    effort: {
      source: 'cli',
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'Extra high' },
        { value: 'max', label: 'Max' }
      ]
    }
  };
  const env = companionDialogEnv({
    apiImpl: async path => {
      requests.push(path);
      if (path.includes('workspace=D%3A%5CDeletedWorkspace')) throw new Error('工作目录不存在');
      if (mode === 'unavailable') return { models: [], source: 'unavailable' };
      if (mode === 'stale') return { source: 'native', models: [{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }] };
      if (mode === 'slow') {
        await new Promise(resolve => { releasePending = resolve; });
        return carbonCatalog;
      }
      return carbonCatalog;
    },
    onWorkflowCall: async (path, method, payload) => {
      saved.push({ path, method, payload: JSON.parse(JSON.stringify(payload)) });
      return {};
    }
  });

  const existing = {
    id: 'c_62780ec3902d',
    name: '游戏狂想者',
    avatar: '🎮',
    role: '玩法设计',
    persona: '',
    provider: 'antigravity',
    model: 'gemini-4-argon-high',
    effort: 'high',
    options: {}
  };

  // 1. Missing chat workspace falls back to workspace='' and unavailable catalog is NOT cached forever.
  env.context.StarportAgentsRoom.openCompanionConfig(existing);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(requests.some(r => r === '/providers/antigravity/models?workspace='));

  const dialogNodes = () => env.all(env.body);
  const modelField = dialogNodes().find(
    n => n.className === 'room-field' && env.all(n).some(c => c.className === 'room-field-stack')
  );
  assert.equal(modelField.tag, 'div', 'multi-control model field must not use <label> and steal focus from custom input');

  // 2. Reopening when stale catalog is returned, then clicking 刷新列表 sends refresh=1 and loads Gemini 4 Carbon.
  mode = 'stale';
  env.context.StarportAgentsRoom.openCompanionConfig(existing);
  await new Promise(resolve => setTimeout(resolve, 10));
  const selectsBefore = dialogNodes().filter(n => n.tag === 'select');
  const modelSelect = selectsBefore[2];
  assert.equal(modelSelect.options.some(o => o.value === 'gemini-4-carbon-high'), false);

  mode = 'slow';
  const refreshButton = dialogNodes().find(n => n.tag === 'button' && n.textContent === '刷新列表');
  const refreshDone = refreshButton.onclick();
  assert.equal(refreshButton.disabled, true);
  assert.equal(refreshButton.textContent, '正在读取…');
  assert.match(modelSelect.options[0].textContent, /gemini-4-argon-high（正在读取模型列表…）/);

  await Promise.resolve();
  releasePending();
  await refreshDone;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(requests.some(r => r === '/providers/antigravity/models?workspace=&refresh=1'));
  assert.deepEqual(
    modelSelect.options.map(o => o.value),
    ['', 'gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-4-carbon-low', 'gemini-4-argon-high', '__custom__']
  );

  // 3. Selecting Gemini 4 Carbon (High) + Extra high effort saves cleanly via PATCH.
  modelSelect.value = 'gemini-4-carbon-high';
  modelSelect.onchange();
  const effortSelect = selectsBefore[1];
  effortSelect.value = 'xhigh';
  effortSelect.onchange();

  const form = dialogNodes().find(n => n.tag === 'form');
  await form.onsubmit({ preventDefault() {} });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path, '/companions/c_62780ec3902d');
  assert.equal(saved[0].method, 'PATCH');
  assert.equal(saved[0].payload.provider, 'antigravity');
  assert.equal(saved[0].payload.model, 'gemini-4-carbon-high');
  assert.equal(saved[0].payload.effort, 'xhigh');
});

test('Claude companion picker does not stick on fallback aliases and automatically refreshes to offer Claude Fable 5.2', async () => {
  const requests = [];
  const saved = [];
  let attempt = 0;
  const env = companionDialogEnv({
    apiImpl: async path => {
      requests.push(path);
      attempt++;
      if (attempt === 1) {
        return {
          source: 'aliases',
          models: [
            { id: 'sonnet', label: 'Claude Sonnet' },
            { id: 'opus', label: 'Claude Opus' },
            { id: 'fable', label: 'Claude Fable' }
          ]
        };
      }
      return {
        source: 'native',
        models: [
          {
            id: 'opus',
            label: 'Claude Opus 5.5',
            resolvedModel: 'claude-opus-5-5',
            effort: { source: 'native', choices: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra' }] }
          },
          {
            id: 'claude-fable-5-2',
            label: 'Claude Fable 5.2',
            resolvedModel: 'claude-fable-5-2',
            effort: { source: 'native', choices: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra' }] }
          },
          {
            id: 'fable',
            label: 'Claude Fable 5.1',
            resolvedModel: 'claude-fable-5-1',
            effort: { source: 'native', choices: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra' }] }
          }
        ]
      };
    },
    onWorkflowCall: async (path, method, payload) => {
      saved.push({ path, method, payload: JSON.parse(JSON.stringify(payload)) });
      return {};
    }
  });

  const existing = {
    id: 'c_2ba90b857a19',
    name: 'opus',
    avatar: '👴',
    role: 'opus',
    persona: '',
    provider: 'claude',
    model: 'opus',
    effort: 'xhigh',
    options: { permissionMode: 'auto' }
  };

  env.context.StarportAgentsRoom.openCompanionConfig(existing);
  await new Promise(resolve => setTimeout(resolve, 10));
  const dialogNodes = () => env.all(env.body);
  assert.ok(
    dialogNodes().some(n => n.className === 'room-field-hint' && !n.hidden && /暂显示模型别名/.test(n.textContent || '')),
    'fallback aliases show a retry hint instead of silently masquerading as the full native catalog'
  );

  // Reopening automatically forces refresh=1 because the previous response was degraded (aliases).
  env.context.StarportAgentsRoom.openCompanionConfig(existing);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(requests.some(r => r.includes('/providers/claude/models?') && r.includes('refresh=1')));

  const selects = dialogNodes().filter(n => n.tag === 'select');
  const modelSelect = selects[2];
  assert.ok(modelSelect.options.some(o => o.value === 'claude-fable-5-2' && /Claude Fable 5\.2/.test(o.textContent)));

  modelSelect.value = 'claude-fable-5-2';
  modelSelect.onchange();
  const form = dialogNodes().find(n => n.tag === 'form');
  await form.onsubmit({ preventDefault() {} });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].payload.provider, 'claude');
  assert.equal(saved[0].payload.model, 'claude-fable-5-2');
  assert.equal(saved[0].payload.effort, 'xhigh');
});

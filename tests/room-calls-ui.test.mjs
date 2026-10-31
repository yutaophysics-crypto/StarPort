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

'use strict';

if (navigator.userAgent.includes('StarportMobile/')) document.body.classList.add('native');

const $ = selector => document.querySelector(selector);
const titles = { codex: 'ChatGPT / Codex', claude: 'Claude Code', antigravity: 'Antigravity', deepseek: 'DeepSeek Harness', ollama: 'Ollama' };
const state = { csrf: '', device: '', chat: '', devices: [], chats: [], run: null, revision: 0, send: null, history: [], current: [], drafts: new Map() };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
let errorTimer, refreshing = false, transcriptKey = '', approvalKey = '', lastSidebar = '';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function status(message) {
  const node = $('#status');
  node.textContent = message;
  node.hidden = !message;
  clearTimeout(errorTimer);
  if (message) errorTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

async function api(path, body) {
  const res = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Starport-CSRF': state.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.replace('/?remote=1');
    throw Error('请登录星港');
  }
  const data = await res.json();
  if (!res.ok) throw Error(data.error || '连接失败');
  return data;
}

async function request(device, command, revision = state.revision) {
  const { id } = await api('/mobile/devices/' + device + '/requests', { id: newId(), ...command });
  const until = Date.now() + 24_000;
  while (Date.now() < until && revision === state.revision) {
    const receipt = await api('/mobile/requests/' + id);
    if (receipt.status === 'done') return receipt.data;
    if (receipt.status === 'failed') throw Error(receipt.error);
    await wait(750);
  }
  if (revision !== state.revision) return null;
  throw Error('电脑响应超时。请刷新对话确认任务状态。');
}

function page(name) { $('#workspace').dataset.page = name; }
function entry(title, meta, selected, action) {
  const row = element('button', '', 'entry');
  row.type = 'button';
  row.setAttribute('aria-current', String(selected));
  row.append(element('span', title), element('small', meta));
  row.onclick = action;
  return row;
}

function drawSidebar() {
  const key = JSON.stringify([state.device, state.chat, state.devices, state.chats]);
  if (lastSidebar === key) return;
  lastSidebar = key;
  $('#devices').replaceChildren(...(state.devices.length ? state.devices.map(d =>
    entry(d.name, !d.enabled ? '未开启手机访问' : d.online ? '在线' : '离线', state.device === d.id, () => selectDevice(d.id)))
    : [element('p', '在电脑星港登录同一账号，并开启手机访问。', 'hint')]));
  const device = state.devices.find(d => d.id === state.device);
  $('#device-name').textContent = device?.name || '';
  $('#chats').replaceChildren(...(state.chats.length ? state.chats.map(c =>
    entry(c.title, [c.group, titles[c.provider] || c.provider, c.running ? '执行中' : ''].filter(Boolean).join(' · '), c.id === state.chat, () => openChat(c)))
    : [element('p', !device ? '请选择电脑' : !device.enabled ? '请先在电脑开启手机访问。' : device.online ? '没有已开放的对话' : '这台电脑当前离线', 'hint')]));
}

function resetChat() {
  state.chat = '';
  state.run = null;
  state.send = null;
  state.history = [];
  state.current = [];
  $('#chat-title').textContent = '选择对话';
  $('#agent').textContent = '';
  $('#messages').replaceChildren();
  $('#approvals').replaceChildren();
  $('#older').hidden = true;
  $('#composer').hidden = true;
  $('#stop').hidden = true;
  transcriptKey = approvalKey = '';
}

function selectDevice(id) {
  if (state.device !== id) {
    ++state.revision;
    state.device = id;
    state.chats = [];
    resetChat();
    drawSidebar();
    readChats(state.revision).catch(error => status(error.message));
  }
  page('chats');
}

async function readDevices() {
  state.devices = (await api('/mobile/devices')).devices;
  if (state.device && !state.devices.some(device => device.id === state.device)) {
    ++state.revision;
    state.device = '';
    state.chats = [];
    resetChat();
    page('devices');
  }
  drawSidebar();
}

async function readChats(revision) {
  const device = state.devices.find(d => d.id === state.device);
  if (!device?.enabled || !device.online) return;
  const data = await request(device.id, { op: 'list' }, revision);
  if (data && revision === state.revision) {
    state.chats = data.chats;
    drawSidebar();
  }
}

function draftKey() { return state.device + '/' + state.chat; }
function openChat(chat) {
  if (state.chat !== chat.id) {
    ++state.revision;
    resetChat();
    state.chat = chat.id;
    $('#chat-title').textContent = chat.title;
    $('#agent').textContent = titles[chat.provider] || chat.provider;
    $('#draft').value = state.drafts.get(draftKey())?.text || '';
    drawSidebar();
    readChat(state.revision, { bottom: true }).catch(error => status(error.message));
  }
  page('chat');
}

function renderMessages(bottom = false) {
  const older = state.history.filter(row => !state.current.some(current => current.id === row.id));
  const rows = [...older, ...state.current];
  const key = JSON.stringify(rows);
  if (key === transcriptKey) return;
  transcriptKey = key;
  const scroller = $('#transcript');
  const follow = bottom || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 85;
  $('#messages').replaceChildren(...rows.map(row => {
    const item = element('article', '', 'message');
    item.append(element('header', row.role === 'user' ? '你' : titles[row.provider] || 'Agent'));
    const content = element('div', '', row.role === 'user' ? 'text' : 'prose');
    if (row.role !== 'user' && row.content && globalThis.marked && globalThis.DOMPurify) {
      // Remote content never loads third-party media or sends a request from the phone.
      content.innerHTML = DOMPurify.sanitize(marked.parse(row.content), { FORBID_TAGS: ['a','img','picture','source','video','audio','iframe','form','input','button','style','svg','math'], FORBID_ATTR: ['style','src','srcset','href','action'] });
    } else content.textContent = row.content || (row.status === 'running' ? '正在执行…' : '');
    if (row.truncated) item.append(element('p', '此处显示消息末尾，全文可在电脑查看。', 'hint'));
    item.append(content);
    if (row.error) item.append(element('p', row.error, 'error'));
    return item;
  }));
  if (follow) scroller.scrollTop = scroller.scrollHeight;
}

function actionButton(title, handler) {
  const button = element('button', title);
  button.type = 'button';
  button.onclick = async () => {
    button.disabled = true;
    try { await handler(); } catch (error) { status(error.message); }
    finally { button.disabled = false; }
  };
  return button;
}

function renderApprovals() {
  const key = JSON.stringify(state.run);
  if (key === approvalKey) return;
  approvalKey = key;
  $('#approvals').replaceChildren(...(state.run?.approvals || []).map(prompt => {
    const box = element('section', '', 'approval');
    box.append(element('strong', prompt.title));
    if (prompt.detail) box.append(element('pre', prompt.detail));
    const fields = new Map();
    for (const question of prompt.questions) {
      const group = element('fieldset');
      group.append(element('legend', question.question));
      const inputs = question.options.map(option => {
        const label = element('label'), input = element('input');
        input.type = question.multiSelect ? 'checkbox' : 'radio';
        input.name = prompt.id + '-' + question.id;
        input.value = option.label;
        label.append(input, document.createTextNode(' ' + option.label));
        group.append(label);
        return input;
      });
      const free = element('input');
      free.type = 'text';
      free.maxLength = 2000;
      free.placeholder = '填写其他答案';
      free.setAttribute('aria-label', question.question);
      group.append(free);
      fields.set(question.id, { inputs, free });
      box.append(group);
    }
    const question = prompt.kind === 'question';
    box.append(actionButton(question ? '提交回答' : '批准本次', async () => {
      if (!question) return answer(prompt.id, 'accept');
      const values = Object.fromEntries([...fields].map(([id, { inputs, free }]) =>
        [id, free.value.trim() ? [free.value.trim()] : inputs.filter(input => input.checked).map(input => input.value)]));
      if (Object.values(values).some(value => !value.length)) throw Error('请先回答每个问题');
      await answer(prompt.id, 'accept', values);
    }), actionButton(question ? '跳过' : '拒绝', () => answer(prompt.id, question ? 'skip' : 'decline')));
    return box;
  }));
}

async function readChat(revision, { before, bottom } = {}) {
  if (!state.chat || !state.devices.find(d => d.id === state.device)?.online) return;
  const data = await request(state.device, { op: 'read', chatId: state.chat, before }, revision);
  if (!data || revision !== state.revision) return;
  if (before) {
    state.history = [...data.messages, ...state.history];
    $('#older').hidden = !data.hasOlder;
  } else {
    state.current = data.messages;
    if (!state.history.length) $('#older').hidden = !data.hasOlder;
    state.run = data.run;
    $('#chat-title').textContent = data.chat.title;
    $('#agent').textContent = [titles[data.chat.provider] || data.chat.provider, data.run ? (data.run.approvals.length ? '等待你操作' : '执行中') : ''].filter(Boolean).join(' · ');
    $('#composer').hidden = false;
    $('#send').disabled = !!state.run || !!state.send;
    $('#stop').hidden = !state.run;
  }
  renderMessages(bottom);
  renderApprovals();
}

async function answer(requestId, decision, answers) {
  const revision = state.revision;
  if (!state.run) return;
  await request(state.device, { op: 'answer', chatId: state.chat, runId: state.run.id, requestId, decision, answers }, revision);
  if (state.revision === revision) await readChat(revision);
}

async function tick() {
  if (document.hidden || refreshing) return;
  refreshing = true;
  try {
    await readDevices();
    if (state.chat) await readChat(state.revision);
    else if (state.device) await readChats(state.revision);
  } catch (error) { status(error.message); }
  finally { refreshing = false; }
}

$('#back-devices').onclick = () => page('devices');
$('#back-chats').onclick = () => { page('chats'); readChats(state.revision).catch(error => status(error.message)); };
$('#older').onclick = async () => {
  const scroller = $('#transcript'), height = scroller.scrollHeight, top = scroller.scrollTop;
  try {
    const revision = state.revision;
    await readChat(revision, { before: (state.history[0] || state.current[0])?.id });
    if (state.revision === revision) scroller.scrollTop = top + scroller.scrollHeight - height;
  } catch (error) { status(error.message); }
};
$('#stop').onclick = async () => {
  if (!state.run || !confirm('停止电脑上的当前任务？')) return;
  const revision = state.revision;
  try {
    await request(state.device, { op: 'stop', chatId: state.chat, runId: state.run.id }, revision);
    if (state.revision === revision) await readChat(revision);
  } catch (error) { status(error.message); }
};
$('#draft').oninput = () => state.drafts.set(draftKey(), { text: $('#draft').value, id: newId() });
$('#composer').onsubmit = async event => {
  event.preventDefault();
  const key = draftKey(), draft = state.drafts.get(key), revision = state.revision;
  if (!draft?.text.trim() || state.run || state.send) return;
  const token = {};
  state.send = token;
  $('#send').disabled = true;
  try {
    const data = await request(state.device, { op: 'send', chatId: state.chat, id: draft.id, text: draft.text }, revision);
    if (!data) return;
    if (state.drafts.get(key) === draft) {
      state.drafts.delete(key);
      if (state.revision === revision) $('#draft').value = '';
    }
    if (state.revision === revision) await readChat(revision, { bottom: true });
  } catch (error) {
    if (state.revision === revision) status(error.message);
  } finally {
    if (state.send === token) { state.send = null; $('#send').disabled = !!state.run; }
  }
};
$('#logout').onclick = async () => {
  try { await api('/auth/logout', {}); location.replace('/?remote=1'); }
  catch (error) { status(error.message); }
};

async function start() {
  try {
    const auth = await api('/auth/session');
    state.csrf = auth.csrf;
    $('#account').textContent = auth.user.name;
    $('#logout').hidden = false;
    await tick();
    setInterval(tick, 4000);
    document.addEventListener('visibilitychange', tick);
  } catch (error) { status(error.message); }
}

start();

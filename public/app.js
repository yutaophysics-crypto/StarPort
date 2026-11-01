'use strict';

// The page's core: shared state, calls to the local server, drafts, and moving between chats.
// The other app-*.js files are loaded after this one and share its top-level names; app-start.js
// wires the page up and loads the first view. Other scripts read these globals too (state, api,
// toast, refresh, openChat …), so their names are part of the page's interface.

const i18n = globalThis.StarportI18n;
const t = i18n.t;
const notice = i18n.notice;

let connected = true;
let lastToast = null;

const $ = s => document.querySelector(s);
let token = $('meta[name="hub-token"]').content;
let tokenRefresh = null;

const state = {
  groups: [],
  chats: [],
  projects: [],
  draftGroup: null,
  providers: [],
  chat: null,
  messages: [],
  queue: [],
  queueVersion: -1,
  run: null,
  // Chats with a task running right now, from the server.
  active: [],
  selected: localStorage.getItem('hub-provider') || 'codex',
  workspace: '',
  options: {},
  filter: '',
  collapsed: new Set(),
  selectedId: localStorage.getItem('hub-chat') || null
};

// Chat edits are saved one after another; a refresh waits for them first.
let saveChain = Promise.resolve();
// Bumped whenever the view moves to another chat or changes it, so late answers are dropped.
let viewRevision = 0;
let refreshSequence = 0;
// The live event stream (live.js), connected by app-start.js.
let liveSync = null;
// The theme cover hides the chat; app-layout.js opens and closes it.
let coverOpen = false;
let toastTimer;
let editAction;

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = v;
    else if (k === 'disabled') node.disabled = v;
    else node.setAttribute(k, v);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child != null) {
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
};

const provider = id => state.providers.find(p => p.id === id);
const currentId = () => state.chat?.provider || state.selected;
const currentProvider = () => provider(currentId());

function toast(text, values = {}) {
  lastToast = { text, values };
  $('#toast').textContent = notice(t(text, values));
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 6500);
}

// A backend restart rotates the local CSRF token. Recover only after an explicit
// authentication rejection (before the server executes the request), and retry once.
async function refreshLocalToken() {
  if (tokenRefresh) return tokenRefresh;
  tokenRefresh = (async () => {
    const response = await fetch('/', { cache: 'no-store' });
    if (!response.ok) return false;
    const html = await response.text();
    const next = html.match(/name="hub-token" content="([a-f0-9]{64})"/)?.[1];
    if (!next || next === token) return false;
    token = next;
    $('meta[name="hub-token"]').content = next;
    return true;
  })();
  try {
    return await tokenRefresh;
  } finally {
    tokenRefresh = null;
  }
}

const TOKEN_REJECTED = /^(请从首页重新打开应用|请求令牌无效，请刷新页面)$/;

async function api(path, method = 'GET', data, retried = false) {
  const sentToken = token;
  const response = await fetch('/api' + path, {
    method,
    headers: {
      'X-Hub-Token': token,
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: data !== undefined ? JSON.stringify(data) : undefined
  });
  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {}
    const rejected = !retried && [401, 403].includes(response.status) && TOKEN_REJECTED.test(error?.error || '');
    // Another request may already have fetched the new token; otherwise fetch it now.
    if (rejected && (sentToken !== token || (await refreshLocalToken()))) return api(path, method, data, true);
    throw new Error(error?.error || `请求失败 (${response.status})`);
  }
  return response.json();
}

function mark(p) {
  const node = el('span', { class: 'provider-mark', text: p?.initials || 'AI' });
  node.style.setProperty('--provider-color', p?.color || '#315d50');
  return node;
}

function opts() {
  const p = currentProvider();
  const saved =
    p?.id === 'codex' && state.chat
      ? state.chat.options?.codex || {}
      : state.chat?.options?.[p?.id] || state.options[p?.id] || {};
  const values = Object.fromEntries((p?.fields || []).map(f => [f.key, saved[f.key] ?? f.default]));
  if (p?.id === 'codex') {
    const legacyReadonly =
      saved.sandbox === 'read-only' || (state.chat && saved.permissionMode == null && saved.sandbox == null);
    values.permissionMode = saved.permissionMode || 'ask';
    values.sandbox =
      values.permissionMode === 'full-access' ? 'danger-full-access' : legacyReadonly ? 'read-only' : 'workspace-write';
  }
  return values;
}

function draftKey(chatId = state.chat?.id) {
  return 'hub-draft-' + (chatId || 'new');
}

function forgetChatDraft(id) {
  localStorage.removeItem('hub-draft-' + id);
  localStorage.removeItem('starport-attachments-hub-draft-' + id);
  if (localStorage.getItem('hub-chat') === id) localStorage.removeItem('hub-chat');
}

function restoreDraft() {
  $('#prompt').value = localStorage.getItem(draftKey()) || '';
  resizePrompt();
  globalThis.StarportComposer?.render();
}

function queueSave(patch) {
  const id = state.chat?.id;
  if (!id) return Promise.resolve();
  viewRevision++;
  saveChain = saveChain.catch(() => {}).then(() => api('/chats/' + id, 'PATCH', patch));
  saveChain.catch(e => toast(e.message));
  return saveChain;
}

// Draws everything that shows the current chat: the sidebar, the top bar, the tool panel and the messages.
function renderView() {
  renderGroups();
  renderHeader();
  renderFeatures();
  renderMessages();
}

async function refresh() {
  const revision = viewRevision;
  const request = ++refreshSequence;
  await saveChain.catch(() => {});
  const version = liveSync?.revision || 0;
  const valid = () => revision === viewRevision && request === refreshSequence && version === (liveSync?.revision || 0);
  const data = await api('/state');
  if (!valid()) return;
  let result = null;
  if (state.chat) {
    if (!data.chats.some(c => c.id === state.chat.id)) {
      forgetChatDraft(state.chat.id);
      newChat();
      return;
    }
    result = await api('/chats/' + state.chat.id);
    if (!valid()) return;
  }
  applyStateList(data);
  if (result) Object.assign(state, result);
  renderView();
  globalThis.StarportMemory?.refresh().catch(() => {});
}

function applyStateList(data) {
  Object.assign(state, {
    groups: data.groups,
    chats: data.chats,
    projects: data.projects || [],
    providers: data.providers,
    active: data.active
  });
  // The open chat is a separate copy; keep its place in the list in step.
  const listed = state.chat && data.chats.find(c => c.id === state.chat.id);
  if (listed) state.chat.sort_order = listed.sort_order;
  if (!state.workspace) state.workspace = data.defaultWorkspace;
}

// The chat list's half of refresh(): folders, chats, tools and what is running, without
// rereading the open conversation (which can be tens of megabytes).
async function refreshList() {
  const revision = viewRevision;
  const request = refreshSequence;
  await saveChain.catch(() => {});
  await preferenceChain.catch(() => {});
  const version = liveSync?.revision || 0;
  const data = await api('/state');
  // A full refresh started meanwhile, or a live change arrived: that one is newer.
  if (revision !== viewRevision || request !== refreshSequence || version !== (liveSync?.revision || 0)) return;
  if (state.chat && !data.chats.some(c => c.id === state.chat.id)) return refresh();
  applyStateList(data);
  renderGroups();
  renderHeader();
  renderFeatures();
  globalThis.StarportAgentsRoom?.scheduleRender();
}

async function openChat(id) {
  closeThemeCover(false);
  const revision = ++viewRevision;
  await saveChain.catch(() => {});
  const data = await api('/chats/' + id);
  if (revision !== viewRevision) return;
  Object.assign(state, data);
  state.selectedId = id;
  localStorage.setItem('hub-chat', id);
  approvalKey = '';
  renderView();
  restoreDraft();
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
  $('.sidebar').classList.remove('open');
  liveSync?.reconcile();
  globalThis.StarportNotifications?.report();
}

const readRequests = new Set();
function markViewed() {
  if (coverOpen || document.hidden || !document.hasFocus() || !state.chat?.unread || state.run) return;
  const message = state.messages.findLast(row => row.role === 'assistant');
  const chatId = state.chat.id;
  if (message?.status !== 'complete' || message.id !== state.chat.last_assistant_id) return;
  const key = chatId + ':' + message.id;
  if (readRequests.has(key)) return;
  readRequests.add(key);
  api('/chats/' + chatId + '/read', 'POST', { messageId: message.id })
    .then(chat => {
      liveSync?.receive({ chatId, chat });
      renderGroups();
    })
    .catch(() => liveSync?.reconcile())
    .finally(() => readRequests.delete(key));
}

function newChat() {
  closeThemeCover(false);
  viewRevision++;
  state.chat = null;
  state.draftGroup = null;
  state.messages = [];
  state.queue = [];
  state.queueVersion = -1;
  state.run = null;
  state.selectedId = null;
  approvalKey = '';
  state.options.codex = { ...state.options.codex, permissionMode: 'ask', sandbox: 'workspace-write' };
  localStorage.removeItem('hub-chat');
  renderView();
  restoreDraft();
  $('#prompt').focus();
  $('.sidebar').classList.remove('open');
}

function openEditor(title, fields, action) {
  editAction = action;
  $('#edit-heading').textContent = t(title);
  const body = $('#edit-fields');
  body.replaceChildren();
  for (const field of fields) {
    const input = field.choices
      ? el(
          'select',
          { name: field.name },
          field.choices.map(c => el('option', { value: c.value, text: c.label }))
        )
      : el('input', {
          name: field.name,
          type: 'text',
          value: field.value || '',
          placeholder: t(field.placeholder || '')
        });
    input.value = field.value || '';
    const label = el('label', {}, [t(field.label), input]);
    body.append(label);
    if (field.name === 'workspace') {
      input.id = 'edit-workspace';
      const browse = el('button', { type: 'button', class: 'secondary-button', text: t('浏览…') });
      const hint = el('small', { class: 'workspace-project-hint' });
      const showProject = () => {
        const project = projectFor(input.value.trim());
        hint.textContent = project ? t('属于项目「{name}」', { name: project.name }) : t('不属于任何项目');
      };
      input.addEventListener('input', showProject);
      showProject();
      browse.onclick = () =>
        openFolderPicker(
          input.value,
          path => {
            input.value = path;
            showProject();
          },
          undefined,
          {
            onRename: (from, to) => {
              input.value = movedPath(input.value, from, to);
              showProject();
            }
          }
        );
      label.append(browse, hint);
      label.classList.add('workspace-field');
    }
  }
  $('#edit-dialog').showModal();
}

function chatSettings() {
  if (state.run) {
    toast('请先停止当前执行再修改设置。');
    return;
  }
  const fields = [
    ...(state.chat ? [{ name: 'title', label: '对话标题', value: state.chat.title }] : []),
    {
      name: 'group_id',
      label: '所属分组',
      value: (state.chat ? state.chat.group_id : state.draftGroup) || '',
      choices: [{ value: '', label: t('未分组') }, ...state.groups.map(g => ({ value: g.id, label: g.name }))]
    },
    {
      name: 'workspace',
      label: '工作目录（完整路径）',
      value: state.chat?.workspace || state.workspace
    }
  ];
  openEditor('对话设置', fields, async data => {
    if (state.chat) {
      if ('group_id' in data) data.group_id = data.group_id || null;
      await queueSave(data);
      await refresh();
    } else {
      state.workspace = data.workspace;
      state.draftGroup = data.group_id || null;
      renderHeader();
      renderFeatures();
    }
  });
}

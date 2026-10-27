'use strict';

// Workflows run on the local server: positions seated by companions, mounted on conversations.
// This file keeps the server state, sends @companion and workflow runs, and handles replying to
// a run. The files loaded after it add to the same StarportWorkflows object:
//   workflow-cards.js   run cards and each step's desk
//   workflow-editor.js  the library, the editor, workflow settings, saving a run as a workflow
//   workflow-mount.js   mounting a workflow on a conversation
//   workflow-ledger.js  the ledger dialog
//   workflow-exam.js    exam proposals and each seat's folder and checks
// The dialog building blocks shared with agents-room.js and prompt-snippets.js live in ui-kit.js.
globalThis.StarportWorkflows = (page => {
  const tr = (source, values = {}) =>
    globalThis.StarportI18n?.t(source, values) || source.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
  const notice = text => globalThis.StarportI18n?.notice(text) || text;
  const RUN_LABEL = {
    planning: '排顺序中',
    running: '运行中',
    done: '完成',
    passed: '验收通过',
    failed: '失败',
    'verify-failed': '验收未通过',
    stopped: '已停止',
    proposed: '待开考',
    cancelled: '已取消'
  };
  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

  // --- server state -------------------------------------------------------------------------
  let data = null;
  let status = 'loading';
  let loading = null;
  let again = false;
  let reloadTimer = null;
  const listeners = new Set();

  function load() {
    if (loading) {
      again = true;
      return loading;
    }
    loading = api('/workflows/state')
      .then(next => {
        data = next;
        status = 'ready';
      })
      .catch(error => {
        // A Starport that has not been restarted since the update has no workflow routes yet.
        if (/没有这个接口|\(404\)/.test(error.message)) status = 'unavailable';
        else if (!data) status = 'error';
      })
      .finally(() => {
        loading = null;
        for (const listener of listeners) listener();
        if (again) {
          again = false;
          load();
        }
      });
    return loading;
  }

  function receive() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 120);
  }

  async function call(path, method, body) {
    const result = await api(path, method, body);
    await load();
    return result;
  }

  const companions = () => data?.companions || [];
  const companion = id => companions().find(c => c.id === id) || null;
  const workflows = () => data?.workflows || [];
  const workflow = id => workflows().find(w => w.id === id) || null;
  const members = groupId => ((groupId && data?.rooms?.[groupId]) || []).map(companion).filter(Boolean);
  const memoryOf = (groupId, companionId) =>
    data?.roomMemory?.[groupId]?.[companionId] || { read: false, propose: false };
  const mountsFor = chatId => (chatId ? (data?.mounts || []).filter(m => m.chatId === chatId) : []);
  const mount = id => (data?.mounts || []).find(m => m.id === id) || null;
  const busyCompanions = () => new Set((data?.running || []).flatMap(run => run.companions));
  // What a companion is doing now: its earliest step at work, or waiting its turn at its own desk.
  function companionWork(id) {
    const steps = (data?.running || []).flatMap(run => run.steps || []).filter(step => step.companionId === id);
    const working = steps
      .filter(step => !step.queued && step.started)
      .sort((a, b) => Date.parse(a.started) - Date.parse(b.started))[0];
    return working ? { started: working.started } : steps.length ? { queued: true } : null;
  }
  const chatById = id => (state.chat?.id === id ? state.chat : (state.chats || []).find(c => c.id === id) || null);
  const positionsOf = wf => (wf?.stages || []).flatMap(stage => stage.positions.map(position => ({ stage, position })));

  // Names are matched exactly and longest first, the same way the server reads them,
  // so Chinese text right after a name is never taken as part of it.
  function parseMentions(text, list) {
    const source = String(text || '');
    const names = list.filter(c => c?.name).sort((a, b) => b.name.length - a.name.length);
    const hits = [];
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== '@' && source[i] !== '＠') continue;
      const match = names.find(c => source.startsWith(c.name, i + 1));
      if (match) {
        hits.push({ companion: match, start: i, end: i + 1 + match.name.length });
        i += match.name.length;
      }
    }
    return hits;
  }

  function mentioned(text, list) {
    return [...new Map(parseMentions(text, list).map(hit => [hit.companion.id, hit.companion])).values()];
  }

  // --- formatting ---------------------------------------------------------------------------
  function when(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (date.toDateString() === new Date().toDateString()) return time;
    return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  }

  function duration(from, to = Date.now()) {
    const seconds = Math.max(0, Math.round(((typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from)) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`;
  }

  function daysText(days) {
    const list = [...(days || [])].sort((a, b) => a - b).join(',');
    if (list === '1,2,3,4,5,6,7') return '每天';
    if (list === '1,2,3,4,5') return '周一至周五';
    if (list === '6,7') return '周末';
    return '周' + days.map(d => WEEKDAYS[d - 1]).join('、');
  }

  function triggerText(trigger) {
    if (trigger?.type === 'daily') return `${daysText(trigger.days)} ${trigger.time}`;
    if (trigger?.type === 'interval') return `每 ${trigger.every} ${trigger.unit === 'hours' ? '小时' : '分钟'}`;
    return '手动运行';
  }

  const scheduled = m => m.trigger?.type !== 'manual';

  function oneLine(text, max = 160) {
    const line = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*`_|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return line.length > max ? line.slice(0, max) + '…' : line;
  }

  // Every reply opens with 「我负责：……」; it becomes the step's subtitle.
  function splitDuty(output) {
    const text = String(output || '');
    const match = text.match(/^\s*\**\s*我负责[:：]\s*([^\n]*)\n?/);
    if (!match) return { duty: '', body: text };
    return { duty: match[1].replace(/\*+$/, '').trim(), body: text.slice(match[0].length) };
  }

  // --- shared building blocks: ui-kit.js -----------------------------------------------------
  const { el, icon, iconButton, PROVIDER_LABELS } = globalThis.StarportUI;

  // Time spent so far, counting up while the work runs. subagents.js calls tick() each second
  // along with the page's other clocks.
  const liveSince = (from, prefix = '') =>
    el('span', { class: 'live-elapsed', 'data-live-since': from, 'data-live-prefix': prefix, text: prefix + duration(from) });
  function tick() {
    for (const node of document.querySelectorAll('[data-live-since]'))
      node.textContent = node.getAttribute('data-live-prefix') + duration(node.getAttribute('data-live-since'));
  }

  // --- conversations: workflows need a saved chat ------------------------------------------
  async function ensureChat() {
    if (state.chat) return state.chat;
    const sourceDraft = draftKey();
    const draftOptions = opts();
    const chat = await api('/chats', 'POST', {
      provider: state.selected,
      workspace: state.workspace,
      group_id: state.draftGroup
    });
    state.chat = chat;
    state.messages = [];
    state.selectedId = chat.id;
    globalThis.StarportComposer?.moveDraft(sourceDraft, draftKey());
    localStorage.setItem(draftKey(), $('#prompt').value);
    await queueSave({ options: draftOptions });
    localStorage.setItem('hub-chat', chat.id);
    localStorage.removeItem('hub-draft-new');
    await refresh();
    return state.chat;
  }

  // The user's message and the run card go in place at once; the live stream keeps them current.
  function accept(chatId, { user = null, message = null }) {
    if (state.chat?.id !== chatId) return;
    for (const row of [user, message].filter(Boolean)) {
      const index = state.messages.findIndex(m => m.id === row.id);
      if (index >= 0) state.messages[index] = StarportLive.preferMessage(state.messages[index], row);
      else {
        const before = row === user && message ? state.messages.findIndex(m => m.id === message.id) : -1;
        state.messages.splice(before < 0 ? state.messages.length : before, 0, row);
      }
    }
    renderMessages();
    const conversation = $('#conversation');
    conversation.scrollTop = conversation.scrollHeight;
  }

  function clearPrompt(chatId, original) {
    if (state.chat?.id !== chatId || $('#prompt').value !== original) return;
    localStorage.removeItem(draftKey());
    $('#prompt').value = '';
    $('#prompt').dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function dispatch(text, { isolated = false } = {}) {
    const original = $('#prompt').value;
    const chat = await ensureChat();
    const result = await api('/chats/' + chat.id + '/dispatch', 'POST', isolated ? { text, isolated } : { text });
    clearPrompt(chat.id, original);
    accept(chat.id, result);
    load();
    refresh().catch(() => {});
    return result;
  }

  async function runMount(mountId, text = '') {
    const target = mount(mountId);
    if (!target) throw new Error('这个工作流已经卸下');
    const original = $('#prompt').value;
    const result = await api('/mounts/' + mountId + '/run', 'POST', { text });
    if (text) clearPrompt(target.chatId, original);
    accept(target.chatId, result);
    load();
    if (text) refresh().catch(() => {});
    return result;
  }

  function stopRun(runId) {
    return api('/workflow-runs/' + runId + '/stop', 'POST', {}).then(() => toast('正在停止…'));
  }

  // An exam proposed by the conversation's model starts only from the user's button on its card.
  const examAction = action => (chatId, messageId, body = {}) =>
    call('/chats/' + chatId + '/exams/' + messageId + '/' + action, 'POST', body).then(result => {
      if (result?.message) accept(chatId, { message: result.message });
      return result;
    });
  const startExam = examAction('start');
  const cancelExam = examAction('cancel');

  // --- replying to a run card ----------------------------------------------------------------
  let reply = null;

  function runLabel(run) {
    return `${run.title} · ${when(run.started)}`;
  }

  function startReply(msg) {
    const run = msg.details.workflowRun;
    reply = { chatId: msg.chat_id || state.chat?.id, messageId: msg.id, label: runLabel(run) };
    renderReplyChip();
    $('#prompt').focus();
  }

  function replyRef(chatId) {
    return reply && reply.chatId === chatId ? reply.messageId : null;
  }

  function clearReply() {
    reply = null;
    renderReplyChip();
  }

  function renderReplyChip() {
    let chip = document.getElementById('workflow-reply');
    if (reply && reply.chatId !== state.chat?.id) reply = null;
    if (!reply) {
      chip?.remove();
      return;
    }
    if (!chip) {
      chip = el('div', { id: 'workflow-reply', class: 'wf-reply' });
      $('#prompt').before(chip);
    }
    const target = reply.messageId;
    chip.replaceChildren(
      icon('reply'),
      el('button', {
        type: 'button',
        class: 'wf-reply-label',
        title: '回到这次运行',
        text: `回复 ${reply.label}`,
        onclick: () => scrollToMessage(target)
      }),
      el('span', { class: 'wf-reply-hint', text: '这次运行的结果会随消息一起发给对话模型' }),
      iconButton('cross', '取消回复', clearReply, 'room-tool wf-reply-close')
    );
  }

  function scrollToMessage(id) {
    const row = [...document.querySelectorAll('#messages [data-message-id]')].find(
      node => node.dataset.messageId === id
    );
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('wf-flash');
    void row.offsetWidth;
    row.classList.add('wf-flash');
  }

  function refChip(ref) {
    return el(
      'button',
      { type: 'button', class: 'wf-ref', title: '回到这次运行', onclick: () => scrollToMessage(ref.messageId) },
      [icon('reply'), el('span', { text: `回复 ${ref.label || '一次运行'}` })]
    );
  }

  // --- message bodies -------------------------------------------------------------------------
  // Run output, desks and the changelog are drawn with the chat page's own el / t / markdown
  // (app.js and app-messages.js load before this file), so they look like ordinary messages.
  // Tests load this file without the page; there the text stays plain.
  function renderMarkdown(text, plain = body => el('div', { class: 'message-body', text: body })) {
    return page ? page.markdown(text) : plain(text);
  }

  return {
    load,
    receive,
    subscribe: listener => listeners.add(listener),
    get data() {
      return data;
    },
    get status() {
      return status;
    },
    companion,
    companions,
    members,
    memoryOf,
    workflow,
    workflows,
    mount,
    mountsFor,
    busyCompanions,
    companionWork,
    liveSince,
    tick,
    positionsOf,
    parseMentions,
    mentioned,
    triggerText,
    scheduled,
    when,
    oneLine,
    splitDuty,
    RUN_LABEL,
    PROVIDER_LABELS,
    refChip,
    replyRef,
    clearReply,
    renderReplyChip,
    scrollToMessage,
    ensureChat,
    dispatch,
    runMount,
    stopRun,
    startExam,
    cancelExam,
    call,
    // Used by the workflow-*.js files.
    tr,
    notice,
    page,
    renderMarkdown,
    WEEKDAYS,
    chatById,
    duration,
    startReply
  };
})(typeof markdown === 'function' ? { el, t, markdown } : null);

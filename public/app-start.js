'use strict';

// Wires the page up and opens the first view. Loaded last of the app-*.js files.

// Live changes arrive in bursts: a full refresh waits for a quiet moment, and streamed text is
// drawn at most every 80 ms until the run ends.
let refreshTimer;
let renderTimer;

function connectEvents() {
  const connection = value => {
    connected = value;
    $('#connection-status').textContent = t(value ? '记录保存在本机' : '连接中断，正在重连');
  };
  // The page id tells the server which chat this window shows, so it is not notified about it.
  const events = new EventSource(
    '/api/events?client=' + encodeURIComponent(globalThis.StarportNotifications?.client || '')
  );
  globalThis.StarportNotifications?.listen(events);
  liveSync = StarportLive.create({
    events,
    state,
    api,
    viewRevision: () => viewRevision,
    onConnection: connection,
    onRefresh: () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refresh().catch(e => toast(e.message)), 120);
    },
    onError: () => connection(false),
    onChange: change => {
      if (change.chatChanged && state.chat) {
        const index = state.chats.findIndex(chat => chat.id === state.chat.id);
        if (index >= 0) state.chats[index] = state.chat;
        renderHeader();
      }
      if (change.chatChanged || change.sidebarChanged || change.activeChanged) renderGroups();
      if (change.chatChanged && !change.currentChanged) markViewed();
      if (change.runChanged || change.providersChanged) renderFeatures();
      if (!change.currentChanged) return;
      if (change.terminal) {
        clearTimeout(renderTimer);
        renderTimer = null;
        renderMessages();
        globalThis.StarportMemory?.refresh().catch(() => {});
      } else if (!renderTimer) {
        renderTimer = setTimeout(() => {
          renderTimer = null;
          renderMessages();
        }, 80);
      }
    }
  });
}

function applyLanguage(language = i18n.language) {
  const answers = [...document.querySelectorAll('#approvals input')].map(input => ({
    name: input.name,
    value: input.value
  }));
  const scroll = $('#conversation').scrollTop;
  i18n.setLanguage(language);
  globalThis.StarportActivity?.preference();
  globalThis.StarportNotifications?.render();
  document.documentElement.lang = i18n.language === 'en' ? 'en' : 'zh-CN';
  document.title = t('星港 · Starport');
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const attribute of ['placeholder', 'title', 'aria-label']) {
    for (const node of document.querySelectorAll('[data-i18n-' + attribute + ']')) {
      node.setAttribute(attribute, t(node.getAttribute('data-i18n-' + attribute)));
    }
  }
  for (const button of document.querySelectorAll('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === i18n.language));
  }
  $('#connection-status').textContent = t(connected ? '记录保存在本机' : '连接中断，正在重连');
  if (lastToast && !$('#toast').hidden) {
    $('#toast').textContent = notice(t(lastToast.text, lastToast.values));
  }
  renderView();
  globalThis.StarportUsage?.render();
  globalThis.StarportMemory?.translate();
  for (const saved of answers) {
    for (const input of document.querySelectorAll('#approvals input')) {
      if (input.name === saved.name) input.value = saved.value;
    }
  }
  $('#conversation').scrollTop = scroll;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) markViewed();
});
window.addEventListener('focus', markViewed);

for (const button of document.querySelectorAll('[data-language]')) {
  button.onclick = () => applyLanguage(button.dataset.language);
}

$('#composer').onsubmit = e => {
  e.preventDefault();
  sendInput().catch(error => toast(error.message));
};
$('#provider-options').onsubmit = e => e.preventDefault();
$('#prompt').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput().catch(error => toast(error.message));
  }
};
$('#prompt').oninput = () => {
  resizePrompt();
  localStorage.setItem(draftKey(), $('#prompt').value);
  renderComposerAction();
};
$('#send').onclick = event => {
  if (event.currentTarget.dataset.action !== 'stop') return;
  event.preventDefault();
  stopCurrentRun();
};

$('#theme-cover-button').onclick = openThemeCover;
$('#return-from-cover').onclick = () => closeThemeCover();
$('#new-chat').onclick = newChat;
$('#home-link').onclick = e => {
  e.preventDefault();
  newChat();
};
$('#search').oninput = e => {
  state.filter = e.target.value.toLowerCase();
  renderGroups();
};
$('#provider-select').onchange = e => switchProvider(e.target.value).catch(err => toast(err.message));
$('#workspace-button').onclick = () => {
  if (state.run) {
    toast('请先停止当前执行再修改设置。');
    return;
  }
  openFolderPicker(state.chat?.workspace || state.workspace, async path => {
    if (state.chat) {
      await queueSave({ workspace: path });
      await refresh();
    } else {
      state.workspace = path;
      renderHeader();
      renderFeatures();
    }
  });
};
$('#chat-settings').onclick = chatSettings;
$('#chat-title').onclick = chatSettings;
$('#export-chat').onclick = () => globalThis.StarportTransfer.openExport();
$('#add-group').onclick = () =>
  openEditor('新建分组', [{ name: 'name', label: '分组名称', placeholder: '例如：论文、代码、日常' }], async data => {
    await api('/groups', 'POST', data);
    await refresh();
  });
$('#connections').onclick = () => globalThis.StarportSettings.open();
$('#refresh-connections').onclick = async () => {
  const button = $('#refresh-connections');
  button.disabled = true;
  button.textContent = t('检查中…');
  try {
    await api('/providers/refresh', 'POST', {});
    await refresh();
    renderConnections();
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
    button.textContent = t('重新检查工具');
  }
};
$('#edit-form').onsubmit = async e => {
  e.preventDefault();
  try {
    await editAction(Object.fromEntries(new FormData(e.target)));
    $('#edit-dialog').close();
  } catch (e) {
    toast(e.message);
  }
};
for (const button of document.querySelectorAll('[data-close]')) {
  button.onclick = () => button.closest('dialog').close();
}
$('#export-all').onclick = () => window.open('/api/export', '_blank', 'noopener');
$('#import-all').onclick = () => $('#import-file').click();
$('#import-file').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const result = await api('/import', 'POST', JSON.parse(await file.text()));
    await refresh();
    toast('已导入 {count} 个对话', { count: result.chats });
  } catch (error) {
    toast(error.message);
  }
  e.target.value = '';
};
$('#features-toggle').onclick = () => {
  if (innerWidth <= 950) {
    $('#features').classList.toggle('open');
  } else {
    $('#features').classList.toggle('closed');
    $('.app-shell').classList.toggle('features-closed');
  }
};
$('#sidebar-toggle').onclick = () => $('.sidebar').classList.toggle('open');

setupPanelResizers();

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
  } else if (coverOpen && e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    closeThemeCover();
  }
});

applyLanguage();
refresh()
  .then(async () => {
    // A window opened from a notification starts on the chat that just finished.
    const notified = await globalThis.StarportNotifications?.boot();
    if (notified && state.chats.some(c => c.id === notified)) state.selectedId = notified;
    if (state.selectedId && state.chats.some(c => c.id === state.selectedId)) {
      await openChat(state.selectedId);
    } else {
      restoreDraft();
    }
    connectEvents();
  })
  .catch(e => toast(e.message));

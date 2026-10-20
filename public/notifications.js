'use strict';
// Task-finished notifications, page side. The server decides when to notify
// (src/notifications.mjs). This page tells it whether it is in front and which
// chat it shows, opens the chat a popup was clicked for, and owns the
// do-not-disturb bell and the 通知 settings. Without the native Windows popup
// the page shows a browser notification instead.
globalThis.StarportNotifications = (() => {
  const t = (...args) => globalThis.StarportI18n.t(...args);
  const $ = selector => document.querySelector(selector);
  const client = 'p' + String(crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  let status = { enabled: true, sound: true, native: true }, sent = '', timer = null, chime = null;

  // app.js owns state, coverOpen and api(); before it has run there is nothing to report.
  function snapshot() {
    return {
      client,
      focused: document.hasFocus(),
      visible: document.visibilityState === 'visible',
      chatId: coverOpen ? null : state.chat?.id || null,
      theme: globalThis.StarportTheme?.theme,
      language: globalThis.StarportI18n.language
    };
  }
  function report(now = false) {
    clearTimeout(timer);
    timer = setTimeout(send, now === true ? 0 : 150);
  }
  async function send() {
    let data;
    try { data = snapshot(); } catch { return; }
    const key = JSON.stringify(data);
    if (key === sent) return;
    sent = key;
    try { await api('/presence', 'POST', data); } catch { sent = ''; }
  }

  function listen(events) {
    events.addEventListener('open', () => { sent = ''; report(true); });
    events.addEventListener('notifications', event => { try { apply(JSON.parse(event.data)); } catch {} });
    events.addEventListener('notification-open', event => { try { show(JSON.parse(event.data).chatId); } catch {} });
    events.addEventListener('notification', event => { try { browser(JSON.parse(event.data)); } catch {} });
  }
  // The chat a popup was clicked for. A chat finished in another window may be new here.
  async function show(chatId) {
    if (!chatId) return;
    try {
      if (!state.chats.some(chat => chat.id === chatId)) await refresh();
      await openChat(chatId);
      report(true);
    } catch (error) {
      toast(error.message);
    }
  }
  // Called once on boot: the saved settings, and a chat to open if this window was started from a popup.
  async function boot() {
    try {
      const data = await api('/notifications');
      apply(data);
      return data.open || null;
    } catch {
      return null;
    }
  }

  function apply(next) {
    status = { ...status, ...next };
    render();
  }
  async function update(change) {
    const before = status;
    apply(change);
    try {
      apply(await api('/notifications', 'PUT', change));
      return true;
    } catch (error) {
      apply(before);
      toast(error.message);
      return false;
    }
  }
  async function toggle() {
    const enabled = !status.enabled;
    if (await update({ enabled })) toast(enabled ? '已恢复通知' : '已开启勿扰模式：任务完成时不再提醒');
  }
  async function test() {
    const button = $('#notify-test');
    button.disabled = true;
    try {
      if (!status.native && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      await api('/notifications/test', 'POST', { chatId: state.chat?.id || null });
    } catch (error) {
      toast(error.message);
    } finally {
      setTimeout(() => { button.disabled = false; }, 1200);
    }
  }

  function render() {
    const quiet = !status.enabled, bell = $('#notify-toggle');
    if (bell) {
      bell.setAttribute('aria-pressed', String(quiet));
      bell.classList.toggle('quiet', quiet);
      bell.title = t(quiet ? '勿扰模式已开启 · 点一下恢复通知' : '任务完成时提醒你 · 点一下开启勿扰');
    }
    const enabled = $('#notify-enabled'), sound = $('#notify-sound');
    enabled?.setAttribute('aria-checked', String(status.enabled));
    if (sound) {
      sound.setAttribute('aria-checked', String(status.sound));
      sound.disabled = quiet;
      sound.closest('.settings-row')?.classList.toggle('settings-row-off', quiet);
    }
    const note = $('#notify-browser');
    if (!note) return;
    note.hidden = status.native;
    if (status.native) return;
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    note.textContent = t({
      granted: '这台设备上由浏览器弹出提醒。',
      denied: '浏览器拒绝了通知，只在星港页面里提示。可以在浏览器的网站设置里重新允许。',
      unsupported: '这个浏览器不支持系统通知，只在星港页面里提示。',
      default: '这台设备上由浏览器弹出提醒，第一次需要允许通知。'
    }[permission]);
    if (permission === 'default') {
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.className = 'text-button';
      allow.textContent = t('允许通知');
      allow.onclick = () => Notification.requestPermission().then(render);
      note.append(' ', allow);
    }
  }

  // Off Windows: the same popup content as a browser notification.
  function browser(item) {
    if (item.native || !status.enabled) return;
    if (item.sound) {
      chime ??= new Audio('/api/notifications/chime.wav');
      chime.currentTime = 0;
      chime.play().catch(() => {});
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      if (document.visibilityState === 'visible') toast([item.title, item.state].filter(Boolean).join(' · '));
      return;
    }
    const note = new Notification(item.title || item.source, { body: [item.state, item.body].filter(Boolean).join(' · '), tag: item.id, icon: '/icon.svg', silent: true });
    note.onclick = () => { window.focus(); note.close(); show(item.chatId); };
    setTimeout(() => note.close(), 10000);
  }

  $('#notify-toggle')?.addEventListener('click', toggle);
  $('#notify-enabled')?.addEventListener('click', () => update({ enabled: !status.enabled }));
  $('#notify-sound')?.addEventListener('click', () => update({ sound: !status.sound }));
  $('#notify-test')?.addEventListener('click', test);
  window.addEventListener('focus', () => report(true));
  window.addEventListener('blur', () => report(true));
  document.addEventListener('visibilitychange', () => report(true));
  // Chat, cover, theme and language changes are picked up here; only changes are sent.
  setInterval(report, 2000);

  return { client, listen, report, boot, render, show, get status() { return status; } };
})();

'use strict';
// The 设置 dialog: options that apply to the whole app, one tab per kind.
// The panels are static in index.html; theme, language and activity controls
// keep their own handlers (theme.js, app.js, activity.js).
globalThis.StarportSettings = (() => {
  const dialog = document.getElementById('settings-dialog');
  const tabs = [...dialog.querySelectorAll('[data-settings-tab]')];
  let current = 'general';
  let contextTimer = null, contextChecking = false;
  dialog.addEventListener('close', () => { clearInterval(contextTimer); contextTimer = null; });

  function select(name, focus = false) {
    current = tabs.some(tab => tab.dataset.settingsTab === name) ? name : 'general';
    for (const tab of tabs) {
      const active = tab.dataset.settingsTab === current;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
      if (active && focus) tab.focus();
    }
    if (current === 'connections') renderConnections();
    if (current === 'notifications') globalThis.StarportNotifications?.render();
    dialog.querySelector('.settings-panels').scrollTop = 0;
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.dataset.settingsTab));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab), step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      const target = step ? tabs[(index + step + tabs.length) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
      if (!target) return;
      event.preventDefault();
      select(target.dataset.settingsTab, true);
    });
  }
  document.getElementById('open-workflow-settings').addEventListener('click', () => {
    dialog.close();
    globalThis.StarportWorkflows?.openSettings();
  });
  document.getElementById('open-context-settings').addEventListener('click', () => {
    dialog.close();
    globalThis.StarportContextSettings?.open();
  });

  function open(name = current) {
    select(name);
    if (!dialog.open) dialog.showModal();
  }
  async function refreshContextStatus() {
    if(contextChecking||!dialog.open)return;
    contextChecking=true;
    const status=document.getElementById('context-update-status');
    try{
      try{await api('/context/settings');status.textContent=t('后台已更新，现在可以打开上下文设置。');clearInterval(contextTimer);contextTimer=null;return;}catch(error){if(!/没有这个接口|\(404\)/.test(error.message))throw error;}
      const [live,health,pending]=await Promise.all([
        api('/live'),fetch('/health',{cache:'no-store'}).then(r=>r.json()),
        fetch('/runtime-update-'+(location.port||'80')+'.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null)
      ]);
      const queued=pending&&pending.serverPid===health.pid&&Date.now()-Date.parse(pending.at)<25000&&['waiting-for-idle','restarting'].includes(pending.state);
      const busy=live.active?.length||0;
      status.textContent=queued
        ? t('后台待更新：还有 {count} 个对话任务。所有对话和工作流结束后会自动更新，无需反复关闭窗口。',{count:busy})
        : busy?t('后台仍是旧版本，还有 {count} 个对话任务在运行。关闭窗口不会停止后台任务；请在任务结束后从桌面图标打开星港。',{count:busy})
        : t('后台仍是旧版本。请从桌面图标重新打开星港，启动器会检查并加载更新。');
    }catch(error){status.textContent=t('正在等待后台更新，稍后会自动重新检查。');}
    finally{contextChecking=false;}
  }
  function contextUnavailable(){
    const status=document.getElementById('context-update-status');
    status.hidden=false;status.textContent=t('正在检查后台更新状态…');
    open('context');clearInterval(contextTimer);contextTimer=setInterval(refreshContextStatus,3000);refreshContextStatus();
  }
  return { open, select, contextUnavailable, get tab() { return current; } };
})();

'use strict';

(() => {
  let opening = false;

  async function open() {
    if (opening) return;
    opening = true;
    const trigger = document.getElementById('collaboration');
    if (trigger) trigger.disabled = true;
    let popup = null;
    try {
      popup = StarportAccountUI.reserveWindow();
      await StarportAccountUI.enter(undefined, popup);
    } catch (e) {
      popup?.close();
      toast(e.message);
    } finally {
      opening = false;
      if (trigger) trigger.disabled = false;
    }
  }

  async function manage() {
    await StarportAccountUI.open();
  }

  document.getElementById('collaboration')?.addEventListener('click', open);
  document.getElementById('group-account-settings')?.addEventListener('click', () => {
    document.getElementById('settings-dialog')?.close();
    return manage().catch(e => toast(e.message));
  });

  globalThis.StarportDesktop = {
    open,
    manage,
    status: () => api('/collaboration/profiles')
  };
})();

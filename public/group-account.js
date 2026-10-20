'use strict';

(() => {
  const tr = (zh, en) => (StarportI18n.language === 'en' ? en : zh);

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    n.append(...children);
    return n;
  };

  const button = (text, fn, primary = false) => {
    const b = el('button', {
      type: 'button',
      class: primary ? 'primary-button' : 'secondary-button',
      text
    });
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        toast(e.message);
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };

  let dialog = null;
  let latest = null;

  function reserveWindow(mode = latest?.windowMode) {
    if (
      globalThis.webkit?.messageHandlers?.starportDesktop ||
      mode === 'windows' ||
      /^Win/.test(globalThis.navigator?.platform || '')
    ) {
      return null;
    }
    const p = window.open('about:blank', '_blank');
    if (!p) throw Error(tr('请允许星港打开新窗口', 'Please allow new windows'));
    p.opener = null;
    return p;
  }

  async function enter(profileId, popup = null) {
    try {
      const result = await api('/collaboration/windows', 'POST', profileId === undefined ? {} : { profileId });
      const native = globalThis.webkit?.messageHandlers?.starportDesktop;
      if (native) {
        native.postMessage({ action: 'openGroup', url: result.url });
      } else if (result.windowMode === 'windows') {
        popup?.close();
        await api('/collaboration/window', 'POST', { windowId: result.windowId });
      } else {
        popup ||= reserveWindow();
        popup.location.replace(result.url);
      }
      dialog?.close();
    } catch (e) {
      popup?.close();
      throw e;
    }
  }

  async function open() {
    latest = await api('/collaboration/profiles');
    if (!dialog) {
      dialog = el('dialog', { class: 'settings-dialog desktop-link-dialog account-group-dialog' });
      document.body.append(dialog);
    }
    const close = button('×', () => dialog.close());
    const body = [
      el('p', {
        class: 'muted',
        text: tr(
          '每个群聊窗口独立选择服务器和账号。账号、密码与群聊记录由所选服务器管理；模型登录留在这台电脑。',
          'Each group window selects its own server and account. Accounts and group records belong to that server; model logins stay on this computer.'
        )
      })
    ];
    for (const p of latest.profiles) {
      body.push(
        el('section', { class: 'account-section' }, [
          el('strong', { text: (p.user?.name || p.username) + '（' + p.username + '）' }),
          el('p', { class: 'muted', text: p.server }),
          el('p', {
            class: 'muted',
            text: p.connection?.deviceName
              ? tr('本机 Agent：', 'Local Agent: ') + p.connection.deviceName
              : tr('本机 Agent 尚未连接', 'Local Agent not connected')
          }),
          el('div', { class: 'account-actions' }, [
            button(tr('打开群聊', 'Open groups'), () => enter(p.id, reserveWindow()), true),
            button(tr('忘记连接', 'Forget connection'), async () => {
              if (
                !confirm(
                  tr(
                    '忘记这个服务器账号，并断开它的本机 Agent？其他账号不受影响。',
                    'Forget this server account and disconnect its local Agent? Other accounts remain connected.'
                  )
                )
              ) {
                return;
              }
              await api('/collaboration/profiles/forget', 'POST', { profileId: p.id });
              await open();
            })
          ])
        ])
      );
    }
    if (!latest.profiles.length) {
      body.push(el('p', { class: 'muted', text: tr('还没有保存的服务器账号。', 'No saved server accounts.') }));
    }
    dialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [el('h2', { text: tr('群聊账号', 'Group accounts') }), close]),
      el('div', { class: 'dialog-body' }, body),
      el('div', { class: 'dialog-footer' }, [
        button(tr('登录另一个服务器或账号', 'Sign in to another server or account'), () => enter(null, reserveWindow()), true)
      ])
    );
    if (!dialog.open) dialog.showModal();
  }

  globalThis.StarportAccountUI = { open, enter, reserveWindow };
})();

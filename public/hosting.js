'use strict';

(() => {
  const tr = (zh, en) => (StarportI18n.language === 'en' ? en : zh);

  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (['text', 'value', 'checked'].includes(k)) {
        n[k === 'text' ? 'textContent' : k] = v;
      } else {
        n.setAttribute(k, v);
      }
    }
    n.append(...children);
    return n;
  };

  const field = (title, attrs) => {
    const input = el('input', attrs);
    return { input, label: el('label', { text: title }, [input]) };
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

  function shell(title, body, footer = []) {
    if (!dialog) {
      dialog = el('dialog', { class: 'settings-dialog desktop-link-dialog account-group-dialog' });
      document.body.append(dialog);
    }
    dialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [el('h2', { text: title }), button('×', () => dialog.close())]),
      el('div', { class: 'dialog-body' }, body),
      el('div', { class: 'dialog-footer' }, footer)
    );
    if (!dialog.open) dialog.showModal();
  }

  async function accountForm(user = null) {
    const username = field(tr('账号', 'Username'), {
      required: '',
      minlength: '3',
      maxlength: '64',
      autocomplete: 'off'
    });
    const name = field(tr('显示名称', 'Display name'), {
      maxlength: '80',
      autocomplete: 'off'
    });
    const password = field(tr('新密码（至少 12 个字符）', 'New password (at least 12 characters)'), {
      required: '',
      type: 'password',
      minlength: '12',
      maxlength: '256',
      autocomplete: 'new-password'
    });
    const status = el('p', { class: 'muted', role: 'status' });
    const submit = el('button', {
      type: 'submit',
      class: 'primary-button',
      text: user ? tr('重置密码', 'Reset password') : tr('创建账号', 'Create account')
    });
    const form = el('form', { class: 'account-section' }, [
      ...(user
        ? [
            el('strong', { text: user.username }),
            el('p', {
              class: 'muted',
              text: tr(
                '重置会退出此账号的已有登录，并断开其 Agent 连接。',
                'Resetting signs this account out and disconnects its Agents.'
              )
            })
          ]
        : [username.label, name.label]),
      password.label,
      status,
      submit
    ]);

    form.onsubmit = async e => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api(
          '/collaboration/hosting/accounts' + (user ? '/password' : ''),
          'POST',
          user
            ? { userId: user.id, password: password.input.value }
            : { username: username.input.value, name: name.input.value, password: password.input.value }
        );
        await open();
        toast(tr('账号设置已保存', 'Account settings saved'));
      } catch (e) {
        status.textContent = e.message;
      } finally {
        password.input.value = '';
        submit.disabled = false;
      }
    };

    shell(
      user ? tr('重置密码', 'Reset password') : tr('创建服务器账号', 'Create server account'),
      [form],
      [button(tr('返回', 'Back'), open)]
    );
  }

  async function open() {
    const info = await api('/collaboration/hosting');
    const port = field(tr('本机端口', 'Local port'), {
      type: 'number',
      required: '',
      min: '1',
      max: '65535',
      value: info.port
    });
    const address = field(tr('对外服务器地址（可选）', 'Public server URL (optional)'), {
      type: 'url',
      value: info.publicUrl.startsWith('http://127.0.0.1:') ? '' : info.publicUrl,
      placeholder: 'https://starport.example.com'
    });
    const registration = el('input', { type: 'checkbox', checked: info.allowRegistration });
    const feedback = el('p', { class: 'muted', role: 'status' });
    const save = el('button', {
      type: 'submit',
      class: 'secondary-button',
      text: tr('保存服务器设置', 'Save server settings')
    });
    const form = el('form', { class: 'account-section' }, [
      port.label,
      address.label,
      el('label', { class: 'account-checkbox', text: tr('允许用户自行注册', 'Allow account registration') }, [
        registration
      ]),
      el('p', {
        class: 'muted',
        text: tr(
          '账号、密码验证信息与群聊记录保存在这台电脑。停止服务会暂停群聊连接，已有数据仍保留。',
          'Accounts, password verification data and group records are stored on this computer. Stopping pauses connections and preserves data.'
        )
      }),
      feedback,
      save
    ]);

    port.input.disabled = address.input.disabled = info.running || info.counts.accounts > 0;

    form.onsubmit = async e => {
      e.preventDefault();
      save.disabled = true;
      try {
        await api('/collaboration/hosting', 'PATCH', {
          port: Number(port.input.value),
          publicUrl: address.input.value.trim(),
          allowRegistration: registration.checked
        });
        await open();
        toast(tr('服务器设置已保存', 'Server settings saved'));
      } catch (e) {
        feedback.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    };

    const summary = el('section', { class: 'account-section' }, [
      el('strong', { text: info.running ? tr('服务器运行中', 'Server running') : tr('服务器已停止', 'Server stopped') }),
      el('p', { class: 'muted', text: info.publicUrl }),
      el('p', {
        class: 'muted',
        text:
          info.counts.accounts +
          ' ' +
          tr('个账号', 'accounts') +
          ' · ' +
          info.counts.groups +
          ' ' +
          tr('个群聊', 'groups')
      }),
      ...(info.error ? [el('p', { class: 'muted', text: info.error })] : []),
      button(
        info.running ? tr('停止服务器', 'Stop server') : tr('启动服务器', 'Start server'),
        async () => {
          await api('/collaboration/hosting/' + (info.running ? 'stop' : 'start'), 'POST', {});
          await open();
        },
        !info.running
      )
    ]);

    const accounts = el('section', { class: 'account-section' }, [
      el('h3', { text: tr('本服务器账号', 'Server accounts') })
    ]);
    if (info.counts.accounts || info.running) {
      const data = await api('/collaboration/hosting/accounts');
      for (const u of data.accounts) {
        accounts.append(
          el('article', { class: 'account-group-card' }, [
            el('strong', { text: u.name + '（' + u.username + '）' }),
            el('p', { class: 'muted', text: u.disabled ? tr('已停用', 'Disabled') : tr('可登录', 'Active') }),
            el('div', { class: 'account-actions' }, [
              button(tr('重置密码', 'Reset password'), () => accountForm(u)),
              button(u.disabled ? tr('启用账号', 'Enable account') : tr('停用账号', 'Disable account'), async () => {
                if (
                  !u.disabled &&
                  !confirm(
                    tr(
                      '停用 ' + u.username + ' 并退出它的已有登录和 Agent 连接？',
                      'Disable ' + u.username + ' and disconnect its sessions and Agents?'
                    )
                  )
                ) {
                  return;
                }
                await api('/collaboration/hosting/accounts/disabled', 'POST', {
                  userId: u.id,
                  disabled: !u.disabled
                });
                await open();
              })
            ])
          ])
        );
      }
      accounts.append(button(tr('创建账号', 'Create account'), () => accountForm(), true));
    } else {
      accounts.append(el('p', { class: 'muted', text: tr('启动后可以创建和管理账号。', 'Start the server to create and manage accounts.') }));
    }

    shell(
      tr('本机星港服务器', 'Local Starport server'),
      [
        summary,
        form,
        el('p', {
          class: 'muted',
          text: tr(
            '朋友连接你分享的服务器地址。跨网络使用需配置 HTTPS 域名或隧道，并保持这台电脑开机联网。',
            'Friends connect to the server URL you share. Access across networks requires an HTTPS domain or tunnel and this computer must stay online.'
          )
        }),
        accounts
      ],
      [button(tr('刷新', 'Refresh'), open)]
    );
  }

  document.getElementById('server-hosting-settings')?.addEventListener('click', () => {
    document.getElementById('settings-dialog')?.close();
    open().catch(e => toast(e.message));
  });

  globalThis.StarportHostingUI = { open };
})();

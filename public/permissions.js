'use strict';
globalThis.StarportPermissions = (() => {
  let saving = false;
  let origin = null;
  let returnFocus = null;

  const currentView = () => `${state.chat?.id || 'new'}:${currentId()}`;
  const profiles = () => currentProvider()?.fields.find(field => field.key === 'permissionMode')?.choices || [];

  const button = el('button', {
    id: 'permissions-trigger',
    type: 'button',
    class: 'permissions-trigger',
    hidden: '',
    'aria-haspopup': 'dialog'
  });
  $('.composer-foot').prepend(button);

  const dialog = el('dialog', {
    id: 'permissions-dialog',
    class: 'permissions-dialog',
    'aria-labelledby': 'permissions-title'
  });
  document.body.append(dialog);

  const shield = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: '14',
    height: '14',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'aria-hidden': 'true'
  })) {
    shield.setAttribute(k, v);
  }
  const path = document.createElementNS(shield.namespaceURI, 'path');
  path.setAttribute('d', 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z');
  shield.append(path);

  function render() {
    const visible = currentId() === 'codex';
    const value = opts().permissionMode || 'ask';
    const profile = visible ? profiles().find(item => item.value === value) : null;
    button.hidden = !visible;
    button.disabled = !!state.run || saving;

    const label = t(profile?.label || '请求批准');
    button.dataset.permission = value;
    button.setAttribute('aria-label', t('权限：{name}，点击更改', { name: label }));
    button.title = state.run ? t('任务运行中，请先停止再更改权限') : t(profile?.description || '更改 Codex 权限');
    button.replaceChildren(
      shield,
      el('span', { text: label + (visible && opts().sandbox === 'read-only' ? ' · ' + t('只读') : '') }),
      el('span', { 'aria-hidden': 'true', text: '⌄' })
    );

    const field = $('#option-sandbox');
    if (field) field.disabled = !!state.run || saving;
    if (dialog.open && (state.run || origin !== currentView())) dialog.close();
  }

  function open() {
    if (currentId() !== 'codex' || state.run || saving) return;
    const choices = profiles();
    if (!choices.length) return;

    origin = currentView();
    returnFocus = document.activeElement;
    const chatId = state.chat?.id || null;
    const initial = opts().permissionMode || 'ask';
    const legacyReadonly = opts().sandbox === 'read-only';
    let selected = initial;

    const form = el('form', { class: 'permissions-form' });
    const close = el('button', { type: 'button', class: 'icon-button', text: '×', 'aria-label': t('关闭') });
    close.onclick = () => dialog.close();
    const cancel = el('button', { type: 'button', class: 'secondary-button', text: t('取消') });
    cancel.onclick = () => dialog.close();
    const apply = el('button', {
      id: 'apply-permissions',
      type: 'submit',
      class: 'primary-button',
      text: t('应用权限'),
      disabled: true
    });
    const group = el('fieldset', { class: 'permission-choices' }, [
      el('legend', { class: 'sr-only', text: t('选择权限') })
    ]);

    const update = () => {
      apply.textContent = t(selected === 'full-access' && selected !== initial ? '启用完全访问权限' : '应用权限');
      apply.disabled = saving || (selected === initial && !legacyReadonly);
      for (const row of group.querySelectorAll('.permission-choice')) {
        row.classList.toggle('selected', row.querySelector('input').checked);
      }
    };

    for (const profile of choices) {
      const unavailable = profile.value === 'auto-review' && currentProvider()?.nativeAutoReview === false;
      const input = el('input', {
        type: 'radio',
        name: 'codex-permission',
        value: profile.value,
        checked: profile.value === initial,
        disabled: unavailable
      });
      input.dataset.unavailable = String(unavailable);
      input.onchange = () => {
        selected = input.value;
        update();
      };
      group.append(
        el(
          'label',
          {
            class: 'permission-choice' + (profile.value === initial ? ' selected' : '') + (unavailable ? ' unavailable' : ''),
            'data-permission': profile.value
          },
          [
            input,
            el('span', {}, [
              el('strong', { text: t(profile.label) }),
              el('small', {
                text: t(
                  unavailable
                    ? '本机 Codex 暂不支持自动审核，请更新后重试或选择请求批准'
                    : profile.description || ''
                )
              })
            ])
          ]
        )
      );
    }

    update();
    form.append(
      el('div', { class: 'dialog-heading' }, [el('h2', { id: 'permissions-title', text: t('Codex 权限') }), close]),
      el('div', { class: 'dialog-body' }, [
        el('p', { class: 'muted', text: t('仅影响当前星港对话，下一条消息生效。') }),
        ...(legacyReadonly
          ? [el('p', { class: 'permission-legacy', text: t('此对话保留原有只读范围。应用新的权限选项后，工作目录将允许编辑。') })]
          : []),
        group
      ]),
      el('div', { class: 'dialog-footer' }, [cancel, apply])
    );

    form.onsubmit = async event => {
      event.preventDefault();
      if (saving || state.run || origin !== currentView() || (selected === initial && !legacyReadonly)) return;
      const updated = {
        ...opts(),
        permissionMode: selected,
        sandbox: selected === 'full-access' ? 'danger-full-access' : 'workspace-write'
      };
      saving = true;
      update();
      render();
      for (const input of group.querySelectorAll('input')) input.disabled = true;
      try {
        if (chatId) {
          const saved = await queueSave({ options: updated });
          if (state.chat?.id === chatId) state.chat.options = saved.options;
        } else {
          state.options.codex = updated;
        }
        dialog.close();
        renderFeatures();
        toast('权限已更新，下一条消息生效');
      } catch (error) {
        toast(error.message);
      } finally {
        saving = false;
        for (const input of group.querySelectorAll('input')) {
          input.disabled = input.dataset.unavailable === 'true';
        }
        update();
        render();
      }
    };

    dialog.replaceChildren(form);
    dialog.showModal();
    group.querySelector('input:checked')?.focus();
  }

  button.onclick = open;
  dialog.addEventListener('close', () => {
    origin = null;
    if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true });
  });

  const api = {
    render,
    open,
    get busy() {
      return saving;
    }
  };
  render();
  return api;
})();

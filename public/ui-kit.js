'use strict';

// Shared building blocks for Starport's dialogs: DOM helpers, line icons, the one shared dialog,
// anchored menus, segmented controls and the provider / model / effort picker.
// workflows.js, agents-room.js and prompt-snippets.js all draw with these.
globalThis.StarportUI = (() => {
  const PROVIDER_LABELS = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', deepseek: 'DeepSeek' };
  // --- small DOM helpers --------------------------------------------------------------------
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (typeof v === 'function') node[k] = v;
      else if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = v;
      else if (k === 'disabled') node.disabled = v;
      else if (k === 'hidden') node.hidden = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child != null && child !== false) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  };

  const svg = (body, fill = false) =>
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    flow: svg('<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="12" r="2.2"/><circle cx="6" cy="18" r="2.2"/><path d="M8.2 6.9 15.8 11M8.2 17.1l7.6-4.1"/>'),
    at: svg('<circle cx="12" cy="12" r="3.6"/><path d="M15.6 9v4.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7"/>'),
    play: svg('<path d="M8 5.8v12.4L18 12z"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.6"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    reply: svg('<path d="M9.5 7 4.5 12l5 5"/><path d="M4.5 12H14a6 6 0 0 1 6 6v1"/>'),
    ledger: svg('<path d="M5.5 4.5H16a2.5 2.5 0 0 1 2.5 2.5v13H8a2.5 2.5 0 0 1-2.5-2.5z"/><path d="M5.5 17.5A2.5 2.5 0 0 1 8 15h10.5M9 8.5h6M9 11.5h4"/>'),
    save: svg('<path d="M7 4h10v16l-5-3.6L7 20z"/><path d="M12 7.8v5M9.5 10.3h5"/>'),
    process: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    sliders: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.5" cy="12" r="1.5"/>', true),
    alert: svg('<path d="M12 4.5 3.5 19.5h17z"/><path d="M12 10v4M12 17v.01"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    cross: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
    up: svg('<path d="M12 18.5v-13M7 10.5l5-5 5 5"/>'),
    down: svg('<path d="M12 5.5v13M7 13.5l5 5 5-5"/>'),
    trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>'),
    folder: svg('<path d="M3.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v10.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
    pause: svg('<path d="M9 6.5v11M15 6.5v11"/>'),
    eyeOff: svg('<path d="M3.5 12S6.5 6.5 12 6.5c1.3 0 2.5.3 3.6.8M20.5 12s-3 5.5-8.5 5.5c-1.3 0-2.5-.3-3.6-.8"/><path d="M10 10.1a2.7 2.7 0 0 0 3.9 3.8M5 5l14 14"/>'),
    exam: svg('<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h5"/><path d="M8.5 8h6M8.5 11.5h4"/><path d="m14.5 19.5 5-5a1.4 1.4 0 0 0-2-2l-5 5-.7 2.7z"/>'),
    book: svg('<path d="M12 6.5C10.3 5.2 7.9 4.5 4.5 4.5v13c3.4 0 5.8.7 7.5 2 1.7-1.3 4.1-2 7.5-2v-13c-3.4 0-5.8.7-7.5 2z"/><path d="M12 6.5v13"/>')
  };

  function icon(name, className = 'room-icon') {
    const node = el('span', { class: className, 'aria-hidden': 'true' });
    node.innerHTML = ICONS[name] || '';
    return node;
  }

  function avatar(c, className = 'room-avatar') {
    return el('span', { class: className, 'aria-hidden': 'true', text: c?.avatar || '·' });
  }

  function iconButton(name, label, onclick, className = 'room-tool') {
    return el('button', { type: 'button', class: className, title: label, 'aria-label': label, onclick }, [icon(name)]);
  }

  function textAction(label, onclick, disabled = false) {
    return el('button', { type: 'button', class: 'room-text-action', text: label, disabled, onclick });
  }

  function field(label, control, hint = '', action = null) {
    const hintNode = hint ? el('span', { class: 'room-field-hint', text: hint }) : null;
    if (!action) return el('label', { class: 'room-field' }, [el('span', { class: 'room-field-label', text: label }), control, hintNode]);
    // A button inside a <label> would become the labelled control, so a field with an action is a plain block.
    return el('div', { class: 'room-field' }, [
      el('div', { class: 'room-field-head' }, [el('span', { class: 'room-field-label', text: label }), action]),
      control,
      hintNode
    ]);
  }

  // --- the shared dialog --------------------------------------------------------------------
  let cleanup = null;

  function dialogNode() {
    let dialog = document.getElementById('agent-desk-dialog');
    if (dialog) return dialog;
    dialog = el('dialog', { id: 'agent-desk-dialog', class: 'agent-desk-dialog' });
    dialog.addEventListener('close', () => {
      cleanup?.();
      cleanup = null;
    });
    document.body.append(dialog);
    return dialog;
  }

  function showDialog({ title, eyebrow = '', lead = null, body = [], footer = null, onsubmit = null, size = '', focus = null, onclose = null }) {
    const dialog = dialogNode();
    cleanup?.();
    cleanup = onclose;
    dialog.className = 'agent-desk-dialog' + (size ? ' ' + size : '');
    dialog.tabIndex = -1;
    const close = el('button', { type: 'button', class: 'icon-button', text: '×', 'aria-label': '关闭', onclick: () => dialog.close() });
    const parts = [
      el('div', { class: 'dialog-heading' }, [
        el('div', { class: 'room-dialog-title' }, [
          lead,
          el('div', {}, [eyebrow ? el('p', { class: 'eyebrow', text: eyebrow }) : null, el('h2', { text: title })])
        ]),
        close
      ]),
      el('div', { class: 'dialog-body room-dialog-body' }, body),
      footer ? el('div', { class: 'dialog-footer' }, footer) : null
    ];
    const shell = el(onsubmit ? 'form' : 'div', { class: 'room-dialog-shell' }, parts);
    if (onsubmit) {
      let busy = false;
      shell.onsubmit = async e => {
        e.preventDefault();
        if (busy) return;
        busy = true;
        const submit = shell.querySelector('.dialog-footer [type=submit]');
        if (submit) submit.disabled = true;
        try {
          await onsubmit(e);
        } catch (error) {
          toast(error.message);
        } finally {
          busy = false;
          if (submit) submit.disabled = false;
        }
      };
    }
    dialog.replaceChildren(shell);
    if (!dialog.open) dialog.showModal();
    // Without this the close button takes focus and wears a focus ring the moment the dialog opens.
    (focus || dialog).focus();
    return { dialog, shell };
  }

  function closeDialog() {
    const dialog = document.getElementById('agent-desk-dialog');
    if (dialog?.open) dialog.close();
  }

  function confirmDialog({ title, eyebrow = '', text, confirm = '确定', danger = false, action, back = null }) {
    const cancel = el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: () => (back ? back() : closeDialog()) });
    const ok = el('button', { type: 'submit', class: danger ? 'danger-button' : 'primary-button', text: confirm });
    showDialog({
      eyebrow,
      title,
      body: [el('p', { class: 'room-dialog-note', text })],
      footer: [cancel, ok],
      focus: danger ? cancel : ok,
      onsubmit: async () => {
        await action();
      }
    });
  }

  // A small menu anchored to a button, styled like the chat and room menus.
  let menuNode = null;
  let menuAnchor = null;

  function closeMenu(focus = false) {
    if (!menuNode) return;
    menuNode.remove();
    menuAnchor?.setAttribute('aria-expanded', 'false');
    if (focus) menuAnchor?.focus();
    menuNode = menuAnchor = null;
  }

  function menu(anchor, items, className = '') {
    const reopen = menuAnchor === anchor;
    closeMenu();
    if (reopen) return;
    menuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    menuNode = el(
      'div',
      { class: 'chat-actions-menu wf-menu' + (className ? ' ' + className : ''), role: 'menu' },
      items.filter(Boolean).map(item =>
        item === '-'
          ? el('div', { class: 'chat-menu-separator', role: 'separator' })
          : el('button', {
              type: 'button',
              role: 'menuitem',
              class: item.danger ? 'delete-action' : '',
              text: item.label,
              title: item.title || null,
              disabled: !!item.disabled,
              onclick: () => {
                closeMenu(true);
                item.action();
              }
            })
      )
    );
    menuNode.onkeydown = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const buttons = [...menuNode.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    document.body.append(menuNode);
    const rect = anchor.getBoundingClientRect();
    menuNode.style.left = Math.max(8, Math.min(rect.right - menuNode.offsetWidth, innerWidth - menuNode.offsetWidth - 8)) + 'px';
    // Anchors near the bottom, like the composer's, open the menu upwards instead of covering themselves.
    const below = rect.bottom + 5 + menuNode.offsetHeight <= innerHeight - 8;
    menuNode.style.top = (below ? rect.bottom + 5 : Math.max(8, rect.top - 5 - menuNode.offsetHeight)) + 'px';
    menuNode.querySelector('button:not(:disabled)')?.focus();
  }

  document.addEventListener('pointerdown', e => {
    if (menuNode && !menuNode.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu();
  });
  window.addEventListener('resize', () => closeMenu());
  document.addEventListener('scroll', e => {
    if (menuNode && !menuNode.contains(e.target)) closeMenu();
  }, true);

  // Segmented control in the style of the theme's language switch.
  function segmented(options, value, onchange, label) {
    const group = el('div', { class: 'language-switch wf-segmented', role: 'group', 'aria-label': label });
    const draw = current => {
      group.replaceChildren(
        ...options.map(option =>
          el('button', {
            type: 'button',
            text: option.label,
            title: option.title || null,
            'aria-pressed': String(option.value === current),
            onclick: () => {
              draw(option.value);
              onchange(option.value);
            }
          })
        )
      );
    };
    draw(value);
    return group;
  }

  // --- model picker: provider, model and effort, loaded from the provider itself -------------
  const modelLists = new Map();

  function modelList(provider) {
    const workspace = state.chat?.workspace || state.workspace || '';
    const key = provider + '\n' + workspace;
    if (!modelLists.has(key)) {
      modelLists.set(
        key,
        api('/providers/' + provider + '/models?' + new URLSearchParams({ workspace })).catch(() => ({ models: [] }))
      );
    }
    return modelLists.get(key);
  }

  const EFFORT_FALLBACK = ['low', 'medium', 'high', 'xhigh'];

  function modelPicker({ provider = '', model = '', effort = '', service = '' } = {}, { allowNone = false } = {}) {
    const installed = id => (state.providers || []).find(p => p.id === id)?.installed !== false;
    const providerSelect = el('select', {}, [
      allowNone ? el('option', { value: '', text: '不用' }) : null,
      ...Object.entries(PROVIDER_LABELS).map(([value, label]) =>
        el('option', { value, text: label + (installed(value) ? '' : '（未找到）') })
      )
    ]);
    providerSelect.value = provider || (allowNone ? '' : 'codex');
    const modelSelect = el('select', {});
    const custom = el('input', { type: 'text', placeholder: '模型 ID', hidden: true });
    const effortSelect = el('select', {});
    let catalog = { models: [] };
    let current = { model, effort, service };

    function drawEffort() {
      const chosen = catalog.models?.find(m => m.id === modelSelect.value && (m.provider || '') === (modelSelect.selectedOptions[0]?.dataset.service || ''));
      const choices = (chosen?.effort || catalog.effort)?.choices?.map(c => ({ value: c.value, label: c.label })) ||
        EFFORT_FALLBACK.map(value => ({ value, label: value }));
      const value = effortSelect.options.length ? effortSelect.value : current.effort;
      effortSelect.replaceChildren(
        el('option', { value: '', text: '默认思考强度' }),
        ...choices.map(c => el('option', { value: c.value, text: c.label })),
        value && !choices.some(c => c.value === value) ? el('option', { value, text: `${value}（当前）` }) : ''
      );
      effortSelect.value = value || '';
    }

    async function drawModels() {
      const id = providerSelect.value;
      const none = !id;
      modelSelect.disabled = effortSelect.disabled = none;
      if (none) {
        modelSelect.replaceChildren(el('option', { value: '', text: '—' }));
        effortSelect.replaceChildren(el('option', { value: '', text: '—' }));
        custom.hidden = true;
        return;
      }
      // Until the list arrives, the current model stays selected so an early save keeps it.
      modelSelect.replaceChildren(el('option', { value: current.model, text: current.model || '正在读取模型列表…', 'data-service': current.service }));
      drawEffort();
      catalog = await modelList(id);
      if (providerSelect.value !== id) return;
      const models = catalog.models || [];
      const known = models.some(m => m.id === current.model && (!current.service || (m.provider || '') === current.service));
      modelSelect.replaceChildren(
        el('option', { value: '', text: '跟随默认模型', 'data-service': '' }),
        ...models.map(m =>
          el('option', { value: m.id, text: m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id, 'data-service': m.provider || '' })
        ),
        current.model && !known ? el('option', { value: current.model, text: `${current.model}（当前）`, 'data-service': current.service }) : '',
        el('option', { value: '__custom__', text: '手动输入模型 ID…', 'data-service': '' })
      );
      const match = [...modelSelect.options].find(o => o.value === current.model && (!current.service || o.dataset.service === current.service));
      if (match) match.selected = true;
      else modelSelect.value = '';
      custom.hidden = true;
      drawEffort();
    }

    providerSelect.onchange = () => {
      current = { model: '', effort: '', service: '' };
      effortSelect.replaceChildren();
      drawModels();
    };
    modelSelect.onchange = () => {
      custom.hidden = modelSelect.value !== '__custom__';
      if (!custom.hidden) custom.focus();
      drawEffort();
    };
    drawModels();

    return {
      provider: providerSelect,
      model: el('span', { class: 'room-field-stack' }, [modelSelect, custom]),
      effort: effortSelect,
      value() {
        const option = modelSelect.selectedOptions[0];
        const id = modelSelect.value === '__custom__' ? custom.value.trim() : modelSelect.value;
        return {
          provider: providerSelect.value,
          model: id,
          effort: effortSelect.value,
          service: providerSelect.value === 'deepseek' && modelSelect.value !== '__custom__' ? option?.dataset.service || '' : ''
        };
      }
    };
  }

  return { el, icon, avatar, iconButton, textAction, field, showDialog, closeDialog, confirmDialog, menu, closeMenu, segmented, modelPicker, PROVIDER_LABELS };
})();

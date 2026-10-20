// 提示词: named prompts kept in Starport. The composer button lists them; one click inserts one at the caret.
globalThis.StarportSnippets = (() => {
  const UI = globalThis.StarportUI;
  if (!UI) return null;
  const { el, icon, iconButton, field, showDialog, closeDialog, menu } = UI;

  let cache = null;
  const newId = () => 'p_' + Math.random().toString(36).slice(2, 12);
  const firstLine = text => (text || '').trim().split('\n')[0];

  async function load() {
    try {
      cache = (await api('/prompt-snippets')).snippets;
    } catch (error) {
      // A server started before this feature has no such route yet.
      throw new Error(/没有这个接口|\(404\)/.test(error.message) ? '星港服务还是旧版本，请关掉窗口后从桌面图标重新打开' : error.message);
    }
    return cache;
  }

  // Inserted at the caret as its own paragraph, through execCommand so Ctrl+Z takes it back out.
  function insert(input, text) {
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = !before || /(\n\n| )$/.test(before) ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const trail = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    input.focus();
    input.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, lead + text + trail)) {
      input.setRangeText(lead + text + trail, start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const caret = start + lead.length + text.length;
    input.setSelectionRange(caret, caret);
  }

  async function pick(anchor, input) {
    let list;
    try {
      list = await load();
    } catch (error) {
      toast(error.message);
      return;
    }
    const draft = input.value.trim();
    menu(
      anchor,
      [
        ...(list.length
          ? list.map(s => ({ label: s.name, title: s.text.slice(0, 300), action: () => insert(input, s.text) }))
          : [{ label: '还没有提示词', disabled: true, action: () => {} }]),
        '-',
        draft ? { label: '把输入框内容存为提示词…', action: () => manage({ text: draft }) } : null,
        { label: '管理提示词…', action: () => manage() }
      ],
      'snippet-menu'
    );
  }

  function manage(seed = null) {
    const rows = (cache || []).map(s => ({ ...s }));
    let open = null;
    let focusName = false;
    if (seed) {
      open = { id: newId(), name: '', text: seed.text };
      rows.push(open);
      focusName = true;
    }
    const list = el('div', { class: 'snippet-list' });

    const move = (i, by) => {
      const [item] = rows.splice(i, 1);
      rows.splice(Math.max(0, Math.min(rows.length, i + by)), 0, item);
      draw();
    };

    function row(s, i) {
      const expanded = open === s;
      const name = el('span', { class: 'snippet-row-name', text: s.name.trim() || '未命名' });
      const preview = el('span', { class: 'snippet-row-preview', text: firstLine(s.text) });
      const head = el('div', { class: 'snippet-row-head' }, [
        el(
          'button',
          {
            type: 'button',
            class: 'snippet-row-toggle',
            'aria-expanded': String(expanded),
            onclick: () => {
              open = expanded ? null : s;
              draw();
            }
          },
          [icon('chevron', 'room-icon snippet-chevron'), name, preview]
        ),
        el('div', { class: 'snippet-row-tools' }, [
          i > 0 ? iconButton('up', '上移', () => move(i, -1)) : null,
          i < rows.length - 1 ? iconButton('down', '下移', () => move(i, 1)) : null,
          iconButton('trash', '删除', () => {
            rows.splice(i, 1);
            if (open === s) open = null;
            draw();
          })
        ])
      ]);
      if (!expanded) return el('div', { class: 'snippet-row' }, [head]);

      const nameInput = el('input', { type: 'text', value: s.name, maxlength: '60', placeholder: '比如：深化' });
      nameInput.oninput = () => {
        s.name = nameInput.value;
        name.textContent = s.name.trim() || '未命名';
      };
      const textInput = el('textarea', { rows: '8', placeholder: '点一下就会插入输入框的内容' });
      textInput.value = s.text;
      textInput.oninput = () => {
        s.text = textInput.value;
        preview.textContent = firstLine(s.text);
      };
      if (focusName) {
        focusName = false;
        setTimeout(() => nameInput.focus());
      }
      return el('div', { class: 'snippet-row open' }, [head, el('div', { class: 'snippet-editor' }, [field('名称', nameInput), field('内容', textInput)])]);
    }

    function draw() {
      list.replaceChildren(...(rows.length ? rows.map(row) : [el('p', { class: 'room-dialog-note', text: '还没有提示词。点「新建」写第一条。' })]));
    }
    draw();

    const add = el('button', { type: 'button', class: 'secondary-button wf-footer-left' }, [icon('plus'), '新建']);
    add.onclick = () => {
      open = { id: newId(), name: '', text: '' };
      rows.push(open);
      focusName = true;
      draw();
      list.lastElementChild?.scrollIntoView({ block: 'nearest' });
    };

    showDialog({
      title: '提示词',
      size: 'wide snippets',
      body: [el('p', { class: 'room-dialog-note', text: '点输入框旁边的提示词按钮，选一条就插入到光标处。' }), list],
      footer: [add, el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: closeDialog }), el('button', { type: 'submit', class: 'primary-button', text: '保存' })],
      onsubmit: async () => {
        // A row left completely blank is dropped rather than refused.
        const kept = rows.filter(s => s.name.trim() || s.text.trim());
        const incomplete = kept.find(s => !s.name.trim() || !s.text.trim());
        if (incomplete) {
          open = incomplete;
          draw();
          throw new Error(incomplete.name.trim() ? `「${incomplete.name.trim()}」还没有内容` : '有一条提示词还没有名称');
        }
        cache = (await api('/prompt-snippets', 'PUT', { snippets: kept.map(({ id, name, text }) => ({ id, name: name.trim(), text })) })).snippets;
        closeDialog();
        toast('提示词已保存');
      }
    });
  }

  const trigger = document.getElementById('composer-snippets');
  const input = document.getElementById('prompt');
  if (trigger && input) trigger.onclick = () => pick(trigger, input);

  return { pick, manage, insert };
})();

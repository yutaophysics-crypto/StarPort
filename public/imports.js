'use strict';
globalThis.StarportImports = (() => {
  const SOURCES = {
    codex: { name: 'Codex', heading: '从 Codex 导入', search: '搜索 Codex 对话标题' },
    claude: { name: 'Claude Code', heading: '从 Claude Code 导入', search: '搜索对话标题或目录', note: '直接读取本机 Claude Code 历史，无需账号连接。' },
    antigravity: { name: 'Antigravity', heading: '从 Antigravity 导入', search: '搜索对话标题或目录', note: '直接读取本机 Antigravity 历史，无需账号连接。星港里还在的对话和子任务不显示。' },
    deepseek: { name: 'DeepSeek', heading: '从 DeepSeek 导入', search: '搜索对话标题或目录', note: '直接读取本机 DeepSeek 历史，无需账号连接。星港每轮自动开的会话和子任务不显示。' }
  };
  const NAMES = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', deepseek: 'DeepSeek' };
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  })) {
    icon.setAttribute(k, v);
  }
  const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  iconPath.setAttribute('d', 'M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2');
  icon.append(iconPath);
  const button = el('button', { id: 'import-conversations', type: 'button', class: 'plain-button' }, [
    icon,
    el('b', { class: 'i18n-text', 'data-i18n': '导入对话', text: t('导入对话') })
  ]);
  $('.sidebar-bottom').prepend(button);

  const dialog = el('dialog', { id: 'history-dialog', class: 'history-dialog', 'aria-labelledby': 'history-title' });
  document.body.append(dialog);

  let generation = 0;
  let previewGeneration = 0;
  let busy = false;
  let stop = false;
  let searchTimer;

  button.onclick = open;
  dialog.addEventListener('cancel', e => {
    if (busy) e.preventDefault();
  });
  dialog.addEventListener('close', () => {
    generation++;
    previewGeneration++;
    clearTimeout(searchTimer);
    button.focus();
  });

  function open() {
    let rows = [];
    let nextCursor = null;
    let selected = new Map();
    let loading = false;
    let activePreview = null;
    let sourceId = Object.hasOwn(SOURCES, currentId()) ? currentId() : 'codex';

    const close = el('button', { type: 'button', class: 'icon-button', text: '×', 'aria-label': t('关闭') });
    close.onclick = () => dialog.close();

    const source = el('select', { id: 'history-source', 'aria-label': t('导入来源') }, [
      el('option', { value: 'codex', text: 'Codex' }),
      el('option', { value: 'claude', text: 'Claude Code' }),
      el('option', { value: 'antigravity', text: 'Antigravity' }),
      el('option', { value: 'deepseek', text: 'DeepSeek' }),
      el('option', { value: 'starport', text: t('星港会话文件') })
    ]);
    source.value = sourceId;

    const sourceNote = el('span', { class: 'muted history-source-note' });
    const heading = el('h2', { id: 'history-title' });
    const sourceRow = el('div', { class: 'history-source' }, [
      el('label', { for: 'history-source', text: t('导入来源') }),
      source,
      sourceNote
    ]);

    const search = el('input', { type: 'search', maxlength: '300' });
    const archive = el('select', { 'aria-label': t('已归档') }, [
      el('option', { value: 'false', text: t('未归档') }),
      el('option', { value: 'true', text: t('已归档') })
    ]);
    const reload = el('button', { type: 'button', class: 'secondary-button', text: t('刷新列表') });
    const searchForm = el('form', { class: 'history-search' }, [search, archive, reload]);
    const list = el('div', { class: 'history-list', 'aria-label': t('本机对话历史') });
    const info = el('p', { class: 'muted history-info', role: 'status' });
    const selectAll = el('input', { type: 'checkbox', 'aria-label': t('选择本页') });
    const count = el('span', { class: 'muted' });
    const more = el('button', { type: 'button', class: 'secondary-button', text: t('加载更多') });
    const preview = el('section', { class: 'history-preview', 'aria-label': t('预览') }, [
      el('p', { class: 'muted', text: t('选择一段对话预览') })
    ]);

    const group = el('select', { id: 'history-group' }, [
      el('option', { value: '', text: t('未分组') }),
      ...state.groups.map(g => el('option', { value: g.id, text: g.name })),
      el('option', { value: '__new', text: t('新建分组…') })
    ]);
    group.value = state.chat?.group_id || state.draftGroup || '';

    const groupName = el('input', {
      id: 'history-group-name',
      placeholder: t('新分组名称'),
      'aria-label': t('新分组名称'),
      maxlength: '120'
    });
    groupName.hidden = true;
    group.onchange = () => {
      groupName.hidden = group.value !== '__new';
      if (!groupName.hidden) groupName.focus();
    };

    const submit = el('button', { type: 'button', class: 'primary-button', text: t('导入所选对话'), disabled: true });
    const cancel = el('button', { type: 'button', class: 'secondary-button', text: t('完成当前对话后停止') });
    cancel.hidden = true;
    cancel.onclick = () => {
      stop = true;
      cancel.disabled = true;
      cancel.textContent = t('正在停止…');
    };

    const status = el('p', { class: 'history-result', role: 'status' });
    const errors = el('div', { class: 'history-errors', role: 'status' });

    dialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [
        el('div', {}, [el('p', { class: 'eyebrow', text: t('本机对话历史') }), heading]),
        close
      ]),
      el('div', { class: 'history-body' }, [
        el('div', { class: 'history-intro' }, [
          el('p', { text: t('把已有的对话带到星港。') }),
          el('p', { class: 'muted', text: t('复制文字消息、标题、时间、工作目录和工具调用记录；工具调用只作记录，不会重新执行。图片、文件仅保留引用，隐藏的思考过程不复制。原对话保持不变；后续在星港独立继续。') })
        ]),
        sourceRow,
        searchForm,
        el('div', { class: 'history-columns' }, [
          el('section', { class: 'history-catalog' }, [
            el('div', { class: 'history-selection' }, [el('label', {}, [selectAll, t('选择本页')]), count]),
            info,
            list,
            more
          ]),
          preview
        ]),
        el('div', { class: 'history-destination' }, [
          el('label', { for: 'history-group', text: t('导入到分组') }),
          group,
          groupName
        ]),
        el('div', { class: 'history-feedback' }, [status, errors])
      ]),
      el('div', { class: 'dialog-footer' }, [cancel, submit])
    );
    dialog.showModal();

    function sourceLabels() {
      const labels = SOURCES[sourceId];
      heading.textContent = t(labels.heading);
      search.placeholder = t(labels.search);
      search.setAttribute('aria-label', search.placeholder);
      archive.hidden = sourceId !== 'codex';
      sourceNote.textContent = labels.note ? t(labels.note) : '';
    }

    function controls() {
      count.textContent = t('已选 {count} 个', { count: selected.size });
      submit.disabled = busy || !selected.size;
      const available = rows.filter(r => !r.importedChatId);
      const checked = available.filter(r => selected.has(r.id)).length;
      selectAll.checked = !!available.length && checked === available.length;
      selectAll.indeterminate = checked > 0 && checked < available.length;
      selectAll.disabled = busy || loading || !available.length;
      more.hidden = !nextCursor;
      more.disabled = loading || busy;
      for (const node of [source, search, archive, reload, group, groupName, close]) {
        node.disabled = busy;
      }
    }

    function renderRows() {
      list.replaceChildren();
      for (const row of rows) {
        const checkbox = el('input', {
          type: 'checkbox',
          checked: selected.has(row.id),
          disabled: busy || !!row.importedChatId,
          'aria-label': row.title
        });
        checkbox.onchange = () => {
          checkbox.checked ? selected.set(row.id, row) : selected.delete(row.id);
          controls();
        };
        const title = el('button', {
          type: 'button',
          class: 'history-row-title',
          text: row.title,
          'aria-label': t('预览') + ': ' + row.title,
          'aria-pressed': String(activePreview === row.id)
        });
        title.onclick = () => showPreview(row);
        const meta = el('div', { class: 'history-row-meta' }, [
          el('span', { text: new Date(row.updated).toLocaleDateString(i18n.locale) }),
          row.origin === 'starport'
            ? el('span', { class: 'history-origin', text: t('星港发起'), title: t('这段对话由星港发起，星港里已没有它') })
            : null,
          el('span', { text: row.workspace, title: row.workspace })
        ]);
        const item = el('div', { class: 'history-row' + (activePreview === row.id ? ' selected' : '') }, [
          checkbox,
          el('div', { class: 'history-row-content' }, [title, meta])
        ]);
        if (row.importedChatId) {
          const view = el('button', {
            type: 'button',
            class: 'history-imported',
            text: t('已导入'),
            title: t('打开'),
            disabled: busy
          });
          view.onclick = async () => {
            dialog.close();
            try {
              await refresh();
              await openChat(row.importedChatId);
            } catch (e) {
              toast(e.message);
            }
          };
          item.append(view);
        }
        list.append(item);
      }
      controls();
    }

    async function load(append = false) {
      clearTimeout(searchTimer);
      if (!dialog.open || busy) return;
      const revision = ++generation;
      loading = true;
      if (!append) {
        rows = [];
        nextCursor = null;
        renderRows();
      }
      info.textContent = t('读取中…');
      controls();
      try {
        const query = new URLSearchParams({ search: search.value, archived: archive.value });
        if (append && nextCursor) query.set('cursor', nextCursor);
        const result = await api('/history/' + sourceId + '?' + query);
        if (revision !== generation || !dialog.open) return;
        const ids = new Set(rows.map(r => r.id));
        rows.push(...result.data.filter(r => !ids.has(r.id)));
        nextCursor = result.nextCursor;
        info.textContent = rows.length ? '' : t('没有找到对话');
        renderRows();
      } catch (e) {
        if (revision === generation) info.textContent = notice(e.message);
      } finally {
        if (revision === generation) {
          loading = false;
          controls();
        }
      }
    }

    async function showPreview(row) {
      const revision = ++previewGeneration;
      activePreview = row.id;
      renderRows();
      preview.replaceChildren(el('p', { class: 'muted', text: t('读取中…') }));
      try {
        const result = await api('/history/' + sourceId + '/preview?id=' + encodeURIComponent(row.id));
        if (revision !== previewGeneration || !dialog.open) return;
        preview.replaceChildren(
          el('h3', { text: result.title }),
          el('p', { class: 'muted history-folder', text: t('原工作目录') + ' · ' + result.workspace }),
          el('p', { class: 'history-preview-note', text: t('预览只显示开头部分，导入时会读取全部文字消息。') })
        );
        if (!result.messages.length) {
          preview.append(el('p', { class: 'muted', text: t('这段对话没有可导入的用户或助手消息') }));
        }
        for (const message of result.messages) {
          preview.append(
            el('article', { class: 'history-preview-message' }, [
              el('b', { text: message.role === 'user' ? t('你') : NAMES[message.provider] || SOURCES[sourceId].name }),
              el('div', { text: message.content })
            ])
          );
        }
      } catch (e) {
        if (revision === previewGeneration) {
          preview.replaceChildren(el('p', { class: 'error-note', text: notice(e.message) }));
        }
      }
    }

    searchForm.onsubmit = e => {
      e.preventDefault();
      if (!busy) load();
    };
    reload.onclick = () => load();
    archive.onchange = () => load();
    source.onchange = () => {
      if (busy) return;
      if (source.value === 'starport') { dialog.close(); globalThis.StarportTransfer.openImport(); return; }
      sourceId = source.value;
      generation++;
      previewGeneration++;
      selected.clear();
      activePreview = null;
      search.value = '';
      archive.value = 'false';
      status.textContent = '';
      errors.replaceChildren();
      preview.replaceChildren(el('p', { class: 'muted', text: t('选择一段对话预览') }));
      sourceLabels();
      load();
    };
    search.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(), 300);
    };
    more.onclick = () => load(true);
    selectAll.onchange = () => {
      for (const row of rows.filter(r => !r.importedChatId)) {
        selectAll.checked ? selected.set(row.id, row) : selected.delete(row.id);
      }
      renderRows();
    };
    submit.onclick = async () => {
      if (busy || !selected.size) return;
      if (group.value === '__new' && !groupName.value.trim()) {
        groupName.focus();
        status.textContent = t('请填写新分组名称');
        return;
      }
      busy = true;
      stop = false;
      generation++;
      loading = false;
      cancel.hidden = false;
      cancel.disabled = false;
      cancel.textContent = t('完成当前对话后停止');
      errors.replaceChildren();
      renderRows();
      const pending = [...selected.values()];
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      try {
        let groupId = group.value || null;
        if (groupId === '__new') {
          const created = await api('/groups', 'POST', { name: groupName.value.trim() });
          group.insertBefore(el('option', { value: created.id, text: created.name }), group.lastElementChild);
          group.value = groupId = created.id;
          groupName.hidden = true;
        }
        for (const [index, row] of pending.entries()) {
          if (stop) break;
          status.textContent = t('正在导入 {current}/{total}', { current: index + 1, total: pending.length });
          try {
            const result = await api('/history/' + sourceId + '/import', 'POST', { id: row.id, group_id: groupId });
            result.status === 'skipped' ? skipped++ : imported++;
            selected.delete(row.id);
            row.importedChatId = result.chatId;
            const visible = rows.find(r => r.id === row.id);
            if (visible) visible.importedChatId = result.chatId;
          } catch (e) {
            failed++;
            errors.append(
              el('p', {
                class: 'error-note',
                text: t('导入失败：{name} — {error}', { name: row.title, error: notice(e.message) })
              })
            );
          }
          renderRows();
        }
        status.textContent = t('完成：导入 {imported} 个，跳过 {skipped} 个，失败 {failed} 个', {
          imported,
          skipped,
          failed
        });
      } catch (e) {
        status.textContent = notice(e.message);
      } finally {
        busy = false;
        cancel.hidden = true;
        renderRows();
        await refresh().catch(e => toast(e.message));
      }
    };
    sourceLabels();
    load();
  }

  return { open };
})();

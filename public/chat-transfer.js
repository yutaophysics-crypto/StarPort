'use strict';
globalThis.StarportTransfer = (() => {
  const dialog = el('dialog', { id: 'chat-transfer-dialog', class: 'chat-transfer-dialog', 'aria-labelledby': 'chat-transfer-title' });
  document.body.append(dialog);
  let busy = false, generation = 0, returnFocus;
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; returnFocus?.focus(); });
  function shell(title, content, buttons) {
    returnFocus = document.activeElement;
    const close = el('button', { type: 'button', class: 'icon-button', text: '×', 'aria-label': t('关闭') });
    close.onclick = () => { if (!busy) dialog.close(); };
    dialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [el('h2', { id: 'chat-transfer-title', text: t(title) }), close]),
      el('div', { class: 'dialog-body' }, content),
      el('div', { class: 'dialog-footer' }, buttons)
    );
    dialog.showModal();
    return close;
  }
  function openExport(chat = state.chat) {
    if (!chat) return;
    const file = el('button', { type: 'button', id: 'export-conversation-file', class: 'primary-button', text: t('导出会话文件') });
    const markdown = el('button', { type: 'button', class: 'secondary-button', text: t('导出 Markdown') });
    const error = el('p', { class: 'error-note', role: 'alert' }); error.hidden = true;
    const close = shell('导出对话', [
      el('h3', { text: chat.title }),
      el('p', { text: t('会话文件可在另一台电脑的星港中导入，继续这段对话。') }),
      el('p', { class: 'muted', text: t('包含消息、时间、已保存的执行过程和上传附件。工作目录中的文件需另行搬迁；文件夹引用需在新电脑重新添加。') }),
      el('p', { class: 'muted', text: t('长期记忆使用单独的记忆同步；账号登录、任务队列和权限设置不随会话迁移。') }),
      error
    ], [markdown, file]);
    markdown.onclick = () => { window.open('/api/chats/' + chat.id + '/export', '_blank', 'noopener'); dialog.close(); };
    file.onclick = async () => {
      if (busy) return; busy = true; error.hidden = true;
      file.disabled = markdown.disabled = close.disabled = true; file.textContent = t('正在导出…');
      try {
        const response = await fetch('/api/chats/' + chat.id + '/export?format=starport', { headers: { 'X-Hub-Token': token } });
        if (!response.ok) throw new Error((await response.json()).error);
        const blob = await response.blob(), url = URL.createObjectURL(blob);
        const link = el('a', { href: url, download: (chat.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'conversation') + '.starport.json' });
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        dialog.close(); toast('会话文件已导出');
      } catch (e) { error.textContent = notice(e.message); error.hidden = false; }
      finally { busy = false; file.disabled = markdown.disabled = close.disabled = false; file.textContent = t('导出会话文件'); }
    };
  }
  function openImport() {
    let conversation = null, preview = null;
    const revision = ++generation;
    const choose = el('input', { id: 'conversation-file', type: 'file', accept: '.json,application/json' });
    const summary = el('section', { class: 'transfer-preview', 'aria-live': 'polite' });
    const group = el('select', { id: 'transfer-group' }, [
      el('option', { value: '', text: t('未分组') }),
      ...state.groups.map(row => el('option', { value: row.id, text: row.name })),
      el('option', { value: '__new__', text: t('新建分组…') })
    ]);
    group.value = state.chat?.group_id || state.draftGroup || '';
    const name = el('input', { id: 'transfer-group-name', maxlength: '120', placeholder: t('新分组名称'), 'aria-label': t('新分组名称') }); name.hidden = true;
    const workspace = el('input', { id: 'transfer-workspace', maxlength: '2000', value: state.defaultWorkspace || state.workspace || '', placeholder: t('未选择时使用本机默认目录') });
    const browse = el('button', { type: 'button', class: 'secondary-button', text: t('浏览…') });
    browse.onclick = () => openFolderPicker(workspace.value, path => { workspace.value = path; });
    const error = el('p', { class: 'error-note', role: 'alert' }); error.hidden = true;
    const submit = el('button', { type: 'button', id: 'import-conversation-file', class: 'primary-button', text: t('导入对话'), disabled: true });
    const cancel = el('button', { type: 'button', class: 'secondary-button', text: t('取消') });
    const close = shell('从星港文件导入', [
      el('p', { text: t('选择另一台电脑导出的 .starport.json 会话文件。') }),
      el('label', { for: 'conversation-file', text: t('会话文件') }), choose, summary,
      el('label', { for: 'transfer-group', text: t('导入到分组') }), group, name,
      el('label', { for: 'transfer-workspace', text: t('本机工作目录') }),
      el('div', { class: 'transfer-folder' }, [workspace, browse]),
      el('p', { class: 'muted', text: t('导入后使用本机登录与新会话。不会自动执行任务，也不会沿用原电脑的高权限设置。') }), error
    ], [cancel, submit]);
    cancel.onclick = () => { if (!busy) dialog.close(); };
    const update = () => {
      name.hidden = group.value !== '__new__';
      submit.disabled = busy || !conversation || group.value === '__new__' && !name.value.trim();
      submit.textContent = t(preview?.alreadyImportedChatId ? '打开已导入的对话' : '导入对话');
    };
    group.onchange = () => { update(); if (!name.hidden) name.focus(); }; name.oninput = update;
    choose.onchange = async () => {
      const file = choose.files[0]; conversation = preview = null; summary.replaceChildren(); error.hidden = true; update();
      if (!file) return;
      busy = true; [choose, group, name, workspace, browse, close, cancel].forEach(node => node.disabled = true); update();
      try {
        if (file.size > 120 * 1024 * 1024) throw new Error(t('会话文件超过 120 MB'));
        let data; try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { throw new Error(t('会话文件不是有效的 JSON')); }
        const result = await api('/chat-transfer/preview', 'POST', data);
        if (generation !== revision || !dialog.open) return;
        conversation = data; preview = result;
        summary.append(el('h3', { text: result.title }), el('p', { class: 'muted', text: t('{messages} 条消息 · {attachments} 个附件', result) }),
          el('p', { class: 'muted', text: t('原工作目录') + ' · ' + (result.workspace || '—') }));
        if (result.externalFolders) summary.append(el('p', { class: 'muted', text: t('{count} 个文件夹引用需在本机重新添加', { count: result.externalFolders }) }));
        if (result.interrupted) summary.append(el('p', { class: 'muted', text: t('文件包含未完成的输出，导入后保留为已中断。') }));
        if (result.alreadyImportedChatId) summary.append(el('p', { text: t('这份会话已经导入，不会重复创建。') }));
        else {
          const matching = state.groups.find(row => row.name === result.groupName);
          if (matching) group.value = matching.id;
          else if (result.groupName) { group.value = '__new__'; name.value = result.groupName; }
        }
        for (const row of result.preview) summary.append(el('article', { class: 'history-preview-message' }, [
          el('b', { text: row.role === 'user' ? t('你') : row.provider || t('助手') }), el('div', { text: row.content })
        ]));
      } catch (e) { error.textContent = notice(e.message); error.hidden = false; }
      finally { busy = false; [choose, group, name, workspace, browse, close, cancel].forEach(node => node.disabled = false); update(); }
    };
    submit.onclick = async () => {
      if (busy || !conversation || submit.disabled) return; busy = true; error.hidden = true;
      [choose, group, name, workspace, browse, close, cancel, submit].forEach(node => node.disabled = true); submit.textContent = t('正在导入…');
      try {
        const result = await api('/chat-transfer/import', 'POST', {
          conversation, workspace: workspace.value.trim(), group_id: group.value === '__new__' ? null : group.value || null,
          group_name: group.value === '__new__' ? name.value.trim() : ''
        });
        await refresh(); await openChat(result.chatId); dialog.close();
        toast(result.status === 'skipped' ? '已打开此前导入的对话' : '会话已导入，可以继续聊天');
      } catch (e) { error.textContent = notice(e.message); error.hidden = false; }
      finally { busy = false; [choose, group, name, workspace, browse, close, cancel].forEach(node => node.disabled = false); update(); }
    };
  }
  return { openExport, openImport };
})();

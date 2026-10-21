'use strict';

// Folder paths and projects (each selected working folder is a project), and the folder picker.

// Splits an absolute path into clickable address-bar steps; UNC and other roots stay whole.
function folderTrail(path) {
  const drive = /^[a-z]:\\/i.exec(path)?.[0];
  if (!drive && !path.startsWith('/')) return [{ label: path, path }];
  const root = drive || '/';
  const separator = drive ? '\\' : '/';
  const parts = [{ label: drive ? drive.slice(0, 2) : '/', path: root }];
  let at = root;
  for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    at += (at.endsWith(separator) ? '' : separator) + part;
    parts.push({ label: part, path: at });
  }
  return parts;
}

// Windows paths compare case-insensitively, with either slash.
const folderKey = path =>
  String(path || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
function inFolder(path, folder) {
  const p = folderKey(path);
  const f = folderKey(folder);
  return !!p && !!f && (p === f || p.startsWith(f + '\\'));
}
// A project is this exact folder; a parent's project does not include its subfolders.
function projectFor(path) {
  return (
    (state.projects || []).find(p => p.workspace && folderKey(path) === folderKey(p.workspace)) || null
  );
}
function currentProject() {
  return state.chat ? state.projects.find(p => p.id === state.chat.project_id) || null : projectFor(state.workspace);
}
// After a folder is renamed in Starport, paths the page still holds move with it.
function movedPath(path, from, to) {
  return inFolder(path, from) ? to + String(path).slice(String(from).replace(/[\\/]+$/, '').length) : path;
}

// options.projects: show project information (off for pickers that only attach a path);
// options.onRename(from, to): the caller keeps any path it holds in step with a rename.
function openFolderPicker(initial, onSelect, title = '选择工作目录', options = {}) {
  const dialog = $('#folder-dialog');
  dialog.replaceChildren();
  let current = null;
  let request = 0;
  let creating = false;
  let renaming = false;
  const showProjects = options.projects !== false;
  const visited = [];
  let recent = [...new Set(state.chats.map(chat => chat.workspace).filter(Boolean))].slice(0, 5);
  const baseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;

  const back = el('button', {
    type: 'button',
    class: 'icon-button folder-nav',
    text: '←',
    'aria-label': t('后退'),
    title: t('后退') + ' · Alt ←',
    disabled: true
  });
  const up = el('button', {
    type: 'button',
    class: 'icon-button folder-nav',
    text: '↑',
    'aria-label': t('上一级'),
    title: t('上一级') + ' · Alt ↑',
    disabled: true
  });
  const crumbs = el('nav', { class: 'folder-crumbs', 'aria-label': t('当前位置') });
  const pathInput = el('input', {
    id: 'folder-path',
    type: 'text',
    value: initial,
    'aria-label': t('文件夹路径'),
    placeholder: t('输入或粘贴完整路径')
  });
  const go = el('button', { type: 'submit', class: 'secondary-button', text: t('打开') });
  const form = el('form', { class: 'folder-path-form' }, [pathInput, go]);
  form.hidden = true;
  const edit = el('button', {
    type: 'button',
    class: 'icon-button folder-nav',
    text: '✎',
    'aria-label': t('编辑路径'),
    title: t('编辑路径') + ' · Ctrl L'
  });
  const places = el('nav', { class: 'folder-places', 'aria-label': t('常用位置') });
  const search = el('input', {
    id: 'folder-search',
    type: 'search',
    placeholder: t('筛选文件夹'),
    'aria-label': t('筛选文件夹')
  });
  const create = el('button', {
    type: 'button',
    class: 'secondary-button folder-create',
    text: '＋ ' + t('新建文件夹'),
    disabled: true
  });
  const rename = el('button', {
    type: 'button',
    class: 'secondary-button folder-create',
    text: t('重命名'),
    title: t('给当前文件夹改名，星港里用到它的对话和项目会一起更新'),
    disabled: true
  });
  const projectLine = el('div', { class: 'folder-project', hidden: true });
  const status = el('p', { class: 'folder-status', role: 'status' });
  const list = el('div', { class: 'folder-list', id: 'folder-list', 'aria-label': t('文件夹') });
  const selected = el('p', { class: 'folder-selection', id: 'folder-selection' });
  const choose = el('button', {
    id: 'folder-choose',
    type: 'button',
    class: 'primary-button',
    text: t('选择此文件夹'),
    disabled: true
  });
  const cancel = el('button', { type: 'button', class: 'secondary-button', text: t('取消') });
  cancel.onclick = () => dialog.close();
  const close = el('button', { type: 'button', class: 'icon-button', text: '×', 'aria-label': t('关闭') });
  close.onclick = () => dialog.close();

  function draw() {
    const folders = (current?.folders || []).filter(f =>
      f.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())
    );
    list.replaceChildren(
      ...folders.map(folder => {
        const button = el('button', { type: 'button', class: 'folder-entry', title: folder.path }, [
          el('span', { 'aria-hidden': 'true', text: '⌑' }),
          el('span', { text: folder.name }),
          ...(showProjects && folder.project ? [el('small', { class: 'folder-tag', text: t('项目') })] : []),
          el('span', { 'aria-hidden': 'true', text: '›' })
        ]);
        button.onclick = () => navigate(folder.path);
        return button;
      })
    );
    if (!folders.length) {
      list.append(el('p', { class: 'muted', text: t(search.value ? '没有匹配的文件夹' : '此处没有子文件夹') }));
    }
  }

  function drawCrumbs() {
    const parts = folderTrail(current.path);
    crumbs.replaceChildren(
      ...parts.flatMap((part, index) => {
        const button = el('button', { type: 'button', class: 'folder-crumb', text: part.label, title: part.path });
        if (index === parts.length - 1) button.setAttribute('aria-current', 'location');
        button.onclick = () => navigate(part.path);
        return index ? [el('span', { class: 'folder-crumb-gap', 'aria-hidden': 'true', text: '›' }), button] : [button];
      })
    );
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function drawPlaces() {
    const roots = current?.roots || [];
    const drive = root => (root.kind ? root.kind === 'drive' : /^(?:[A-Z]:|\/)$/.test(root.label));
    const glyphs = { 桌面: '▭', 文档: '▤', 下载: '↓', 主目录: '⌂', 默认工作目录: '✦' };
    const placeName = root => (root.label === '下载' && i18n.language === 'en' ? 'Downloads' : t(root.label));
    const place = (label, path, glyph) => {
      const button = el('button', { type: 'button', class: 'folder-place', title: path }, [
        el('span', { 'aria-hidden': 'true', text: glyph }),
        el('span', { text: label })
      ]);
      if (path === current?.path) button.setAttribute('aria-current', 'location');
      button.onclick = () => navigate(path);
      return button;
    };
    const section = (title, items) => (items.length ? [el('h3', { text: t(title) }), ...items] : []);
    places.replaceChildren(
      ...section(
        '快速访问',
        roots.filter(root => !drive(root)).map(root => place(placeName(root), root.path, glyphs[root.label] || '⌑'))
      ),
      ...section(
        '最近使用',
        recent.map(path => place(baseName(path), path, '◷'))
      ),
      ...section(
        '此电脑',
        roots.filter(drive).map(root => place(root.label, root.path, '◫'))
      )
    );
  }

  function drawProject() {
    const project = current?.project;
    projectLine.hidden = !showProjects || !current;
    if (projectLine.hidden) return;
    projectLine.classList.add('is-project');
    projectLine.replaceChildren(
      el('strong', { text: t('项目「{name}」', { name: project?.name || baseName(current.path) }) }),
      el('small', { text: t('工作文件夹就是项目。同一文件夹里的对话共用项目要求和项目记忆；子文件夹各自独立。') })
    );
  }

  function editPath(editing) {
    form.hidden = !editing;
    crumbs.hidden = edit.hidden = editing;
    if (editing) {
      pathInput.value = current?.path || pathInput.value;
      pathInput.focus();
      pathInput.select();
    } else {
      choose.disabled = !current;
    }
  }

  async function navigate(path, remember = true) {
    const revision = ++request;
    const from = current?.path;
    choose.disabled = up.disabled = back.disabled = create.disabled = rename.disabled = true;
    status.textContent = t('正在读取文件夹…');
    list.setAttribute('aria-busy', 'true');
    try {
      const result = await api('/folders?' + new URLSearchParams({ path }));
      if (revision !== request || !dialog.open) return;
      if (remember && from && from !== result.path) visited.push(from);
      const editing = !form.hidden;
      current = result;
      search.value = '';
      status.textContent = t('点击文件夹进入，然后选择当前位置。');
      selected.textContent = current.path;
      selected.title = current.path;
      draw();
      drawCrumbs();
      drawPlaces();
      drawProject();
      editPath(false);
      create.disabled = false;
      rename.disabled = !current.parent;
      if (editing) (list.querySelector('.folder-entry') || search).focus();
    } catch (error) {
      if (revision !== request) return;
      status.textContent = notice(error.message);
      choose.disabled = !current || !form.hidden;
      create.disabled = !current;
      rename.disabled = !current?.parent;
    } finally {
      if (revision === request) {
        list.setAttribute('aria-busy', 'false');
        up.disabled = !current?.parent;
        back.disabled = !visited.length;
      }
    }
  }

  function freshName() {
    const taken = new Set((current?.folders || []).map(folder => folder.name.toLocaleLowerCase()));
    let candidate = t('新建文件夹');
    for (let n = 2; taken.has(candidate.toLocaleLowerCase()); n++) {
      candidate = t('新建文件夹') + ` (${n})`;
    }
    return candidate;
  }

  create.onclick = () => {
    if (!current) return;
    const pending = list.querySelector('.folder-new input');
    if (pending) {
      pending.focus();
      return;
    }
    const parent = current.path;
    const input = el('input', {
      type: 'text',
      value: freshName(),
      maxlength: '255',
      'aria-label': t('新文件夹名称')
    });
    const save = el('button', { type: 'submit', class: 'primary-button', text: t('创建') });
    const dismiss = el('button', { type: 'button', class: 'secondary-button', text: t('取消') });
    const row = el('form', { class: 'folder-new' }, [
      el('span', { 'aria-hidden': 'true', text: '⌑' }),
      input,
      save,
      dismiss
    ]);
    dismiss.onclick = () => {
      row.remove();
      create.focus();
    };
    input.onkeydown = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismiss.click();
      }
    };
    row.onsubmit = async e => {
      e.preventDefault();
      if (creating) return;
      creating = save.disabled = true;
      try {
        const folder = await api('/folders', 'POST', { parent, name: input.value });
        if (!dialog.open) return;
        toast('已新建文件夹 {name}', { name: folder.name });
        await navigate(folder.path);
      } catch (error) {
        status.textContent = notice(error.message);
        if (row.isConnected) input.focus();
      } finally {
        creating = save.disabled = false;
      }
    };
    list.prepend(row);
    list.scrollTop = 0;
    input.focus();
    input.select();
  };

  function renamed(from, to) {
    for (let i = 0; i < visited.length; i++) visited[i] = movedPath(visited[i], from, to);
    recent = recent.map(path => movedPath(path, from, to));
    if (state.workspace) state.workspace = movedPath(state.workspace, from, to);
    options.onRename?.(from, to);
  }

  // Renames the folder being viewed; the server moves every Starport path inside it along.
  rename.onclick = () => {
    if (!current?.parent) return;
    const pending = list.querySelector('.folder-new input');
    if (pending) {
      pending.focus();
      return;
    }
    const from = current.path;
    const input = el('input', { type: 'text', value: baseName(from), maxlength: '255', 'aria-label': t('新名称') });
    const save = el('button', { type: 'submit', class: 'primary-button', text: t('改名') });
    const dismiss = el('button', { type: 'button', class: 'secondary-button', text: t('取消') });
    const row = el('form', { class: 'folder-new' }, [
      el('span', { 'aria-hidden': 'true', text: '✎' }),
      input,
      save,
      dismiss
    ]);
    dismiss.onclick = () => {
      row.remove();
      rename.focus();
    };
    input.onkeydown = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismiss.click();
      }
    };
    row.onsubmit = async e => {
      e.preventDefault();
      if (renaming) return;
      if (input.value.trim() === baseName(from)) {
        dismiss.click();
        return;
      }
      renaming = save.disabled = true;
      try {
        const result = await api('/folders/rename', 'POST', { path: from, name: input.value });
        renamed(from, result.path);
        toast(result.chats ? '已改名为 {name}，{count} 个对话的工作目录已一并更新' : '已改名为 {name}', {
          name: baseName(result.path),
          count: result.chats
        });
        await refresh().catch(() => {});
        if (dialog.open) await navigate(result.path, false);
      } catch (error) {
        status.textContent = notice(error.message);
        if (row.isConnected) input.focus();
      } finally {
        renaming = save.disabled = false;
      }
    };
    list.prepend(row);
    list.scrollTop = 0;
    input.focus();
    input.select();
  };

  form.onsubmit = e => {
    e.preventDefault();
    navigate(pathInput.value);
  };
  form.addEventListener('focusout', e => {
    if (current && !form.hidden && !form.contains(e.relatedTarget)) editPath(false);
  });
  pathInput.onkeydown = e => {
    if (e.key === 'Escape' && current) {
      e.preventDefault();
      e.stopPropagation();
      editPath(false);
      edit.focus();
    }
  };
  pathInput.oninput = () => {
    choose.disabled = true;
  };
  edit.onclick = () => editPath(true);
  crumbs.onclick = e => {
    if (e.target === crumbs) editPath(true);
  };
  up.onclick = () => navigate(current.parent);
  back.onclick = () => {
    const path = visited.pop();
    if (path) navigate(path, false);
  };
  search.oninput = draw;
  search.onkeydown = e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list.querySelector('.folder-entry')?.focus();
    }
  };
  list.onkeydown = e => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.target.closest('.folder-new')) return;
    const entries = [...list.querySelectorAll('.folder-entry')];
    const index = entries.indexOf(document.activeElement);
    if (!entries.length) return;
    e.preventDefault();
    entries[
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? entries.length - 1
          : Math.max(0, Math.min(entries.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
    ].focus();
  };
  dialog.onkeydown = e => {
    const typing = !!e.target.closest('input,.folder-new');
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      if (!back.disabled) back.click();
    } else if ((e.altKey && e.key === 'ArrowUp') || (e.key === 'Backspace' && !typing)) {
      e.preventDefault();
      if (!up.disabled) up.click();
    } else if (
      (e.ctrlKey && e.key.toLowerCase() === 'l') ||
      (e.altKey && e.key.toLowerCase() === 'd') ||
      e.key === 'F4'
    ) {
      e.preventDefault();
      editPath(true);
    }
  };
  choose.onclick = async () => {
    if (!current || choose.disabled) return;
    choose.disabled = true;
    try {
      await onSelect(current.path);
      dialog.close();
    } catch (error) {
      status.textContent = notice(error.message);
      choose.disabled = false;
    }
  };

  dialog.setAttribute('aria-label', t(title));
  dialog.append(
    el('div', { class: 'dialog-heading' }, [el('h2', { text: t(title) }), close]),
    el('div', { class: 'folder-toolbar' }, [back, up, el('div', { class: 'folder-address' }, [crumbs, form, edit])]),
    el('div', { class: 'folder-body' }, [
      places,
      el('div', { class: 'folder-main' }, [
        el('div', { class: 'folder-tools' }, [search, rename, create]),
        projectLine,
        status,
        list
      ])
    ]),
    el('div', { class: 'dialog-footer' }, [selected, cancel, choose])
  );
  dialog.onclose = () => {
    request++;
  };
  dialog.showModal();
  search.focus();
  navigate('').then(() => {
    if (dialog.open && request === 1 && initial && initial !== current?.path) navigate(initial, false);
  });
}

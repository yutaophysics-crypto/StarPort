'use strict';
globalThis.StarportComposer = (() => {
  let busy = 0;
  let menuOpen = false;

  const attachmentKey = key => 'starport-attachments-' + key;
  const read = (key = draftKey()) => {
    try {
      return JSON.parse(localStorage.getItem(attachmentKey(key)) || '[]');
    } catch {
      return [];
    }
  };
  const write = (rows, key = draftKey()) => {
    localStorage.setItem(attachmentKey(key), JSON.stringify(rows));
    render();
  };
  const add = (row, key = draftKey()) => {
    const rows = read(key);
    if (rows.length >= 16) throw new Error(t('每条消息最多添加 16 个附件'));
    write([...rows, row], key);
  };

  const plus = el('button', {
    id: 'add-context',
    type: 'button',
    class: 'add-context',
    text: '＋',
    'aria-label': t('添加'),
    'aria-haspopup': 'menu',
    'aria-expanded': 'false'
  });
  $('.composer-context').prepend(plus);

  const menu = el('div', { id: 'add-menu', class: 'add-menu', role: 'menu', hidden: '' });
  document.body.append(menu);

  const fileInput = el('input', { id: 'attachment-files', type: 'file', multiple: '', hidden: '' });
  document.body.append(fileInput);

  function closeMenu() {
    menuOpen = false;
    menu.hidden = true;
    plus.setAttribute('aria-expanded', 'false');
  }

  function showMenu() {
    menuOpen = true;
    menu.hidden = false;
    plus.setAttribute('aria-expanded', 'true');
    renderMenu();
    const rect = plus.getBoundingClientRect();
    menu.style.left = Math.max(10, Math.min(innerWidth - menu.offsetWidth - 10, rect.left)) + 'px';
    menu.style.top = Math.max(10, rect.top - menu.offsetHeight - 8) + 'px';
    menu.querySelector('button:not([disabled])')?.focus();
  }

  plus.onclick = () => (menuOpen ? closeMenu() : showMenu());
  document.addEventListener('click', event => {
    if (!menu.contains(event.target) && !plus.contains(event.target)) closeMenu();
  });
  window.addEventListener('resize', closeMenu);
  menu.onkeydown = event => {
    if (event.key === 'Escape') {
      closeMenu();
      plus.focus();
    }
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...menu.querySelectorAll('button:not([disabled])')];
      const i = buttons.indexOf(document.activeElement);
      buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  };

  const planActive = () => (currentId() === 'claude' ? opts().permissionMode === 'plan' : opts().mode === 'plan');

  function actionIcon(name, size = 18) {
    const paths = {
      files: ['M21 11.5 11.8 20.7a6 6 0 0 1-8.5-8.5L13.2 2.3a4 4 0 0 1 5.7 5.7L9 17.9a2 2 0 0 1-2.8-2.8l9.2-9.2'],
      folder: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'],
      edge: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z'],
      video: ['M3 5h18v14H3ZM10 9l5 3-5 3Z'],
      project: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM3 10h18'],
      goal: ['M20.5 7A9 9 0 1 1 17 3.5', 'M16 8a5 5 0 1 0 1 6', 'M12 12 21 3M17 3h4v4'],
      plan: ['M9 18h6M10 21h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z', 'M12 1v1M3 10H1M23 10h-2M4 3l1 1M20 3l-1 1'],
      sketch: ['m3 17-1 5 5-1L21 7a2.1 2.1 0 0 0-4-4L3 17ZM14 6l4 4M4 17l3 3']
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24',
      width: String(size),
      height: String(size),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      class: 'action-icon'
    })) {
      svg.setAttribute(k, v);
    }
    for (const d of paths[name] || paths.files) {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function attachFolder() {
    const key = draftKey();
    openFolderPicker(
      state.chat?.workspace || state.workspace,
      async path => {
        add(await api('/attachments/folder', 'POST', { path }), key);
      },
      undefined,
      { projects: false }
    );
  }

  function renderMenu() {
    const p = currentProvider();
    const nativePlan = p?.nativePlan || ['claude', 'antigravity'].includes(p?.id);
    const items = [
      ['files', '选择文件或图片', '添加到这条消息', () => fileInput.click(), true],
      ['folder', '选择本机文件夹', '仅附加路径，不改变工作目录', attachFolder, true],
      ['edge', '附加 Microsoft Edge', '选择浏览器标签页', openEdge, true],
      ['video', '读取视频字幕', '使用 Edge 的 B 站登录', openVideo, true],
      ['project', '在项目中工作', '在项目中开始聊天', openProjects, true],
      ['goal', '目标', '设置要持续追求的目标', openGoal, p?.id === 'codex' && p.nativeGoal],
      ['plan', '计划模式', planActive() ? '已开启 · 点击关闭' : '开启计划模式', togglePlan, nativePlan],
      ['sketch', '绘图', '绘制草图', openSketch, true]
    ];
    // Attachments can go with a message sent during a task; settings and video captions wait for it.
    const duringRun = new Set(['files', 'folder', 'edge', 'sketch']);
    const runLocked = id => !!state.run && !(state.run.takesAttachments && duringRun.has(id));
    menu.replaceChildren(
      ...items.map(([id, label, description, action, enabled]) => {
        const button = el(
          'button',
          {
            id: 'add-' + id,
            type: 'button',
            role: 'menuitem',
            disabled: runLocked(id) || !enabled,
            title: enabled ? t(description) : t('当前工具暂不支持此功能')
          },
          [
            actionIcon(id, 18),
            el('div', { class: 'add-menu-copy' }, [
              el('span', { text: t(label) }),
              el('small', { text: t(enabled ? description : '当前工具暂不支持') })
            ])
          ]
        );
        button.onclick = () => {
          closeMenu();
          action();
        };
        return button;
      })
    );
  }

  function shell(dialog, title, body, actions = []) {
    const close = el('button', { type: 'button', class: 'icon-button', text: '×', 'aria-label': t('关闭') });
    close.onclick = () => dialog.close();
    const cancel = el('button', { type: 'button', class: 'secondary-button', text: t('取消') });
    cancel.onclick = () => dialog.close();
    dialog.replaceChildren(
      el('div', { class: 'dialog-heading' }, [el('h2', { text: t(title) }), close]),
      el('div', { class: 'dialog-body' }, body),
      el('div', { class: 'dialog-footer' }, [cancel, ...actions])
    );
    dialog.showModal();
    return dialog;
  }

  function attachmentList(rows, removable = false, key = draftKey()) {
    return el(
      'div',
      { class: 'attachment-list' },
      rows.map(row => {
        const isImage = row.mime?.startsWith('image/');
        const iconKind = row.kind === 'folder' ? 'folder' : row.kind === 'web' ? 'edge' : 'files';
        const open = el(
          'button',
          { type: 'button', class: 'attachment-open', title: row.name },
          [
            isImage
              ? el('img', { src: '/api/attachments/' + encodeURIComponent(row.id) + '/preview', alt: row.name })
              : el('span', { class: 'attachment-icon', 'aria-hidden': 'true' }, [actionIcon(iconKind, 15)]),
            el('span', { class: 'attachment-name', text: row.name })
          ]
        );
        open.onclick = () => preview(row);
        if (!['folder', 'web'].includes(row.kind) && row.path) {
          globalThis.StarportFiles?.bindMenu(open, row.path, { chatId: state.chat?.id });
        }
        const chip = el('div', { class: 'attachment-chip' }, [open]);
        if (removable) {
          const remove = el('button', {
            type: 'button',
            class: 'attachment-remove',
            text: '×',
            'aria-label': t('移除附件 {name}', { name: row.name })
          });
          remove.onclick = () => write(read(key).filter(r => r.id !== row.id), key);
          chip.append(remove);
        }
        return chip;
      })
    );
  }

  async function preview(row) {
    const dialog = $('#attachment-dialog');
    const content = [el('p', { class: 'muted', text: row.name })];
    if (row.mime?.startsWith('image/')) {
      content.push(
        el('img', {
          class: 'attachment-preview',
          src: '/api/attachments/' + encodeURIComponent(row.id) + '/preview',
          alt: row.name
        })
      );
    } else if (row.kind === 'web') {
      try {
        const data = await api('/attachments/' + row.id + '/preview');
        content.push(el('p', { class: 'muted', text: data.path }), el('pre', { class: 'web-preview', text: data.text }));
      } catch (error) {
        toast(error.message);
        return;
      }
    } else {
      content.push(el('p', { class: 'path-display', text: row.path }));
    }
    const actions = [];
    if (!['folder', 'web'].includes(row.kind)) {
      actions.push(
        el('a', {
          class: 'primary-button',
          href: '/api/attachments/' + encodeURIComponent(row.id) + '/download',
          download: row.name,
          text: t('下载')
        })
      );
    }
    shell(dialog, '附件预览', content, actions);
  }

  function render() {
    plus.setAttribute('aria-label', t('添加'));
    const root = $('#composer-attachments');
    root.replaceChildren(...attachmentList(read(), true).children);
    root.hidden = !root.children.length && !busy;
    if (busy) {
      root.append(el('span', { class: 'attachment-loading', role: 'status', text: t('正在添加附件…') }));
    }
    renderComposerAction();

    const mode = $('#composer-mode');
    mode.replaceChildren();
    if (opts().mode === 'goal') {
      const button = el(
        'button',
        {
          type: 'button',
          class: 'mode-chip',
          disabled: !!state.run,
          title: opts().objective || t('目标')
        },
        [actionIcon('goal', 13), el('span', { text: t('目标模式') })]
      );
      button.onclick = openGoal;
      mode.append(button);
    } else if (planActive()) {
      const button = el(
        'button',
        {
          type: 'button',
          class: 'mode-chip',
          disabled: !!state.run,
          title: t('已开启 · 点击关闭')
        },
        [actionIcon('plan', 13), el('span', { text: t('计划模式') })]
      );
      button.onclick = togglePlan;
      mode.append(button);
    }

    // The project follows from the folder: the conversation's, or the draft's chosen folder.
    const project = currentProject();
    if (project) {
      const button = el(
        'button',
        {
          type: 'button',
          class: 'mode-chip',
          title: t('项目要求')
        },
        [actionIcon('project', 13), el('span', { text: project.name })]
      );
      button.onclick = () => globalThis.StarportSharedContext?.projects(project.id);
      mode.append(button);
    }
    mode.hidden = !mode.children.length;
    if (menuOpen) renderMenu();
  }

  async function uploadFiles(files, kind) {
    const key = draftKey();
    busy++;
    render();
    try {
      if (read(key).length + files.length > 16) throw new Error(t('每条消息最多添加 16 个附件'));
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024) throw new Error(t('附件无效或超过 8 MB'));
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        add(await api('/attachments', 'POST', { name: file.name, data, kind }), key);
      }
    } catch (error) {
      toast(error.message);
    } finally {
      busy--;
      render();
    }
  }

  fileInput.onchange = () => {
    uploadFiles([...fileInput.files]);
    fileInput.value = '';
  };

  $('#composer').addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      $('#composer').classList.add('drag-over');
    }
  });
  $('#composer').addEventListener('dragleave', () => $('#composer').classList.remove('drag-over'));
  $('#composer').addEventListener('drop', event => {
    event.preventDefault();
    $('#composer').classList.remove('drag-over');
    if (state.run && !state.run.takesAttachments) return;
    const files = [...event.dataTransfer.files];
    if (files.length) uploadFiles(files);
  });
  $('#prompt').addEventListener('paste', event => {
    const files = [...event.clipboardData.files];
    if (files.length && (!state.run || state.run.takesAttachments)) {
      event.preventDefault();
      uploadFiles(files);
    }
  });

  function togglePlan() {
    if (state.run) return;
    const p = currentProvider();
    const active = planActive();
    const updated = { ...opts() };
    if (p.id === 'claude') updated.permissionMode = active ? 'dontAsk' : 'plan';
    else if (p.id === 'codex') updated.mode = active ? 'chat' : 'plan';
    else if (p.id === 'antigravity') updated.mode = active ? 'auto' : 'plan';
    else return;
    saveOptions(p, updated);
    renderFeatures();
  }

  function openGoal() {
    if (currentId() !== 'codex' || !currentProvider()?.nativeGoal) return;
    const dialog = $('#action-dialog');
    const objective = el('textarea', {
      id: 'goal-objective',
      rows: '4',
      maxlength: '4000',
      placeholder: t('你希望完成什么？'),
      value: opts().objective || ''
    });
    const budget = el('input', {
      id: 'goal-budget',
      type: 'number',
      min: '1',
      value: opts().tokenBudget || '',
      placeholder: t('可选；留空不设置预算')
    });
    const save = el('button', { type: 'button', class: 'primary-button', text: t('设置目标') });
    save.onclick = () => {
      if (budget.value && (!Number.isSafeInteger(Number(budget.value)) || Number(budget.value) < 1)) {
        budget.reportValidity();
        return;
      }
      saveOptions(currentProvider(), {
        ...opts(),
        mode: 'goal',
        objective: objective.value.trim(),
        tokenBudget: budget.value ? Number(budget.value) : ''
      });
      renderFeatures();
      dialog.close();
      $('#prompt').focus();
    };
    const off = el('button', { type: 'button', class: 'secondary-button', text: t('关闭目标模式') });
    off.onclick = () => {
      saveOptions(currentProvider(), { ...opts(), mode: 'chat' });
      renderFeatures();
      dialog.close();
    };
    shell(
      dialog,
      '目标',
      [
        el('label', {}, [t('目标'), objective]),
        el('label', {}, [t('目标 Token 预算'), budget]),
        el('p', { class: 'muted', text: t('发送下一条消息时开始推进；可随时暂停。') })
      ],
      [...(opts().mode === 'goal' ? [off] : []), save]
    );
  }

  async function openProjects() {
    const dialog = $('#action-dialog');
    const group = el('select', { id: 'project-group' }, [
      el('option', { value: '', text: t('未分组') }),
      ...state.groups.map(g => el('option', { value: g.id, text: g.name }))
    ]);
    group.value = (state.chat ? state.chat.group_id : state.draftGroup) || '';
    const list = el('div', { class: 'project-list' });
    const addProject = el('button', { type: 'button', class: 'secondary-button', text: t('标记项目文件夹') });
    const selectProject = project => {
      const id = currentId();
      const groupId = group.value || null;
      newChat();
      state.selected = id;
      state.workspace = project.workspace;
      state.draftGroup = groupId;
      renderHeader();
      renderFeatures();
      dialog.close();
    };
    function draw() {
      list.replaceChildren(
        ...state.projects.filter(project => project.workspace).map(project => {
          const button = el('button', { type: 'button', class: 'project-choice' }, [
            el('strong', { text: project.name }),
            el('small', { text: project.workspace })
          ]);
          button.onclick = () => selectProject(project);
          return button;
        })
      );
      if (!state.projects.some(project => project.workspace)) {
        list.append(el('p', { class: 'muted', text: t('选择对话的工作文件夹后会自动创建项目。') }));
      }
    }
    addProject.onclick = () =>
      openFolderPicker(state.chat?.workspace || state.workspace, async path => {
        const project = await api('/projects', 'POST', { workspace: path });
        if (project.warning) toast(project.warning);
        state.projects = await api('/projects');
        draw();
        selectProject(project);
      });
    shell(
      dialog,
      '在项目中工作',
      [el('label', {}, [t('新对话的分组'), group]), list],
      [addProject]
    );
    draw();
  }

  async function openEdge() {
    const dialog = $('#action-dialog');
    const list = el('div', { class: 'edge-tabs' });
    const status = el('p', { class: 'muted', role: 'status', text: t('正在连接 Edge…') });
    const reload = el('button', { type: 'button', class: 'secondary-button', text: t('刷新列表') });
    shell(dialog, '附加 Microsoft Edge', [status, list], [reload]);
    async function load() {
      reload.disabled = true;
      list.replaceChildren();
      status.textContent = t('正在连接 Edge…');
      try {
        const info = await api('/edge/status');
        if (!dialog.open) return;
        if (!info.connected) {
          status.textContent = t('首次连接需要在 Edge 加载星港扩展。连接后可在这里选择标签页。');
          const pair = el('button', { type: 'button', class: 'primary-button', text: t('连接 Edge') });
          const code = el('input', { readOnly: '', class: 'pair-code', 'aria-label': t('配对码') });
          const copyPath = el('button', { type: 'button', class: 'secondary-button', text: t('复制扩展文件夹路径') });
          copyPath.onclick = () =>
            navigator.clipboard
              .writeText(info.extensionPath)
              .then(() => toast('已复制'))
              .catch(() => toast(info.extensionPath));
          pair.onclick = async () => {
            try {
              const result = await api('/edge/pair', 'POST', {});
              code.value = result.code;
              code.hidden = false;
              code.select();
            } catch (error) {
              toast(error.message);
            }
          };
          code.hidden = true;
          list.append(
            el('ol', { class: 'edge-instructions' }, [
              el('li', { text: t('在 Edge 打开 edge://extensions，开启开发人员模式，选择「加载解压缩的扩展」。') }),
              el('li', {}, [t('选择此文件夹：'), el('code', { text: info.extensionPath })]),
              el('li', { text: t('点击「连接 Edge」，将配对码粘贴到扩展中并连接，再回到这里刷新。') })
            ]),
            copyPath,
            pair,
            code
          );
          return;
        }
        const data = await api('/edge/tabs');
        if (!dialog.open) return;
        status.textContent = t('选择要附加的网页；预览后随消息发送。');
        for (const tab of data.tabs) {
          const button = el('button', { type: 'button', class: 'project-choice' }, [
            el('strong', { text: tab.title || tab.url }),
            el('small', { text: tab.url })
          ]);
          button.onclick = async () => {
            const key = draftKey();
            button.disabled = true;
            busy++;
            render();
            try {
              add(await api('/edge/attach', 'POST', { tabId: tab.id }), key);
              dialog.close();
            } catch (error) {
              toast(error.message);
              button.disabled = false;
            } finally {
              busy--;
              render();
            }
          };
          list.append(button);
        }
        if (!data.tabs.length) {
          list.append(el('p', { class: 'muted', text: t('没有可附加的网页，请在 Edge 打开一个网页。') }));
        }
      } catch (error) {
        status.textContent = notice(error.message);
      } finally {
        reload.disabled = false;
      }
    }
    reload.onclick = load;
    load();
  }

  const sketches = new Map();

  async function prepareVideos(text) {
    const key = draftKey();
    const { findVideoReferences } = await import('/video-reference.mjs');
    const references = findVideoReferences(text).filter(
      ref => !read(key).some(row => row.kind === 'web' && row.path === ref.url && row.name.startsWith('视频字幕 · '))
    );
    if (!references.length) return;
    if (read(key).length + references.length > 16) throw new Error(t('每条消息最多添加 16 个附件'));
    const info = await api('/edge/status');
    if (!info.connected) {
      await openEdge();
      throw new Error(t('请先连接 Edge，再发送视频；输入已保留'));
    }
    busy++;
    render();
    try {
      toast('正在通过已登录的 Edge 读取字幕…');
      for (const reference of references) {
        const data = await api('/videos/read', 'POST', { reference: reference.url });
        add(data.attachment, key);
      }
    } finally {
      busy--;
      render();
    }
  }

  function openVideo() {
    const key = draftKey();
    const dialog = $('#action-dialog');
    const input = el('input', {
      id: 'video-reference',
      type: 'text',
      maxlength: '4000',
      placeholder: t('B 站视频链接或 BV 号'),
      'aria-label': t('B 站视频链接或 BV 号')
    });
    const status = el('p', {
      class: 'muted',
      role: 'status',
      text: t('字幕会作为附件发送。直接在消息中输入 BV 号或视频链接也会自动读取。')
    });
    const connect = el('button', { type: 'button', class: 'secondary-button', text: t('连接 Edge') });
    connect.onclick = () => {
      dialog.close();
      openEdge();
    };
    const readButton = el('button', { id: 'video-read', type: 'button', class: 'primary-button', text: t('读取并附加') });
    readButton.onclick = async () => {
      readButton.disabled = true;
      busy++;
      render();
      status.textContent = t('正在通过已登录的 Edge 读取字幕…');
      try {
        if (read(key).length >= 16) throw new Error(t('每条消息最多添加 16 个附件'));
        const data = await api('/videos/read', 'POST', { reference: input.value });
        add(data.attachment, key);
        dialog.close();
        toast('字幕已附加，可点击附件预览');
      } catch (error) {
        status.textContent = notice(error.message);
      } finally {
        readButton.disabled = false;
        busy--;
        render();
      }
    };
    shell(
      dialog,
      '读取视频字幕',
      [el('label', {}, [t('B 站视频链接或 BV 号'), input]), status],
      [connect, readButton]
    );
    input.focus();
  }

  function openSketch() {
    const key = draftKey();
    const dialog = $('#sketch-dialog');
    const canvas = el('canvas', { id: 'sketch-canvas', width: '1200', height: '720', 'aria-label': t('草图画布') });
    const ctx = canvas.getContext('2d');
    const drawing = sketches.get(key) || { strokes: [], redo: [] };
    sketches.set(key, drawing);
    let stroke = null;
    let erasing = false;

    const color = el('input', { id: 'sketch-color', type: 'color', value: '#252525', 'aria-label': t('画笔颜色') });
    const width = el('input', { id: 'sketch-width', type: 'range', min: '1', max: '30', value: '4', 'aria-label': t('画笔粗细') });
    const undo = el('button', { type: 'button', class: 'secondary-button', text: t('撤销') });
    const redo = el('button', { type: 'button', class: 'secondary-button', text: t('重做') });
    const eraser = el('button', { id: 'sketch-eraser', type: 'button', class: 'secondary-button', 'aria-pressed': 'false', text: t('橡皮擦') });
    const clear = el('button', { type: 'button', class: 'secondary-button', text: t('清空') });
    const attach = el('button', { id: 'sketch-attach', type: 'button', class: 'primary-button', text: t('附加草图') });

    function draw() {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1200, 720);
      for (const line of [...drawing.strokes, ...(stroke ? [stroke] : [])]) {
        ctx.strokeStyle = line.color;
        ctx.fillStyle = line.color;
        ctx.lineWidth = line.width;
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        line.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        if (line.points.length === 1) {
          ctx.beginPath();
          ctx.arc(...line.points[0], line.width / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      undo.disabled = !drawing.strokes.length;
      redo.disabled = !drawing.redo.length;
      attach.disabled = !drawing.strokes.length;
    }

    const point = event => {
      const rect = canvas.getBoundingClientRect();
      return [
        ((event.clientX - rect.left) * 1200) / rect.width,
        ((event.clientY - rect.top) * 720) / rect.height
      ];
    };
    canvas.onpointerdown = event => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      stroke = {
        color: erasing ? '#fff' : color.value,
        width: Number(width.value) * (erasing ? 4 : 1),
        points: [point(event)]
      };
      draw();
    };
    canvas.onpointermove = event => {
      if (stroke) {
        stroke.points.push(point(event));
        draw();
      }
    };
    const finish = () => {
      if (stroke) {
        drawing.strokes.push(stroke);
        drawing.redo = [];
        stroke = null;
        draw();
      }
    };
    canvas.onpointerup = finish;
    canvas.onpointercancel = finish;
    undo.onclick = () => {
      if (drawing.strokes.length) drawing.redo.push(drawing.strokes.pop());
      draw();
    };
    redo.onclick = () => {
      if (drawing.redo.length) drawing.strokes.push(drawing.redo.pop());
      draw();
    };
    eraser.onclick = () => {
      erasing = !erasing;
      eraser.setAttribute('aria-pressed', String(erasing));
    };
    clear.onclick = () => {
      drawing.strokes = [];
      drawing.redo = [];
      draw();
    };
    attach.onclick = async () => {
      attach.disabled = true;
      busy++;
      render();
      try {
        add(
          await api('/attachments', 'POST', {
            name: t('草图') + '-' + Date.now() + '.png',
            kind: 'sketch',
            data: canvas.toDataURL('image/png').split(',')[1]
          }),
          key
        );
        sketches.delete(key);
        dialog.close();
      } catch (error) {
        toast(error.message);
        attach.disabled = false;
      } finally {
        busy--;
        render();
      }
    };
    shell(
      dialog,
      '绘制草图',
      [el('div', { class: 'sketch-toolbar' }, [color, width, eraser, undo, redo, clear]), canvas],
      [attach]
    );
    draw();
  }

  const result = {
    render,
    attachmentList,
    prepareVideos,
    ids: () => read().map(row => row.id),
    get busy() {
      return busy > 0;
    },
    clear(key = draftKey()) {
      write([], key);
    },
    consume(ids, key = draftKey()) {
      const sent = new Set(ids);
      write(read(key).filter(row => !sent.has(row.id)), key);
    },
    moveDraft(from, to) {
      write(read(from), to);
      localStorage.removeItem(attachmentKey(from));
    }
  };
  render();
  return result;
})();

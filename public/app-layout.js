'use strict';

// The frame around the conversation: the sidebar's room and chat list, the top bar,
// the theme cover, and the two resizable side panels.

function renderGroups() {
  const root = $('#groups');
  root.replaceChildren();
  for (const group of [...state.groups.filter(g => g.name !== '__DELETED_ROOM__'), { id: null, name: t('未分组') }]) {
    const chats = state.chats.filter(
      c => c.group_id === group.id && (!state.filter || c.title.toLowerCase().includes(state.filter))
    );
    if (group.id === null && !chats.length && state.groups.length) continue;

    const heading = el('div', { class: 'group-heading', 'data-group-id': group.id || '' });
    const toggle = el('button', {
      class: 'group-toggle',
      text: `${state.collapsed.has(group.id) ? '›' : '⌄'}  ${group.name}`,
      'aria-expanded': String(!state.collapsed.has(group.id))
    });
    toggle.onclick = () => {
      state.collapsed.has(group.id) ? state.collapsed.delete(group.id) : state.collapsed.add(group.id);
      renderGroups();
    };
    heading.append(toggle);

    const add = el('button', {
      class: 'icon-button',
      text: '＋',
      'aria-label': t('在分组 {name} 中新建对话', { name: group.name })
    });
    add.onclick = () => newChatIn(group.id);
    heading.append(add);

    if (group.id) {
      const edit = el('button', {
        class: 'icon-button',
        text: '⋯',
        'aria-label': t('房间选项：{name}', { name: group.name })
      });
      edit.onclick = e => {
        e.stopPropagation();
        globalThis.StarportChatActions?.openGroup(group, edit);
      };
      heading.append(edit);
    }
    heading.oncontextmenu = e => {
      e.preventDefault();
      globalThis.StarportChatActions?.openGroup(group, toggle, e);
    };

    const section = el('section', { class: 'group' }, [heading]);
    if (!state.collapsed.has(group.id)) {
      for (const chat of chats) {
        const active = state.chat?.id === chat.id;
        const running = state.active?.includes(chat.id);
        const status = running ? 'running' : chat.unread ? 'unread' : '';
        const label = status ? t(running ? '正在执行任务' : '回答完成，待查看') : '';
        const button = el(
          'button',
          {
            class: 'chat-link' + (active ? ' active' : '') + (running ? ' running' : ''),
            title: [chat.title, chat.workspace, label].filter(Boolean).join('\n'),
            ...(active ? { 'aria-current': 'page' } : {})
          },
          [
            el('span', {
              class: 'chat-status ' + status,
              ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })
            }),
            el('span', { class: 'chat-text', text: chat.title })
          ]
        );
        button.onclick = () => openChat(chat.id).catch(e => toast(e.message));

        const more = el('button', {
          type: 'button',
          class: 'chat-more',
          text: '⋯',
          'data-chat-id': chat.id,
          'aria-label': t('对话选项：{title}', { title: chat.title }),
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          'aria-controls': 'chat-actions-menu'
        });
        more.onclick = e => {
          e.stopPropagation();
          globalThis.StarportChatActions?.open(chat.id, more);
        };
        more.onkeydown = e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            globalThis.StarportChatActions?.open(chat.id, more);
          }
        };

        const row = el('div', { class: 'chat-row' + (active ? ' active' : ''), 'data-chat-id': chat.id }, [
          button,
          more
        ]);
        row.oncontextmenu = e => {
          e.preventDefault();
          globalThis.StarportChatActions?.open(chat.id, button, e);
        };
        section.append(row);
      }
    }
    root.append(section);
  }
  if (!state.chats.length) {
    root.append(el('p', { class: 'empty-groups', text: t('还没有对话。\n从第一条消息开始，慢慢积累。') }));
  }
  globalThis.StarportChatActions?.sync();
  // The room (agents-room.js) redraws its part around whatever app.js has just drawn.
  globalThis.StarportAgentsRoom?.scheduleRender();
}

function newChatIn(groupId) {
  newChat();
  state.draftGroup = groupId;
  renderHeader();
}

function renameGroup(group) {
  openEditor('重命名分组', [{ name: 'name', label: '分组名称', value: group.name }], async data => {
    await api('/groups/' + group.id, 'PATCH', data);
    await refresh();
  });
}

function renderHeader() {
  $('#chat-title').textContent = coverOpen ? '' : state.chat?.title || t('新的一页');
  $('#chat-title').hidden = coverOpen;
  $('.breadcrumb .slash').hidden = coverOpen;
  $('#chat-title').disabled = coverOpen;
  $('#group-label').textContent = coverOpen
    ? t('星港')
    : state.groups.find(g => g.id === (state.chat ? state.chat.group_id : state.draftGroup))?.name || t('个人工作台');

  const workspace = state.chat?.workspace || state.workspace;
  $('#workspace-label').textContent = workspace.split(/[\\/]/).filter(Boolean).pop() || t('选择工作目录');
  $('#workspace-button').title = workspace || t('设置工作目录');
  globalThis.StarportExternalTools?.sync();
  $('#export-chat').hidden = coverOpen || !state.chat;
  $('#chat-settings').hidden = coverOpen || !state.chat;
  $('#features-toggle').hidden = coverOpen;
  $('#welcome').hidden = !!state.chat && !coverOpen;
  $('#conversation').hidden = coverOpen || !state.chat;
  $('.app-shell').classList.toggle('theme-cover-open', coverOpen);
  $('.composer-region').hidden = coverOpen;
  $('#cover-actions').hidden = !coverOpen;
  $('#theme-cover-button').setAttribute('aria-pressed', String(coverOpen));
  $('#return-from-cover').textContent = t(state.chat ? '返回对话' : '返回工作台');
  globalThis.StarportAgentsRoom?.scheduleRender();
}

// What the theme cover hid: focus, caret, scroll and panel state, restored when it closes.
let coverReturn = null;

function openThemeCover() {
  if (coverOpen) {
    closeThemeCover();
    return;
  }
  const conversation = $('#conversation');
  const prompt = $('#prompt');
  coverReturn = {
    focus: document.activeElement,
    featuresOpen: $('#features').classList.contains('open'),
    selection: [prompt.selectionStart, prompt.selectionEnd, prompt.selectionDirection],
    scroll: conversation.scrollTop,
    atBottom: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 110
  };
  coverOpen = true;
  renderHeader();
  renderRun();
  $('.sidebar').classList.remove('open');
  $('#features').classList.remove('open');
  $('#return-from-cover').focus({ preventScroll: true });
}

function closeThemeCover(restore = true) {
  if (!coverOpen) return;
  coverOpen = false;
  renderHeader();
  const saved = coverReturn;
  coverReturn = null;
  if (!restore || !saved) return;
  const conversation = $('#conversation');
  conversation.scrollTop = saved.atBottom ? conversation.scrollHeight : saved.scroll;
  $('#features').classList.toggle('open', saved.featuresOpen);
  $('#prompt').setSelectionRange(...saved.selection);
  const previous = saved.focus;
  const focus =
    previous?.isConnected &&
    previous.tabIndex >= 0 &&
    !previous.disabled &&
    previous.getClientRects().length &&
    !(innerWidth <= 650 && previous.closest('.sidebar'))
      ? previous
      : $('#prompt');
  focus.focus({ preventScroll: true });
  markViewed();
}

function setupPanelResizers() {
  const shell = $('.app-shell');
  if (!shell) return;
  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
  const fitters = [];
  const fitPanels = () => {
    if (innerWidth > 650) fitters.forEach(fit => fit());
  };

  const bindResizer = ({ handle, panel, cssVar, storageKey, min, max, computeWidth, arrowSign }) => {
    if (!handle || !panel) return;
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= min && saved <= max) {
      shell.style.setProperty(cssVar, saved + 'px');
    }

    const widthLimit = () => {
      if (getComputedStyle(panel).position === 'fixed') return Math.min(max, innerWidth - 40);
      const other = panel === $('.sidebar') ? $('#features') : $('.sidebar');
      const style = getComputedStyle(other);
      const otherWidth =
        style.display !== 'none' && style.position !== 'fixed' ? other.getBoundingClientRect().width : 0;
      const mainWidth = innerWidth > 1150 ? 360 : 320;
      return Math.min(max, Math.max(min, innerWidth - mainWidth - otherWidth));
    };
    const applyWidth = raw => {
      const limit = widthLimit();
      const width = clamp(raw, min, limit);
      shell.style.setProperty(cssVar, width + 'px');
      localStorage.setItem(storageKey, String(width));
    };
    fitters.push(() => {
      const width = parseFloat(shell.style.getPropertyValue(cssVar)) || panel.getBoundingClientRect().width;
      if (width && width > widthLimit()) applyWidth(width);
    });

    const resetWidth = () => {
      shell.style.removeProperty(cssVar);
      localStorage.removeItem(storageKey);
      fitPanels();
    };

    handle.addEventListener('dblclick', e => {
      e.preventDefault();
      resetWidth();
    });

    handle.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = (e.key === 'ArrowRight' ? 16 : -16) * arrowSign;
        applyWidth(panel.getBoundingClientRect().width + delta);
      } else if (e.key === 'Home' || e.key === '0') {
        e.preventDefault();
        resetWidth();
      }
    });

    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || innerWidth <= 650) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing-panels');
      const onMove = moveEvent => applyWidth(computeWidth(moveEvent));
      const onUp = upEvent => {
        handle.releasePointerCapture?.(upEvent.pointerId);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing-panels');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  };

  bindResizer({
    handle: $('#sidebar-resizer'),
    panel: $('.sidebar'),
    cssVar: '--sidebar-width',
    storageKey: 'starport-sidebar-width',
    min: 180,
    max: 520,
    computeWidth: e => e.clientX,
    arrowSign: 1
  });

  bindResizer({
    handle: $('#features-resizer'),
    panel: $('#features'),
    cssVar: '--features-width',
    storageKey: 'starport-features-width',
    min: 220,
    max: 520,
    computeWidth: e => innerWidth - e.clientX,
    arrowSign: -1
  });
  fitPanels();
  window.addEventListener('resize', fitPanels);
  const visibility = new MutationObserver(fitPanels);
  visibility.observe(shell, { attributes: true, attributeFilter: ['class'] });
  visibility.observe($('#features'), { attributes: true, attributeFilter: ['class'] });
}

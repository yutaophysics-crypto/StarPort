'use strict';

// Rooms: who is in each room, drawn in the sidebar, the right panel and the composer.
// Companions, rosters and workflows live on the local server (workflows.js keeps that state);
// this file draws the room around the current conversation and routes @mentions and workflow runs.
// The files loaded after it add their dialogs to StarportAgentsRoom:
//   room-companions.js  a companion's card and settings, and who is in the room
//   room-delete.js      deleting a room
// room-migrate.js (loaded before) imports companions older builds kept in this browser.
globalThis.StarportAgentsRoom = (() => {
  const Room = {};
  const W = globalThis.StarportWorkflows;
  const { el, icon, avatar, iconButton, closeDialog, confirmDialog, menu } = globalThis.StarportUI;

  const PREFS_KEY = 'starport-room-ui';
  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {};
    } catch {
      return {};
    }
  })();
  prefs.workflowMode ||= {};
  prefs.oneWay ||= {};
  const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));

  // --- the current room -----------------------------------------------------------------------
  function currentGroupId() {
    return state.chat ? state.chat.group_id : state.draftGroup;
  }

  function roomInfo(gid) {
    const group = gid ? (state.groups || []).find(g => g.id === gid) : null;
    return group
      ? { groupId: gid, group, title: group.name, members: W.members(gid) }
      : { groupId: null, group: null, title: '', members: [] };
  }

  const currentRoom = () => roomInfo(currentGroupId());
  const roomChats = gid => new Set((state.chats || []).filter(c => c.group_id === gid).map(c => c.id));
  const roomMounts = gid => {
    const chats = roomChats(gid);
    return (W.data?.mounts || []).filter(m => chats.has(m.chatId));
  };

  function modelLine(c) {
    const parts = [W.PROVIDER_LABELS[c.provider] || c.provider, c.model || '默认模型'];
    if (c.effort) parts.push(`思考 ${c.effort}`);
    return parts.join(' · ');
  }

  // The latest step this companion took in the current conversation.
  function lastStep(companionId) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const run = state.messages[i].details?.workflowRun;
      const step = run?.steps?.findLast(s => s.companionId === companionId && s.status !== 'waiting');
      if (step) return { step, message: state.messages[i] };
    }
    return null;
  }

  function memberStatus(c) {
    if (W.busyCompanions().has(c.id)) return { kind: 'running', text: '工作中' };
    const last = lastStep(c.id)?.step;
    if (last?.status === 'failed') return { kind: 'failed', text: '上次没完成' };
    if (last?.ended) return { kind: 'done', text: `${W.when(last.ended)} 完成` };
    return { kind: 'idle', text: '待命' };
  }

  // --- mentions in the composer ---------------------------------------------------------------
  const prompt = () => document.getElementById('prompt');

  // Programmatic edits fire `input` so the draft, send button and room tools stay in sync.
  function setPromptValue(value) {
    const input = prompt();
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function toggleMention(c) {
    const input = prompt();
    if (!input) return;
    const hits = W.parseMentions(input.value, currentRoom().members).filter(hit => hit.companion.id === c.id);
    if (hits.length) {
      let text = input.value;
      for (const hit of hits.reverse()) text = text.slice(0, hit.start) + text.slice(hit.end).replace(/^ /, '');
      setPromptValue(text.replace(/^\s+/, ''));
    } else {
      const prefix = input.value && !/\s$/.test(input.value) ? ' ' : '';
      setPromptValue(`${input.value}${prefix}@${c.name} `);
    }
    input.focus();
  }

  // --- 1. Sidebar: every group is a room; its companions sit quietly beside the name. -----------
  function decorateSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const groupsNav = document.getElementById('groups');
    if (!sidebar || !groupsNav) return;

    const running = new Set(
      (W.data?.running || []).map(run => (state.chats || []).find(c => c.id === run.chatId)?.group_id).filter(Boolean)
    );
    // Rewrite only when something changed; the room redraws on every server update.
    for (const heading of groupsNav.querySelectorAll('.group-heading')) {
      const gid = heading.getAttribute('data-group-id') || null;
      const group = gid ? state.groups.find(g => g.id === gid) : null;
      const current = heading.querySelector('.room-presence');
      if (!group || W.status !== 'ready') {
        current?.remove();
        continue;
      }
      const people = W.members(gid);
      const timed = roomMounts(gid).filter(m => m.enabled && W.scheduled(m));
      const busy = running.has(gid);
      const signature = people.map(c => c.id + c.avatar).join(',') + `|${timed.length}|${busy}`;
      if (current?.dataset.signature === signature) continue;

      const names = people.map(c => c.name).join('、') || '还没有伙伴';
      const presence = el(
        'button',
        {
          type: 'button',
          class: 'room-presence' + (busy ? ' busy' : ''),
          'data-signature': signature,
          title: `${names}${timed.length ? ` · ${timed.length} 个定时工作流` : ''}${busy ? ' · 有工作流正在运行' : ''}\n点击管理伙伴`,
          'aria-label': `${group.name} 的伙伴：${names}`
        },
        [
          timed.length ? icon('clock', 'room-presence-clock') : null,
          el('span', { class: 'room-presence-stack' }, [
            ...people.slice(0, 3).map(c => avatar(c, 'room-presence-avatar')),
            people.length > 3 ? el('span', { class: 'room-presence-more', text: `+${people.length - 3}` }) : null
          ])
        ]
      );
      presence.onclick = e => {
        e.stopPropagation();
        Room.openRosterManager(group.id);
      };
      if (current) current.replaceWith(presence);
      else heading.querySelector('.group-toggle')?.after(presence);
    }

    // Desk sessions from older builds are machinery, not conversations.
    for (const row of groupsNav.querySelectorAll('.chat-row')) {
      if (row.hidden) continue;
      if ((row.querySelector('.chat-text')?.textContent || '').startsWith('[工位]')) row.hidden = true;
    }
  }

  // --- 2. Right panel: the room and this conversation's workflows, or the chat's own tools. -----
  function ensureRightPanelStructure() {
    const features = document.getElementById('features');
    if (!features || document.getElementById('features-mode-tabs')) return;

    const heading = features.querySelector('.features-heading');
    const tabRoom = el('button', {
      type: 'button',
      id: 'tab-btn-desks',
      text: '房间',
      onclick: () => switchRightTab('room')
    });
    const tabHarness = el('button', {
      type: 'button',
      id: 'tab-btn-harness',
      text: '工具',
      onclick: () => switchRightTab('harness')
    });
    const tabs = el(
      'div',
      { id: 'features-mode-tabs', class: 'language-switch room-tabs', role: 'group', 'aria-label': '右栏内容' },
      [tabRoom, tabHarness]
    );
    const panel = el('div', { id: 'agent-desks-panel', class: 'agent-desks-panel' });
    features.insertBefore(tabs, heading);
    features.insertBefore(panel, heading);
    applyRightTabVisibility();
  }

  function switchRightTab(tab) {
    prefs.activeTab = tab;
    savePrefs();
    applyRightTabVisibility();
    renderPanel();
  }

  function applyRightTabVisibility() {
    const features = document.getElementById('features');
    if (!features) return;
    const isRoom = prefs.activeTab !== 'harness';
    document.getElementById('tab-btn-desks')?.setAttribute('aria-pressed', String(isRoom));
    document.getElementById('tab-btn-harness')?.setAttribute('aria-pressed', String(!isRoom));
    const panel = document.getElementById('agent-desks-panel');
    if (panel) panel.hidden = !isRoom;
    for (const sel of [
      '.features-heading',
      '#provider-select',
      '#provider-status',
      '#query-usage',
      '.feature-divider',
      '#provider-options',
      '#provider-note'
    ]) {
      const node = features.querySelector(sel);
      if (!node) continue;
      if (sel === '#provider-note') {
        if (isRoom) node.hidden = true;
      } else node.hidden = isRoom;
    }
  }

  function memberRow(c, mentionedIds) {
    const status = memberStatus(c);
    const mentioned = mentionedIds.has(c.id);
    const last = lastStep(c.id)?.step;
    const note = last?.output ? W.oneLine(W.splitDuty(last.output).duty || W.splitDuty(last.output).body, 80) : '';
    return el('li', { class: `room-member ${status.kind}${mentioned ? ' mentioned' : ''}` }, [
      el(
        'button',
        {
          type: 'button',
          class: 'room-member-main',
          title: `${c.name}\n${modelLine(c)}`,
          onclick: () => Room.openCompanion(c.id)
        },
        [
          avatar(c),
          el('span', { class: 'room-member-text' }, [
            el('span', { class: 'room-member-name', text: c.name }),
            el('span', { class: 'room-member-role', text: c.role || '' }),
            note ? el('span', { class: 'room-member-note', text: note }) : null
          ])
        ]
      ),
      el('span', { class: 'room-member-side' }, [
        el('span', { class: 'room-member-status' }, [
          el('i', { class: 'room-dot' }),
          el('span', { text: status.text })
        ]),
        el('span', { class: 'room-member-tools' }, [
          el('button', {
            type: 'button',
            class: 'room-tool',
            text: '@',
            title: mentioned ? `取消点名 ${c.name}` : `点名 ${c.name}`,
            'aria-pressed': String(mentioned),
            onclick: () => toggleMention(c)
          }),
          iconButton('sliders', `${c.name} 的设置`, () => Room.openCompanionConfig(c))
        ])
      ])
    ]);
  }

  function mountStatusLine(m) {
    const parts = [];
    if (m.runningId) parts.push('运行中');
    else if (W.scheduled(m) && !m.enabled) parts.push('已暂停');
    else if (W.scheduled(m) && m.nextAt && !m.blockers.length) parts.push(`下次 ${W.when(m.nextAt)}`);
    if (!m.runningId && m.lastRunAt)
      parts.push(
        `上次${m.lastStatus ? ' ' + (W.RUN_LABEL[m.lastStatus] || m.lastStatus) : ''} · ${W.when(m.lastRunAt)}`
      );
    return parts;
  }

  function mountMenu(m, anchor) {
    const wf = W.workflow(m.workflowId);
    menu(anchor, [
      { label: '座位与时间…', action: () => W.openMount({ mountId: m.id }) },
      wf ? { label: '编辑工作流…', action: () => W.openEditor(wf, { onDone: () => closeDialog() }) } : null,
      wf?.ledger
        ? {
            label: m.pendingProposals ? `台账…（${m.pendingProposals} 条提议待确认）` : '台账…',
            action: () => W.openLedger(m.id)
          }
        : null,
      m.lastMessageId && state.chat?.id === m.chatId
        ? { label: '看上一次的结果', action: () => W.scrollToMessage(m.lastMessageId) }
        : null,
      W.scheduled(m)
        ? {
            label: m.enabled ? '暂停定时' : '恢复定时',
            action: () =>
              W.call('/mounts/' + m.id, 'PATCH', { enabled: !m.enabled })
                .then(() => toast(m.enabled ? '已暂停定时' : '已恢复定时'))
                .catch(e => toast(e.message))
          }
        : null,
      '-',
      {
        label: '卸下…',
        danger: true,
        disabled: !!m.runningId,
        action: () =>
          confirmDialog({
            eyebrow: state.chat?.title || '',
            title: `卸下「${wf?.name || '工作流'}」？`,
            text: '只是不再挂在这个对话上。工作流本身、已有的运行记录和台账文件都保留。',
            confirm: '卸下',
            danger: true,
            action: async () => {
              await W.call('/mounts/' + m.id, 'DELETE');
              toast('已卸下');
              closeDialog();
            }
          })
      }
    ]);
  }

  function mountRow(m) {
    const wf = W.workflow(m.workflowId);
    const seated = [...new Set(Object.values(m.assignments || {}).filter(Boolean))].map(W.companion).filter(Boolean);
    const blocked = m.blockers.length > 0;
    const run = m.runningId
      ? iconButton(
          'stop',
          '停止这次运行',
          () => W.stopRun(m.runningId).catch(e => toast(e.message)),
          'room-tool wf-run-button running'
        )
      : el(
          'button',
          {
            type: 'button',
            class: 'room-tool wf-run-button',
            title: blocked ? m.blockers.join('；') : `运行「${wf?.name || '工作流'}」`,
            'aria-label': `运行「${wf?.name || '工作流'}」`,
            disabled: blocked,
            onclick: () => W.runMount(m.id, '').catch(e => toast(e.message))
          },
          [icon('play')]
        );
    const more = el(
      'button',
      {
        type: 'button',
        class: 'room-tool',
        title: '更多',
        'aria-label': `「${wf?.name || '工作流'}」的更多操作`,
        'aria-haspopup': 'menu'
      },
      [icon('more')]
    );
    more.onclick = e => {
      e.stopPropagation();
      mountMenu(m, more);
    };
    // Each part stays whole; the line breaks only between them.
    const statusLine = mountStatusLine(m).flatMap((part, i) => [
      i ? ' · ' : '',
      el('span', { class: 'wf-nowrap', text: part })
    ]);
    return el(
      'li',
      {
        class: `wf-mount${m.runningId ? ' running' : ''}${blocked ? ' blocked' : ''}${W.scheduled(m) && !m.enabled ? ' paused' : ''}`
      },
      [
        el(
          'button',
          {
            type: 'button',
            class: 'wf-mount-main',
            title: '座位与时间',
            onclick: () => W.openMount({ mountId: m.id })
          },
          [
            el('span', { class: 'wf-mount-name' }, [
              m.runningId ? el('i', { class: 'wf-dot running' }) : null,
              el('span', { text: wf?.name || '（已删除的工作流）' })
            ]),
            el('span', { class: 'wf-mount-when' }, [
              W.scheduled(m) ? icon('clock') : null,
              el('span', { text: W.triggerText(m.trigger) })
            ]),
            statusLine.length
              ? el(
                  'span',
                  {
                    class:
                      'wf-mount-last' +
                      (!m.runningId && ['failed', 'verify-failed'].includes(m.lastStatus) ? ' bad' : '')
                  },
                  statusLine
                )
              : null,
            blocked
              ? el('span', { class: 'wf-mount-block' }, [icon('alert'), el('span', { text: m.blockers.join('；') })])
              : null,
            m.lastNote ? el('span', { class: 'wf-mount-note', text: m.lastNote }) : null,
            m.pendingProposals
              ? el('span', {
                  class: 'wf-mount-note accent',
                  text: `台账有 ${m.pendingProposals} 条 PLAN 修改提议待你确认`
                })
              : null
          ]
        ),
        el('span', { class: 'wf-mount-side' }, [
          el(
            'span',
            { class: 'wf-mount-seats', title: seated.map(c => c.name).join('、') },
            seated.slice(0, 4).map(c => avatar(c, 'room-presence-avatar'))
          ),
          el('span', { class: 'wf-mount-tools' }, [run, more])
        ])
      ]
    );
  }

  async function addMount() {
    try {
      const chat = await W.ensureChat();
      W.openMount({ chatId: chat.id });
    } catch (error) {
      toast(error.message);
    }
  }

  function mountSection() {
    const mounts = W.mountsFor(state.chat?.id);
    return el('section', { class: 'wf-section' }, [
      el('header', { class: 'wf-section-head' }, [
        el('h4', { text: '这个对话的工作流' }),
        iconButton('plus', '挂上工作流', addMount)
      ]),
      mounts.length
        ? el('ul', { class: 'wf-mounts' }, mounts.map(mountRow))
        : el('p', {
            class: 'wf-section-empty',
            text: state.chat
              ? '还没有挂工作流。挂上后可以一键或定时运行，每次的结果作为一张卡片出现在对话里。'
              : '新对话也能挂工作流，挂之前会先保存这个对话。'
          })
    ]);
  }

  function renderPanel() {
    ensureRightPanelStructure();
    const panel = document.getElementById('agent-desks-panel');
    if (!panel) return;

    if (W.status === 'unavailable') {
      panel.replaceChildren(
        el('div', { class: 'room-empty' }, [
          el('p', { class: 'room-empty-title', text: '星港服务还是旧版本' }),
          el('p', {
            class: 'room-empty-text',
            text: '伙伴和工作流由在后台运行的星港服务保存。刷新网页、关掉窗口都不会重启它。'
          }),
          el('p', {
            class: 'room-empty-text',
            text: '关掉这个窗口，再从桌面图标或 Start StarPort.cmd 打开星港：没有对话在运行时，它会先重启服务。之后这里会出现房间里的伙伴，原来浏览器里的伙伴设置会自动搬过去。'
          })
        ])
      );
      return;
    }
    if (W.status !== 'ready') {
      panel.replaceChildren(
        el('p', { class: 'room-empty-text', text: W.status === 'error' ? '读取伙伴失败，稍后会重试。' : '正在读取…' })
      );
      return;
    }

    const room = currentRoom();
    if (!room.groupId) {
      panel.replaceChildren(
        el('div', { class: 'room-empty' }, [
          el('p', { class: 'room-empty-title', text: state.chat ? '这个对话不在房间里' : '还没有进入房间' }),
          el('p', {
            class: 'room-empty-text',
            text: state.chat
              ? '把它移动到某个房间，房间里的伙伴就能接活。'
              : '在左侧任意房间里打开或新建对话，伙伴们会出现在这里。'
          })
        ]),
        W.mountsFor(state.chat?.id).length ? mountSection() : ''
      );
      return;
    }

    const menuButton = el('button', {
      type: 'button',
      class: 'icon-button room-menu-button',
      text: '⋯',
      title: '房间选项',
      'aria-label': `房间选项：${room.title}`,
      'aria-haspopup': 'menu'
    });
    menuButton.onclick = e => {
      e.stopPropagation();
      globalThis.StarportChatActions?.openGroup(room.group, menuButton);
    };
    const timed = roomMounts(room.groupId).filter(m => m.enabled && W.scheduled(m));
    const meta = el('p', { class: 'room-head-meta' }, [
      el('span', { text: room.members.length ? `${room.members.length} 位伙伴` : '还没有伙伴' }),
      timed.length
        ? el(
            'span',
            {
              class: 'room-head-routine',
              title: timed.map(m => `${W.workflow(m.workflowId)?.name} · ${W.triggerText(m.trigger)}`).join('\n')
            },
            [icon('clock'), el('span', { text: `${timed.length} 个定时工作流` })]
          )
        : null
    ]);
    const head = el('header', { class: 'room-head' }, [
      el('div', { class: 'room-head-text' }, [
        el('h3', { class: 'room-head-title', text: room.title, title: room.title }),
        meta
      ]),
      menuButton
    ]);

    const mentionedIds = new Set(W.mentioned(prompt()?.value || '', room.members).map(c => c.id));
    const roster = el(
      'ul',
      { class: 'room-roster' },
      room.members.map(c => memberRow(c, mentionedIds))
    );
    const invite = el('button', {
      type: 'button',
      class: 'room-invite',
      text: '＋ 邀请伙伴',
      onclick: () => Room.openRosterManager(room.groupId)
    });

    panel.replaceChildren(head, roster, invite, mountSection());
  }

  // --- 3. Composer: @ goes to the companions; 工作流 mode runs a mounted workflow. --------------
  function activeWorkflowMount() {
    const chatId = state.chat?.id;
    const mounts = W.mountsFor(chatId);
    if (!chatId || !mounts.length) return null;
    const chosen = prefs.workflowMode[chatId];
    return chosen ? mounts.find(m => m.id === chosen) || null : null;
  }

  function setWorkflowMode(mountId) {
    const chatId = state.chat?.id;
    if (!chatId) return;
    if (mountId) prefs.workflowMode[chatId] = mountId;
    else delete prefs.workflowMode[chatId];
    savePrefs();
    renderComposerTools();
    prompt()?.focus();
  }

  // One-way: the companions get only this message, not the conversation. Remembered per chat;
  // a new chat's setting moves to the chat once the first message creates it.
  const oneWayKey = () => state.chat?.id || 'draft';
  const oneWay = () => !!W.data?.oneWay && !!prefs.oneWay[oneWayKey()];

  function setOneWay(on) {
    if (on) prefs.oneWay[oneWayKey()] = true;
    else delete prefs.oneWay[oneWayKey()];
    savePrefs();
    renderComposerTools();
    prompt()?.focus();
  }

  function syncPlaceholder(target) {
    const input = prompt();
    if (!input) return;
    const base = t(input.dataset.i18nPlaceholder || '写下你想继续的事…');
    const next = target ? `这次运行「${W.workflow(target.workflowId)?.name || '工作流'}」的额外要求…` : base;
    if (input.placeholder !== next) input.placeholder = next;
  }

  function renderComposerTools() {
    document.getElementById('starport-roundtable-bar')?.remove();
    const composer = document.getElementById('composer');
    const send = document.getElementById('send');
    const bottom = send?.parentElement;
    if (!composer || !bottom) return;

    let tools = document.getElementById('room-composer-tools');
    if (!tools) {
      tools = el('div', { id: 'room-composer-tools', class: 'room-composer-tools' });
      bottom.insertBefore(tools, document.getElementById('composer-snippets') || send);
    }

    const ready = W.status === 'ready';
    const room = currentRoom();
    const people = ready ? room.members : [];
    const mounts = ready ? W.mountsFor(state.chat?.id) : [];
    const hits = W.mentioned(prompt()?.value || '', people);
    const target = ready ? activeWorkflowMount() : null;
    const route = hits.length ? 'dispatch' : target ? 'workflow' : 'chat';
    composer.classList.toggle('room-dispatch', route !== 'chat');
    syncPlaceholder(route === 'workflow' ? target : null);

    if (!people.length && !mounts.length) {
      tools.hidden = true;
      tools.replaceChildren();
      return;
    }
    tools.hidden = false;

    const busy = W.busyCompanions();
    const mentionedIds = new Set(hits.map(c => c.id));
    const avatars = el(
      'div',
      { class: 'room-composer-avatars', role: 'group', 'aria-label': '点名伙伴' },
      people.map(c => {
        const selected = mentionedIds.has(c.id);
        return el('button', {
          type: 'button',
          class: 'room-composer-avatar' + (selected ? ' selected' : '') + (busy.has(c.id) ? ' running' : ''),
          text: c.avatar || '·',
          title: `${selected ? '取消点名' : '点名'} @${c.name}${c.role ? ' · ' + c.role : ''}`,
          'aria-label': `${selected ? '取消点名' : '点名'} ${c.name}`,
          'aria-pressed': String(selected),
          onclick: () => toggleMention(c),
          oncontextmenu: e => {
            e.preventDefault();
            Room.openCompanion(c.id);
          }
        });
      })
    );

    let switcher = null;
    if (hits.length) {
      const isolated = oneWay();
      switcher = el('span', { class: 'room-route-group' }, [
        el('span', {
          class: 'room-route',
          title:
            hits.length > 1
              ? '先排执行顺序，再按顺序交给他们；结果作为一张卡片出现在对话里'
              : '交给这位伙伴；结果作为一张卡片出现在对话里',
          text: `交给 ${hits.map(c => c.name).join('、')}`
        }),
        W.data?.oneWay &&
          el(
            'button',
            {
              type: 'button',
              class: 'room-one-way',
              'aria-pressed': String(isolated),
              title: isolated
                ? '单向可见：伙伴只收到这条消息，看不到之前的对话；它的回答仍会回到对话里。点一下改回'
                : '改成单向可见：伙伴只收到这条消息，看不到之前的对话；它的回答仍会回到对话里',
              onclick: () => setOneWay(!isolated)
            },
            [icon('eyeOff'), el('span', { text: '单向' })]
          )
      ]);
    } else if (mounts.length) {
      const modeButton = (workflowMode, label, title) =>
        el('button', {
          type: 'button',
          text: label,
          title,
          'aria-pressed': String(workflowMode === !!target),
          onclick: () => setWorkflowMode(workflowMode ? target?.id || mounts[0].id : null)
        });
      switcher = el('span', { class: 'room-route-group' }, [
        el('div', { class: 'language-switch room-mode-switch', role: 'group', 'aria-label': '发送方式' }, [
          modeButton(false, '对话', '发给当前对话的模型'),
          modeButton(true, '工作流', '把输入作为这次运行的额外要求，运行挂在这个对话上的工作流')
        ]),
        target && mounts.length > 1
          ? el(
              'select',
              {
                class: 'room-mount-select',
                'aria-label': '运行哪个工作流',
                onchange: e => setWorkflowMode(e.target.value)
              },
              mounts.map(m =>
                el('option', {
                  value: m.id,
                  text: W.workflow(m.workflowId)?.name || '工作流',
                  ...(m.id === target.id ? { selected: '' } : {})
                })
              )
            )
          : null
      ]);
    }

    tools.replaceChildren(people.length ? avatars : '', switcher || '');
  }

  // @ and 工作流 mode take the sentence before app.js sends it to the chat's own model.
  // app.js asks here first when the user sends; true means the room took the sentence.
  let routing = false;

  function routeSend() {
    if (W.status !== 'ready') return false;
    const text = prompt()?.value || '';
    const hits = W.mentioned(text, currentRoom().members);
    const target = hits.length ? null : activeWorkflowMount();
    if (!hits.length && !target) return false;
    if (routing) return true;
    if (globalThis.StarportComposer?.ids().length) {
      toast(hits.length ? '点名伙伴时暂不能带附件，请先移除附件' : '运行工作流时暂不能带附件，请先移除附件');
      return true;
    }
    if (hits.length) {
      const rest = W.parseMentions(text, currentRoom().members)
        .reduceRight((value, hit) => value.slice(0, hit.start) + value.slice(hit.end), text)
        .trim();
      if (!rest) {
        toast('写下要交给他们的事');
        return true;
      }
    } else if (!text.trim()) {
      toast('写下这次的要求再发送；不加要求直接运行，点右栏工作流旁的 ▶');
      return true;
    }
    routing = true;
    const draft = !state.chat;
    const isolated = hits.length > 0 && oneWay();
    (hits.length ? W.dispatch(text, { isolated }) : W.runMount(target.id, text.trim()))
      .then(result => {
        if (!draft || !isolated || !result?.user?.chat_id) return;
        prefs.oneWay[result.user.chat_id] = true;
        delete prefs.oneWay.draft;
        savePrefs();
      })
      .catch(error => toast(error.message))
      .finally(() => {
        routing = false;
      });
    return true;
  }

  function renderAll() {
    globalThis.StarportRoomMigration?.maybeMigrate();
    decorateSidebar();
    renderPanel();
    renderComposerTools();
    W.renderReplyChip();
  }

  // app.js calls this after it redraws the sidebar, the header, the tool options or the messages;
  // workflow state changes call it too. Redraws in one frame are drawn once.
  let installed = false;
  let scheduled = false;

  function scheduleRender() {
    if (!installed || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyRightTabVisibility();
      renderAll();
    });
  }

  function installHooks() {
    installed = true;
    W.subscribe(scheduleRender);

    const promptEl = prompt();
    if (promptEl) {
      let signature = '';
      promptEl.addEventListener('input', () => {
        renderComposerTools();
        const next = W.mentioned(promptEl.value, currentRoom().members)
          .map(c => c.id)
          .join(',');
        if (next !== signature) {
          signature = next;
          renderPanel();
        }
      });
    }

    W.load();
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installHooks);
  else setTimeout(installHooks, 0);

  return Object.assign(Room, {
    renderAll,
    scheduleRender,
    routeSend,
    // Used by room-companions.js and room-delete.js.
    roomInfo,
    currentGroupId,
    currentRoom,
    roomMounts,
    modelLine,
    toggleMention
  });
})();

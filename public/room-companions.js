'use strict';

// A companion's card and settings, and who is in a room. Part of StarportAgentsRoom (agents-room.js).
(() => {
  const Room = globalThis.StarportAgentsRoom;
  const W = globalThis.StarportWorkflows;
  const { el, icon, avatar, textAction, field, showDialog, closeDialog, confirmDialog, modelPicker } =
    globalThis.StarportUI;
  const { roomInfo, currentGroupId, currentRoom, roomMounts, modelLine, toggleMention } = Room;

  // --- a companion: who it is, where it sits, what it did here --------------------------------
  function seatsOf(companionId, gid) {
    if (!gid) return [];
    const seats = [];
    for (const m of roomMounts(gid)) {
      const wf = W.workflow(m.workflowId);
      for (const { position } of W.positionsOf(wf)) {
        if (m.assignments?.[position.id] === companionId) seats.push({ mount: m, workflow: wf, position });
      }
    }
    return seats;
  }

  function openCompanion(id) {
    const c = W.companion(id);
    if (!c) return;
    const room = currentRoom();
    const inRoom = room.members.some(m => m.id === c.id);
    const score = W.data?.scores?.[c.id];
    const seats = seatsOf(c.id, room.groupId);
    const recent = [];
    for (let i = state.messages.length - 1; i >= 0 && recent.length < 6; i--) {
      const message = state.messages[i];
      const run = message.details?.workflowRun;
      for (const step of [...(run?.steps || [])].reverse()) {
        if (step.companionId === c.id && step.status !== 'waiting' && recent.length < 6)
          recent.push({ step, run, message });
      }
    }

    const body = [
      el('p', { class: 'room-desk-meta', text: [modelLine(c), modeLine(c)].filter(Boolean).join(' · ') }),
      c.persona ? el('p', { class: 'room-desk-duty', text: c.persona }) : null,
      score
        ? el('p', {
            class: 'room-dialog-note',
            text: `已判定的预测 ${score.n} 条 · Brier 分数 ${score.brier}（0 最准，0.25 相当于瞎猜五五开）`
          })
        : null,
      el('div', { class: 'room-field' }, [
        el('span', {
          class: 'room-field-label',
          text: room.groupId ? `在「${room.title}」的工作流里` : '工作流里的位置'
        }),
        seats.length
          ? el(
              'ul',
              { class: 'room-duty-list' },
              seats.map(seat =>
                el('li', {}, [
                  icon('flow'),
                  el('span', {}, [
                    el('strong', { text: `${seat.workflow.name} · ${seat.position.name}` }),
                    el('span', {
                      text: `${state.chats.find(chat => chat.id === seat.mount.chatId)?.title || ''} · ${W.oneLine(seat.position.task, 80)}`
                    })
                  ])
                ])
              )
            )
          : el('span', { class: 'room-field-hint', text: '这个房间里还没有给它安排位置。' })
      ]),
      el('div', { class: 'room-field' }, [
        el('span', { class: 'room-field-label', text: '在这个对话里做过的事' }),
        recent.length
          ? el(
              'ul',
              { class: 'room-duty-list' },
              recent.map(({ step, run, message }) =>
                el(
                  'li',
                  {
                    class: 'wf-recent',
                    onclick: () => {
                      closeDialog();
                      W.scrollToMessage(message.id);
                    }
                  },
                  [
                    el('span', {}, [
                      el('strong', {
                        text: `${run.title} · ${W.when(step.started || run.started)}${step.status === 'failed' ? ' · 没完成' : step.verdict === 'fail' ? ' · 验收不通过' : ''}`
                      }),
                      el('span', { text: W.oneLine(W.splitDuty(step.output).duty || step.error || step.task, 120) })
                    ])
                  ]
                )
              )
            )
          : el('span', { class: 'room-field-hint', text: '还没有。' })
      ])
    ];

    showDialog({
      size: 'wide',
      lead: avatar(c, 'room-avatar large'),
      eyebrow: c.role || '伙伴',
      title: c.name,
      body,
      footer: [
        inRoom
          ? el('button', {
              type: 'button',
              class: 'secondary-button wf-footer-left',
              text: '离开房间',
              onclick: () => leaveRoom(room.groupId, c, () => openCompanion(c.id))
            })
          : null,
        el('button', {
          type: 'button',
          class: 'secondary-button',
          text: '设置',
          onclick: () => openCompanionConfig(c)
        }),
        inRoom
          ? el('button', {
              type: 'button',
              class: 'primary-button',
              text: `@ ${c.name}`,
              onclick: () => {
                closeDialog();
                toggleMention(c);
              }
            })
          : null
      ]
    });
  }

  // --- who is in the room: every companion can enter or leave any room ------------------------
  function openRosterManager(gid = null) {
    const room = roomInfo(gid || currentGroupId());
    if (!room.groupId) {
      toast('先进入一个房间，再邀请伙伴');
      return;
    }
    if (W.status !== 'ready') {
      toast(W.status === 'unavailable' ? '星港服务还是旧版本，请关掉窗口后从桌面图标重新打开' : '正在读取伙伴…');
      return;
    }
    const present = new Set(room.members.map(c => c.id));
    const list = el('ul', { class: 'room-roster-manage' });
    if (room.members.length)
      list.append(
        el('li', { class: 'in-room' }, [
          avatar(W.MAIN),
          el('span', { class: 'room-member-text' }, [
            el('span', { class: 'room-member-name', text: W.MAIN.name }),
            el('span', { class: 'room-member-role', text: '这个房间里各个对话自己的模型' }),
            callToggles(room, W.MAIN.id, W.MAIN.name)
          ])
        ])
      );
    for (const c of W.companions()) {
      const inRoom = present.has(c.id);
      const toggle = el('button', {
        type: 'button',
        class: 'secondary-button room-presence-toggle',
        text: inRoom ? '在房间里' : '邀请进来',
        title: inRoom ? `让 ${c.name} 离开「${room.title}」` : `邀请 ${c.name} 进入「${room.title}」`,
        'aria-pressed': String(inRoom)
      });
      toggle.onclick = async () => {
        if (inRoom) {
          leaveRoom(room.groupId, c, () => openRosterManager(room.groupId));
          return;
        }
        toggle.disabled = true;
        try {
          await W.call('/rooms/' + room.groupId + '/members', 'POST', { companionId: c.id });
          openRosterManager(room.groupId);
        } catch (error) {
          toggle.disabled = false;
          toast(error.message);
        }
      };
      list.append(
        el('li', { class: inRoom ? 'in-room' : '' }, [
          avatar(c),
          el('span', { class: 'room-member-text' }, [
            el('span', { class: 'room-member-name', text: c.name }),
            el('span', { class: 'room-member-role', text: [c.role, modelLine(c)].filter(Boolean).join(' · ') }),
            inRoom ? memoryToggles(room, c) : null,
            inRoom ? callToggles(room, c.id, c.name) : null
          ]),
          textAction('设置', () => openCompanionConfig(c, { back: () => openRosterManager(room.groupId) })),
          toggle
        ])
      );
    }

    showDialog({
      eyebrow: room.title,
      title: '房间里的伙伴',
      body: [
        el('p', {
          class: 'room-dialog-note',
          text: '伙伴可以自由进出任何房间，性格和模型跟着伙伴走；它在工作流里做什么，由工作流的位置决定。能不能读长期记忆、提记忆候选，干活时能调用哪些伙伴，每个房间分别设置。'
        }),
        W.companions().length ? list : el('p', { class: 'room-desk-empty', text: '还没有伙伴。' })
      ],
      footer: [
        el('button', {
          type: 'button',
          class: 'secondary-button',
          text: '＋ 新伙伴',
          onclick: () =>
            openCompanionConfig(null, { groupId: room.groupId, back: () => openRosterManager(room.groupId) })
        }),
        el('button', { type: 'button', class: 'primary-button', text: '完成', onclick: closeDialog })
      ]
    });
  }

  // Per room: may this companion read confirmed long-term memory, and propose new candidates?
  function memoryToggles(room, c) {
    const current = W.memoryOf(room.groupId, c.id);
    const box = el('span', { class: 'room-member-memory' });
    for (const [key, label, title] of [
      ['read', '读长期记忆', `${c.name} 在「${room.title}」里干活时，可以检索、读取你确认过的长期记忆`],
      ['propose', '提记忆候选', `${c.name} 在「${room.title}」里可以提出记忆候选，你确认后才会保存`]
    ]) {
      const input = el('input', { type: 'checkbox', checked: !!current[key] });
      input.onchange = async () => {
        input.disabled = true;
        try {
          await W.call('/rooms/' + room.groupId + '/members/' + c.id + '/memory', 'PATCH', { [key]: input.checked });
        } catch (error) {
          input.checked = !input.checked;
          toast(error.message);
        } finally {
          input.disabled = false;
        }
      };
      box.append(el('label', { class: 'room-check room-memory-check', title }, [input, el('span', { text: label })]));
    }
    return box;
  }

  // Per room: whom this caller may hand part of its task to while it works. Nobody unless ticked.
  function callToggles(room, callerId, callerName) {
    const others = room.members.filter(m => m.id !== callerId);
    if (!others.length) return null;
    const current = new Set(W.callsOf(room.groupId, callerId));
    const box = el('span', { class: 'room-member-memory room-member-calls' }, [
      el('span', { class: 'room-calls-label', text: '可以调用' })
    ]);
    const rows = others.map(m => {
      const input = el('input', { type: 'checkbox', checked: current.has(m.id) });
      box.append(
        el(
          'label',
          {
            class: 'room-check room-memory-check',
            title: `${callerName} 在「${room.title}」里干活时，可以把一部分任务交给 ${m.name}`
          },
          [input, el('span', { text: `${m.avatar} ${m.name}` })]
        )
      );
      return { id: m.id, input };
    });
    for (const { input } of rows) {
      input.onchange = async () => {
        for (const row of rows) row.input.disabled = true;
        try {
          const callees = rows.filter(row => row.input.checked).map(row => row.id);
          await W.call('/rooms/' + room.groupId + '/calls/' + callerId, 'PUT', { callees });
        } catch (error) {
          input.checked = !input.checked;
          toast(error.message);
        } finally {
          for (const row of rows) row.input.disabled = false;
        }
      };
    }
    return box;
  }

  // Positions a leaving companion holds in this room are handed to someone else or left empty.
  function leaveRoom(gid, c, back) {
    const room = roomInfo(gid);
    const seats = seatsOf(c.id, gid);
    const remove = async reassign => {
      await W.call('/rooms/' + gid + '/members/' + c.id + '/remove', 'POST', { reassign });
      toast(`${c.name} 离开了「${room.title}」`);
      back ? back() : closeDialog();
    };
    if (!seats.length) {
      remove({}).catch(error => toast(error.message));
      return;
    }
    const others = room.members.filter(m => m.id !== c.id);
    const outside = W.companions().filter(m => m.id !== c.id && !others.some(o => o.id === m.id));
    const choices = seats.map(seat => {
      const select = el('select', { 'aria-label': `${seat.position.name} 由谁接替` }, [
        el('option', { value: '', text: '空着（这个工作流会暂停）' }),
        others.length
          ? el(
              'optgroup',
              { label: '房间里' },
              others.map(m => el('option', { value: m.id, text: `${m.avatar} ${m.name}` }))
            )
          : null,
        outside.length
          ? el(
              'optgroup',
              { label: '其他伙伴（会加入房间）' },
              outside.map(m => el('option', { value: m.id, text: `${m.avatar} ${m.name}` }))
            )
          : null
      ]);
      return { seat, select };
    });
    showDialog({
      eyebrow: room.title,
      title: `${c.name} 要离开房间`,
      lead: avatar(c, 'room-avatar large'),
      body: [
        el('p', {
          class: 'room-dialog-note',
          text: `${c.name} 在这个房间的工作流里坐着 ${seats.length} 个位置。离开前，选谁来接替；空着的位置会让那个工作流暂停。`
        }),
        el(
          'div',
          { class: 'wf-seats' },
          choices.map(({ seat, select }) =>
            el('div', { class: 'wf-seat' }, [
              el('span', { class: 'wf-seat-text' }, [
                el('span', { class: 'wf-seat-name', text: `${seat.workflow.name} · ${seat.position.name}` }),
                el('span', {
                  class: 'wf-seat-task',
                  text: (state.chats || []).find(chat => chat.id === seat.mount.chatId)?.title || ''
                })
              ]),
              select
            ])
          )
        )
      ],
      footer: [
        el('button', {
          type: 'button',
          class: 'secondary-button',
          text: '取消',
          onclick: () => (back ? back() : closeDialog())
        }),
        el('button', { type: 'submit', class: 'primary-button', text: '离开房间' })
      ],
      onsubmit: async () => {
        const reassign = {};
        for (const { seat, select } of choices)
          (reassign[seat.mount.id] ||= {})[seat.position.id] = select.value || null;
        await remove(reassign);
      }
    });
  }

  // The tool's own 工作方式, redrawn when the tool changes. A new tool starts from its safe
  // defaults rather than inheriting the previous tool's choices.
  function deskModes(existing, providerSelect) {
    const box = el('div', { class: 'room-field-stack' });
    let controls = [];
    function draw() {
      const provider = providerSelect.value;
      const fields = W.data?.deskFields?.[provider] || [];
      const saved = existing?.provider === provider ? existing.options || {} : {};
      const hint = el('span', { class: 'room-field-hint' });
      const describe = () => {
        const notes = controls
          .map(c => c.spec.choices?.find(choice => choice.value === c.read())?.description)
          .filter(Boolean);
        hint.textContent = [...notes, '伙伴在无人值守的工位里工作：仍需审批的操作会被自动拒绝，提的问题会跳过。'].join(
          ' '
        );
      };
      controls = fields.map(spec => {
        const value = saved[spec.key] ?? spec.default;
        if (spec.type === 'checkbox') {
          const input = el('input', { type: 'checkbox', checked: !!value });
          return {
            spec,
            read: () => input.checked,
            node: el('label', { class: 'room-check' }, [input, el('span', { text: spec.label })])
          };
        }
        const select = el(
          'select',
          { onchange: () => describe() },
          spec.choices.map(c => el('option', { value: c.value, text: c.label }))
        );
        select.value = value;
        return { spec, read: () => select.value, node: field(spec.label, select) };
      });
      const selects = controls.filter(c => c.spec.type === 'select').map(c => c.node);
      const checks = controls.filter(c => c.spec.type === 'checkbox').map(c => c.node);
      if (!controls.length) hint.textContent = `${W.PROVIDER_LABELS[provider] || provider} 没有可选的工作方式。`;
      else describe();
      box.replaceChildren(
        selects.length > 1 ? el('div', { class: 'room-field-grid' }, selects) : selects[0] || '',
        ...checks,
        hint
      );
    }
    providerSelect.addEventListener('change', draw);
    draw();
    return { node: box, value: () => Object.fromEntries(controls.map(c => [c.spec.key, c.read()])) };
  }

  // A companion's 工作方式 in a few words: the chosen labels, leaving out plain 对话 mode.
  function modeLine(c) {
    return (W.data?.deskFields?.[c.provider] || [])
      .filter(spec => spec.type === 'select' && (spec.key !== 'mode' || c.options?.mode !== spec.choices[0].value))
      .map(spec => spec.choices.find(choice => choice.value === c.options?.[spec.key])?.label)
      .filter(Boolean)
      .join(' · ');
  }

  // --- a companion's identity: name, look, model, 工作方式 and personality. No duties here. ------
  function openCompanionConfig(existing, { groupId = null, back = null } = {}) {
    const isNew = !existing;
    const name = el('input', {
      type: 'text',
      value: existing?.name || '',
      maxlength: '40',
      placeholder: '例如：莉芙、探子'
    });
    const face = el('input', {
      type: 'text',
      value: existing?.avatar || '🤖',
      maxlength: '16',
      placeholder: '一个 emoji'
    });
    const role = el('input', {
      type: 'text',
      value: existing?.role || '',
      maxlength: '80',
      placeholder: '例如：信息猎手 · 预期差扫描'
    });
    const picker = modelPicker(existing || { provider: 'codex' });
    const modes = deskModes(existing, picker.provider);
    const persona = el('textarea', {
      rows: '4',
      placeholder: '说话风格与性格，只影响它跟你说话的语气，不影响分析。它在工作流里做什么，由位置决定。'
    });
    persona.value = existing?.persona || '';
    const leave = () => (back ? back() : closeDialog());

    const remove = existing
      ? el('button', {
          type: 'button',
          class: 'secondary-button wf-footer-left',
          text: '删除伙伴',
          onclick: () => {
            const seats = (W.data?.mounts || []).flatMap(m =>
              Object.values(m.assignments || {}).filter(id => id === existing.id)
            );
            confirmDialog({
              eyebrow: existing.name,
              title: `删除「${existing.name}」？`,
              text: `${seats.length ? `它坐着的 ${seats.length} 个位置会空出来，相关工作流会暂停。` : ''}它在各房间的工位记录也会删除；对话里已有的运行卡片保留。`,
              confirm: '删除伙伴',
              danger: true,
              back: () => openCompanionConfig(existing, { groupId, back }),
              action: async () => {
                await W.call('/companions/' + existing.id, 'DELETE');
                toast(`已删除「${existing.name}」`);
                leave();
              }
            });
          }
        })
      : null;

    showDialog({
      eyebrow: isNew ? '新伙伴' : '伙伴设置',
      focus: isNew ? name : null,
      title: isNew ? '招募一位伙伴' : existing.name,
      lead: existing ? avatar(existing, 'room-avatar large') : null,
      body: [
        el('div', { class: 'room-field-grid' }, [field('名字', name, '点名时写 @名字'), field('头像', face)]),
        field('角色', role),
        el('div', { class: 'room-field-grid' }, [field('工具', picker.provider), field('思考强度', picker.effort)]),
        field('模型', picker.model),
        modes.node,
        field('性格', persona)
      ],
      footer: [
        remove,
        el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: leave }),
        el('button', { type: 'submit', class: 'primary-button', text: isNew ? '招募' : '保存' })
      ],
      onsubmit: async () => {
        if (!name.value.trim()) {
          name.focus();
          throw new Error('请输入伙伴名字');
        }
        const model = picker.value();
        if (!model.provider) throw new Error('请选择工具');
        const payload = {
          name: name.value.trim(),
          avatar: face.value.trim() || '🤖',
          role: role.value.trim(),
          persona: persona.value.trim(),
          provider: model.provider,
          model: model.model,
          effort: model.effort,
          service: model.service,
          options: modes.value()
        };
        if (isNew) await W.call('/companions', 'POST', { ...payload, ...(groupId ? { groupId } : {}) });
        else await W.call('/companions/' + existing.id, 'PATCH', payload);
        toast(isNew ? `已招募「${payload.name}」` : `已保存「${payload.name}」`);
        leave();
      }
    });
  }

  Object.assign(Room, { openCompanion, openCompanionConfig, openRosterManager });
})();

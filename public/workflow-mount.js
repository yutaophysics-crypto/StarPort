'use strict';

// Mounting a workflow on a conversation: who sits in each position and when it runs.
// Part of StarportWorkflows (workflows.js).
(() => {
  const Workflows = globalThis.StarportWorkflows;
  const { el, icon, textAction, field, showDialog, closeDialog, confirmDialog, segmented } = globalThis.StarportUI;
  const {
    call,
    WEEKDAYS,
    companion,
    companions,
    members,
    workflow,
    workflows,
    mount,
    chatById,
    positionsOf,
    oneLine,
    openEditor
  } = Workflows;

  // --- mounting a workflow on a conversation ------------------------------------------------
  function openMount({ chatId, mountId = null, draft = null, note = '' } = {}) {
    const existing = mountId ? mount(mountId) : null;
    const chat = chatById(existing?.chatId || chatId);
    if (!chat) {
      toast('对话不存在');
      return;
    }
    const groupId = chat.group_id;
    const room = members(groupId);
    const roomIds = new Set(room.map(c => c.id));
    const others = companions().filter(c => !roomIds.has(c.id));
    const form = {
      workflowId: existing?.workflowId || draft?.workflowId || '',
      assignments: { ...(existing?.assignments || {}), ...(draft?.assignments || {}) },
      trigger: JSON.parse(JSON.stringify(draft?.trigger || existing?.trigger || { type: 'manual' })),
      missed: draft?.missed || existing?.missed || 'once',
      enabled: draft?.enabled ?? existing?.enabled ?? true
    };
    if (!existing && !workflow(form.workflowId)) form.workflowId = workflows()[0]?.id || '';
    // Going to the editor and back keeps everything chosen so far.
    const keep = () => ({
      ...form,
      assignments: { ...form.assignments },
      trigger: {
        type: form.trigger.type,
        time: time.value,
        days: [...days],
        every: Number(every.value) || 30,
        unit: unit.value
      },
      missed: missed.value,
      enabled: enabled.checked
    });
    const back = () => openMount({ chatId: chat.id, mountId, draft: keep(), note });

    const workflowSelect = el('select', {}, [
      workflows().length ? null : el('option', { value: '', text: '还没有工作流' }),
      ...workflows().map(w => el('option', { value: w.id, text: w.name })),
      el('option', { value: '__new__', text: '＋ 新建工作流…' })
    ]);
    workflowSelect.value = form.workflowId;
    const seats = el('div', { class: 'wf-seats' });

    function drawSeats() {
      const wf = workflow(form.workflowId);
      if (!wf) {
        seats.replaceChildren(el('p', { class: 'room-field-hint', text: '先选一个工作流。' }));
        return;
      }
      // Only the role's first part, so the closed select shows the whole label.
      const seatLabel = c => `${c.avatar} ${c.name}${c.role ? ' · ' + c.role.split(' · ')[0] : ''}`;
      seats.replaceChildren(
        ...wf.stages.map((stage, si) =>
          el('div', { class: 'wf-seat-stage' }, [
            el('p', { class: 'wf-seat-stage-name', text: `${si + 1} · ${stage.name}` }),
            ...stage.positions.map(position => {
              const select = el('select', { 'aria-label': `${position.name} 由谁来坐` }, [
                el('option', { value: '', text: '空着（工作流会暂停）' }),
                room.length
                  ? el(
                      'optgroup',
                      { label: '房间里' },
                      room.map(c => el('option', { value: c.id, text: seatLabel(c) }))
                    )
                  : null,
                others.length
                  ? el(
                      'optgroup',
                      { label: groupId ? '其他伙伴（会加入房间）' : '其他伙伴' },
                      others.map(c => el('option', { value: c.id, text: seatLabel(c) }))
                    )
                  : null
              ]);
              select.value =
                form.assignments[position.id] && companion(form.assignments[position.id])
                  ? form.assignments[position.id]
                  : '';
              select.onchange = () => {
                form.assignments[position.id] = select.value || null;
                select.closest('.wf-seat').classList.toggle('empty', !select.value);
              };
              return el('div', { class: 'wf-seat' + (select.value ? '' : ' empty') }, [
                el('span', { class: 'wf-seat-text' }, [
                  el('span', { class: 'wf-seat-name' }, [
                    position.name,
                    position.verify ? el('span', { class: 'wf-badge', text: '验收' }) : null
                  ]),
                  el('span', { class: 'wf-seat-task', text: oneLine(position.task, 90), title: position.task })
                ]),
                select
              ]);
            })
          ])
        )
      );
    }

    workflowSelect.onchange = () => {
      if (workflowSelect.value === '__new__') {
        openEditor(null, {
          onDone: saved =>
            openMount({
              chatId: chat.id,
              mountId,
              draft: { ...keep(), workflowId: saved?.id || form.workflowId },
              note
            })
        });
        return;
      }
      form.workflowId = workflowSelect.value;
      drawSeats();
    };
    drawSeats();

    // Trigger
    const time = el('input', { type: 'time', value: form.trigger.time || '15:15' });
    const days = new Set(form.trigger.days || [1, 2, 3, 4, 5]);
    const dayChips = el('div', { class: 'wf-days', role: 'group', 'aria-label': '哪几天' });
    const drawDays = () =>
      dayChips.replaceChildren(
        ...WEEKDAYS.map((label, i) =>
          el('button', {
            type: 'button',
            class: 'wf-day',
            text: label,
            'aria-pressed': String(days.has(i + 1)),
            'aria-label': '周' + label,
            onclick: () => {
              if (days.has(i + 1)) days.delete(i + 1);
              else days.add(i + 1);
              drawDays();
            }
          })
        ),
        textAction('每天', () => {
          [1, 2, 3, 4, 5, 6, 7].forEach(d => days.add(d));
          drawDays();
        }),
        textAction('周一至周五', () => {
          days.clear();
          [1, 2, 3, 4, 5].forEach(d => days.add(d));
          drawDays();
        })
      );
    drawDays();
    const every = el('input', {
      type: 'number',
      min: '1',
      max: '10000',
      step: '1',
      value: String(form.trigger.every || 30),
      class: 'wf-every'
    });
    const unit = el('select', { class: 'wf-unit' }, [
      el('option', { value: 'minutes', text: '分钟' }),
      el('option', { value: 'hours', text: '小时' })
    ]);
    unit.value = form.trigger.unit || 'minutes';
    const missed = el('select', {}, [
      el('option', { value: 'once', text: '开机后补跑一次' }),
      el('option', { value: 'skip', text: '跳过' })
    ]);
    missed.value = form.missed;
    const enabled = el('input', { type: 'checkbox', checked: form.enabled !== false });

    const dailyBox = el('div', { class: 'wf-trigger-box' }, [el('div', { class: 'wf-inline' }, [time]), dayChips]);
    const intervalBox = el('div', { class: 'wf-trigger-box' }, [
      el('div', { class: 'wf-inline' }, [el('span', { text: '每' }), every, unit]),
      el('span', { class: 'room-field-hint', text: '最短 5 分钟；上一次还没跑完时，这一次跳过。' })
    ]);
    const scheduleBox = el('div', { class: 'wf-trigger-box' }, [
      field('星港没开着、错过了时间', missed),
      el('label', { class: 'room-check' }, [enabled, el('span', { text: '按时自动运行（取消勾选＝暂停）' })])
    ]);
    const drawTrigger = type => {
      form.trigger.type = type;
      dailyBox.hidden = type !== 'daily';
      intervalBox.hidden = type !== 'interval';
      scheduleBox.hidden = type === 'manual';
    };
    const triggerSwitch = segmented(
      [
        { value: 'manual', label: '只在点它时', title: '在对话里点 ▶，或在输入框切到「工作流」发送' },
        { value: 'daily', label: '每天定时' },
        { value: 'interval', label: '每隔一段时间' }
      ],
      form.trigger.type,
      drawTrigger,
      '什么时候运行'
    );
    drawTrigger(form.trigger.type);

    const remove = existing
      ? el('button', {
          type: 'button',
          class: 'secondary-button wf-footer-left',
          text: '卸下',
          disabled: !!existing.runningId,
          title: existing.runningId ? '正在运行，先停止' : null,
          onclick: () =>
            confirmDialog({
              eyebrow: chat.title,
              title: `卸下「${workflow(existing.workflowId)?.name || '工作流'}」？`,
              text: '只是不再挂在这个对话上。工作流本身、已有的运行记录和台账文件都保留。',
              confirm: '卸下',
              danger: true,
              back,
              action: async () => {
                await call('/mounts/' + existing.id, 'DELETE');
                toast('已卸下');
                closeDialog();
              }
            })
        })
      : null;

    const wf = workflow(form.workflowId);
    showDialog({
      size: 'wide',
      eyebrow: chat.title,
      title: existing ? `「${wf?.name || '工作流'}」的座位与时间` : '挂上工作流',
      body: [
        note ? el('p', { class: 'room-dialog-note wf-note', text: note }) : null,
        !groupId
          ? el('p', { class: 'wf-warning' }, [
              icon('alert'),
              el('span', { text: '这个对话在「未分组」：挂上的工作流会暂停，移进某个房间后才会运行。' })
            ])
          : null,
        existing
          ? field(
              '工作流',
              el('div', { class: 'wf-inline' }, [
                el('span', { class: 'wf-strong', text: wf?.name || '（已删除）' }),
                wf ? textAction('编辑定义…', () => openEditor(wf, { onDone: () => back() })) : null
              ])
            )
          : field('工作流', workflowSelect, '同一个工作流可以挂在不同房间的对话上，各自有自己的人选、时间和台账。'),
        el('div', { class: 'room-field' }, [
          el('span', { class: 'room-field-label', text: '谁坐在哪个位置' }),
          el('span', { class: 'room-field-hint', text: groupId ? '房间外的伙伴会自动加入这个房间。' : '' }),
          seats
        ]),
        el('div', { class: 'room-field' }, [
          el('span', { class: 'room-field-label', text: '什么时候运行' }),
          triggerSwitch,
          dailyBox,
          intervalBox,
          scheduleBox
        ])
      ],
      footer: [
        remove,
        el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: closeDialog }),
        el('button', { type: 'submit', class: 'primary-button', text: existing ? '保存' : '挂上' })
      ],
      onsubmit: async () => {
        const target = workflow(form.workflowId);
        if (!target) throw new Error('先选一个工作流');
        let trigger = { type: form.trigger.type };
        if (trigger.type === 'daily') {
          if (!time.value) throw new Error('请填写时间');
          if (!days.size) throw new Error('至少选一天');
          trigger = { type: 'daily', time: time.value, days: [...days].sort((a, b) => a - b) };
        } else if (trigger.type === 'interval') {
          const n = Number(every.value);
          if (!Number.isInteger(n) || n < 1) throw new Error('间隔应为正整数');
          if (unit.value === 'minutes' && n < 5) throw new Error('间隔至少 5 分钟');
          trigger = { type: 'interval', every: n, unit: unit.value };
        }
        const assignments = Object.fromEntries(
          positionsOf(target).map(({ position }) => [position.id, form.assignments[position.id] || null])
        );
        const payload = {
          trigger,
          missed: missed.value,
          enabled: trigger.type === 'manual' ? true : enabled.checked,
          assignments
        };
        if (existing) await call('/mounts/' + existing.id, 'PATCH', payload);
        else await call('/chats/' + chat.id + '/mounts', 'POST', { workflowId: target.id, ...payload });
        const joined = Object.values(assignments)
          .filter(id => id && groupId && !roomIds.has(id))
          .map(id => companion(id)?.name);
        toast(
          `${existing ? '已保存' : `已挂上「${target.name}」`}${joined.length ? `，${joined.join('、')} 加入了房间` : ''}`
        );
        closeDialog();
      }
    });
  }

  Object.assign(Workflows, { openMount });
})();

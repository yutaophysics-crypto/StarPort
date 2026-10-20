'use strict';

// Exam cards. A proposal comes from the conversation's model; the user checks the paper and the
// seats, may change them, and presses 开考 — the model cannot start an exam itself. On a running or
// finished exam each seat shows its folder and what the checks found. Part of StarportWorkflows.
(() => {
  const Workflows = globalThis.StarportWorkflows;
  const { el, icon, avatar, iconButton } = globalThis.StarportUI;
  const { tr, companion, companions, when, renderMarkdown, RUN_LABEL } = Workflows;
  const MINUTES = [30, 60, 120, 240, 480, 0];
  const MAX_SEATS = 8;
  // The user's edits to a proposal, kept across re-renders until it starts.
  const drafts = new Map();

  const sizeText = bytes =>
    bytes < 1024
      ? bytes + ' B'
      : bytes < 1024 ** 2
        ? (bytes / 1024).toFixed(1) + ' KB'
        : bytes < 1024 ** 3
          ? (bytes / 1024 ** 2).toFixed(1) + ' MB'
          : (bytes / 1024 ** 3).toFixed(2) + ' GB';
  const minutesText = minutes => (minutes ? tr('{minutes} 分钟', { minutes }) : tr('不限时'));
  const lastPart = path => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  const parent = path => path.replace(/[\\/][^\\/]*$/, '') || path;

  function openFolder(path) {
    api('/folders/open', 'POST', { path }).catch(error => toast(error.message));
  }

  function pathButton(path, label = path) {
    return el('button', { type: 'button', class: 'wf-exam-path', title: tr('在资源管理器中打开'), onclick: () => openFolder(path) }, [
      icon('folder'),
      el('span', { text: label })
    ]);
  }

  // The paper, the knowledge and (once started) the exam folder.
  function facts(run) {
    const exam = run.exam;
    const rows = [
      [
        tr('试卷'),
        [
          pathButton(exam.paper.path),
          el('span', {
            class: 'wf-exam-note',
            text: tr('{count} 个文件 · {size}', { count: exam.paper.files, size: sizeText(exam.paper.bytes || 0) })
          }),
          run.status === 'proposed' && exam.paper.top?.length
            ? el('span', { class: 'wf-exam-note wf-exam-top', text: exam.paper.top.join('  ') })
            : null
        ]
      ],
      exam.knowledge?.length
        ? [tr('知识库'), exam.knowledge.map(item => pathButton(item.kind === 'file' ? parent(item.path) : item.path, item.path))]
        : null,
      exam.folder ? [tr('考场文件夹'), [pathButton(exam.folder)]] : null
    ].filter(Boolean);
    return el('dl', { class: 'wf-exam-facts' }, rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', {}, value)]));
  }

  function instruction(run, open) {
    const body = renderMarkdown(run.exam.instruction || '');
    body.classList.add('wf-exam-task-body');
    return el('details', { class: 'wf-exam-task', open }, [el('summary', { text: tr('题目说明') }), body]);
  }

  function draftOf(run) {
    if (!drafts.has(run.id))
      drafts.set(run.id, { seats: run.exam.seats.map(seat => ({ ...seat })), minutes: run.exam.minutes ?? 120 });
    return drafts.get(run.id);
  }

  function renderProposal(msg) {
    const run = msg.details.workflowRun;
    const exam = run.exam;
    const draft = draftOf(run);
    const chatId = msg.chat_id || state.chat?.id;
    const withKnowledge = exam.knowledge?.length > 0;
    const card = el('div', { class: 'wf-card exam proposed open', 'data-run-id': run.id });
    const redraw = () => card.replaceWith(renderProposal(msg));

    const seats = el(
      'ol',
      { class: 'wf-exam-seats' },
      draft.seats.map((seat, index) => {
        const c = companion(seat.companionId);
        return el('li', { class: 'wf-exam-seat' }, [
          el('span', { class: 'wf-plan-order', text: String(index + 1) }),
          avatar(c || seat, 'wf-mini-avatar'),
          el('span', { class: 'wf-exam-seat-name', text: c?.name || seat.companionName || tr('（已删除的伙伴）') }),
          withKnowledge
            ? el(
                'button',
                {
                  type: 'button',
                  class: 'wf-exam-toggle',
                  'aria-pressed': String(!!seat.knowledge),
                  title: seat.knowledge ? tr('开卷：考位里有知识库') : tr('闭卷：考位里没有知识库'),
                  onclick: () => {
                    seat.knowledge = !seat.knowledge;
                    redraw();
                  }
                },
                [icon('book'), el('span', { text: seat.knowledge ? tr('开卷') : tr('闭卷') })]
              )
            : null,
          draft.seats.length > 1
            ? iconButton(
                'cross',
                tr('移除这个考位'),
                () => {
                  draft.seats.splice(index, 1);
                  redraw();
                },
                'room-tool wf-exam-remove'
              )
            : null
        ]);
      })
    );
    const add = el(
      'select',
      {
        class: 'room-mount-select',
        'aria-label': tr('添加考位'),
        disabled: draft.seats.length >= MAX_SEATS,
        onchange: event => {
          const c = companion(event.target.value);
          if (!c) return;
          draft.seats.push({ companionId: c.id, companionName: c.name, avatar: c.avatar, knowledge: withKnowledge });
          redraw();
        }
      },
      [el('option', { value: '', text: tr('添加考位…') }), ...companions().map(c => el('option', { value: c.id, text: `${c.avatar || ''} ${c.name}`.trim() }))]
    );
    const limit = el(
      'select',
      {
        class: 'room-mount-select',
        'aria-label': tr('每个考位的时限'),
        onchange: event => {
          draft.minutes = Number(event.target.value);
        }
      },
      [...new Set([...MINUTES, draft.minutes])].map(minutes =>
        el('option', { value: String(minutes), text: minutesText(minutes), selected: minutes === draft.minutes ? '' : null })
      )
    );
    limit.value = String(draft.minutes);

    const start = el('button', {
      type: 'button',
      class: 'primary-button wf-exam-start',
      text: tr('开考'),
      onclick: async () => {
        start.disabled = true;
        try {
          await Workflows.startExam(chatId, msg.id, {
            seats: draft.seats.map(({ companionId, knowledge }) => ({ companionId, knowledge: !!knowledge })),
            minutes: draft.minutes
          });
          drafts.delete(run.id);
        } catch (error) {
          toast(error.message);
          start.disabled = false;
        }
      }
    });
    const cancel = el(
      'button',
      {
        type: 'button',
        class: 'room-text-action',
        title: tr('不开考，收起这个提议'),
        onclick: () =>
          Workflows.cancelExam(chatId, msg.id)
            .then(() => drafts.delete(run.id))
            .catch(error => toast(error.message))
      },
      [icon('cross'), el('span', { text: tr('取消') })]
    );

    card.append(
      el('div', { class: 'wf-card-head' }, [
        el('span', { class: 'wf-card-title' }, [
          el('strong', { text: run.title }),
          el('span', { class: 'wf-card-meta', text: [tr('对话模型的提议'), when(run.started)].join(' · ') })
        ]),
        el('span', { class: 'wf-status proposed', text: tr(RUN_LABEL.proposed) })
      ]),
      el('div', { class: 'wf-card-body' }, [
        el('p', {
          class: 'wf-plan-note',
          text: tr('考生只收到题目说明和试卷，看不到这个对话、长期记忆和彼此。核对后按「开考」。')
        }),
        facts(run),
        instruction(run, (exam.instruction || '').length < 600),
        seats,
        el('div', { class: 'wf-exam-controls' }, [
          add,
          el('label', {}, [el('span', { text: tr('每个考位限时') }), limit])
        ])
      ]),
      el('div', { class: 'wf-card-actions wf-exam-actions' }, [start, cancel])
    );
    return card;
  }

  // Under each seat of a started exam: its folder and the checks.
  function seatInfo(step) {
    if (!step.seat) return null;
    const audit = step.seat.audit;
    const checks = [];
    if (audit) {
      const changes = [
        audit.modified.length ? tr('修改：{files}', { files: audit.modified.join('、') }) : '',
        audit.deleted.length ? tr('删除：{files}', { files: audit.deleted.join('、') }) : ''
      ].filter(Boolean);
      checks.push(
        el('span', { class: 'wf-exam-check' + (audit.changed ? ' warn' : ''), title: changes.join('\n') || null }, [
          icon(audit.changed ? 'alert' : 'check'),
          el('span', { text: audit.changed ? tr('改动了 {count} 个试卷文件', { count: audit.changed }) : tr('试卷未改动') })
        ]),
        el(
          'span',
          {
            class: 'wf-exam-check' + (audit.stray?.count ? ' bad' : ''),
            title: (audit.stray?.samples || []).map(hit => `${hit.tool}: ${hit.text}`).join('\n') || null
          },
          [
            icon(audit.stray?.count ? 'alert' : 'check'),
            el('span', { text: audit.stray?.count ? tr('{count} 次越界', { count: audit.stray.count }) : tr('没有越界') })
          ]
        ),
        el('span', {
          class: 'wf-exam-check',
          title: (audit.addedSample || []).join('\n') || null,
          text: tr('新增 {count} 个文件', { count: audit.added })
        })
      );
    }
    return el('div', { class: 'wf-exam-seat-info' }, [
      pathButton(step.seat.dir, lastPart(step.seat.dir)),
      step.seat.knowledge ? el('span', { class: 'wf-badge', text: tr('开卷') }) : null,
      ...checks
    ]);
  }

  function examSummary(run, steps) {
    if (run.status === 'cancelled') return tr('提议已取消，没有考生作答');
    if (run.preparing) return tr('正在把试卷复制到考位…');
    const done = steps.filter(step => step.status === 'done').length;
    const unfinished = steps.filter(step => ['failed', 'stopped'].includes(step.status)).length;
    const flagged = steps.filter(step => step.seat?.audit?.changed || step.seat?.audit?.stray?.count).length;
    return [
      tr('{done}/{total} 个考位已交卷', { done, total: steps.length }),
      unfinished ? tr('{count} 个没有完成', { count: unfinished }) : '',
      flagged ? tr('{count} 个需要核对', { count: flagged }) : ''
    ]
      .filter(Boolean)
      .join(' · ');
  }

  Object.assign(Workflows, {
    renderExamProposal: renderProposal,
    examFacts: run => [facts(run), instruction(run, false)],
    seatInfo,
    examSummary
  });
})();

'use strict';

// Run cards: one card per workflow or @companion run in the conversation. Each step shows its
// companion's process inline (workflow-process.js). Part of StarportWorkflows (workflows.js).
(() => {
  const Workflows = globalThis.StarportWorkflows;
  const { el, icon, avatar, textAction, PROVIDER_LABELS } = globalThis.StarportUI;
  const {
    tr,
    notice,
    page,
    renderMarkdown,
    RUN_LABEL,
    companion,
    mount,
    when,
    duration,
    oneLine,
    splitDuty,
    stopRun,
    startReply,
    liveSince
  } = Workflows;
  const STEP_LABEL = { waiting: '等待', running: '工作中', done: '完成', failed: '失败', stopped: '已停止' };
  const TRIGGER_LABEL = { schedule: '定时', catchup: '补跑', manual: '手动', dispatch: '点名', call: '调用' };
  const LIVE = ['planning', 'running'];
  // A step waiting for its companion to finish an earlier request at the same desk.
  const queued = step => step.status === 'running' && !!step.queued;
  const stepLabel = step => (queued(step) ? '排队中' : STEP_LABEL[step.status] || step.status);
  // Meta parts joined by dots; a part may be a live clock rather than text.
  const metaParts = parts => parts.filter(Boolean).flatMap((part, i) => (i ? [' · ', part] : [part]));

  const expanded = new Map();
  const fullSteps = new Set();

  // One seat that did not finish does not fail an exam; the others still handed in.
  function failedRun(run) {
    if (['failed', 'verify-failed'].includes(run.status)) return true;
    return run.kind !== 'exam' && (run.steps || []).some(s => s.status === 'failed');
  }

  // Exams limit each seat; workflows limit each step.
  function limitText(run, minutes) {
    if (run.kind === 'exam') return minutes ? tr('限时 {minutes} 分钟', { minutes }) : tr('不限时');
    return minutes ? tr('单步限时 {minutes} 分钟', { minutes }) : tr('不限总时长');
  }

  function cardHeader(msg) {
    const run = msg.details.workflowRun;
    const kind =
      run.kind === 'adhoc' || run.kind === 'call'
        ? ['at', run.kind === 'call' ? '调用' : '伙伴']
        : run.kind === 'exam'
          ? ['exam', '考场']
          : ['flow', '工作流'];
    return el('div', { class: 'message-header' }, [
      el('span', { class: 'provider-mark wf-mark' }, [icon(kind[0])]),
      el('strong', { text: kind[1] }),
      el('time', {
        text: new Date(msg.created).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      })
    ]);
  }

  // Latest attempt of each step, in order: what the collapsed card shows.
  function latestSteps(run) {
    const latest = new Map();
    for (const step of run.steps || []) latest.set(step.key, step);
    return [...latest.values()];
  }

  function stepMark(step) {
    if (step.status === 'running') return el('i', { class: queued(step) ? 'wf-dot' : 'wf-dot running' });
    if (step.status === 'waiting') return el('i', { class: 'wf-dot' });
    if (step.status === 'failed' || step.verdict === 'fail') return icon('cross', 'wf-mark-icon bad');
    if (step.status === 'stopped') return el('i', { class: 'wf-dot stopped' });
    if (step.verdict === 'unclear') return icon('alert', 'wf-mark-icon warn');
    return icon('check', 'wf-mark-icon good');
  }

  function verdictBadge(step) {
    if (!step.verify) return null;
    if (step.verdict === 'pass') return el('span', { class: 'wf-badge good', text: '验收通过' });
    if (step.verdict === 'fail') return el('span', { class: 'wf-badge bad', text: '验收不通过' });
    if (step.verdict === 'unclear') return el('span', { class: 'wf-badge warn', text: '没有给出验收结论' });
    return el('span', { class: 'wf-badge', text: '验收位' });
  }

  function summaryLine(run) {
    if (run.status === 'planning') return '正在排执行顺序…';
    const steps = latestSteps(run);
    if (run.kind === 'exam') return Workflows.examSummary(run, steps);
    const failed = steps.find(s => s.status === 'failed');
    if (failed) return `${failed.companionName}：${failed.error || '没有完成'}`;
    const rejected = steps.findLast(s => s.verdict === 'fail');
    if (rejected)
      return `${rejected.companionName}：${oneLine(splitDuty(rejected.output).body.split('\n').filter(Boolean).at(-1), 140)}`;
    const running = steps.filter(s => s.status === 'running');
    const working = running.filter(s => !queued(s));
    if (working.length) return `${working.map(s => s.companionName).join('、')} 工作中…`;
    if (running.length) return `${running.map(s => s.companionName).join('、')} 排队中，做完手上的事就开始`;
    if (run.status === 'stopped') return run.notes?.at(-1) || '已停止';
    // The conversation model's answer sits right below the card; the line names a companion's.
    const last = steps.findLast(s => s.output && s.companionId !== Workflows.MAIN.id);
    if (last) return `${last.companionName}：${oneLine(splitDuty(last.output).body, 140)}`;
    return steps.some(s => s.output) ? '主模型已在对话里回答' : run.notes?.at(-1) || '';
  }

  function planNote(run) {
    const plan = run.plan;
    if (!plan || plan.source === 'workflow' || plan.source === 'direct') return null;
    const name = p => `${PROVIDER_LABELS[p.provider] || p.provider}${p.model ? ' · ' + p.model : ''}`;
    const text =
      plan.source === 'planner' ? `执行顺序由 ${name(plan.planner)} 排出` : '排程模型都没有排成，按原话的先后排了顺序';
    const failures = (plan.attempts || []).map((a, i) => `${['一', '二', '三'][i] || i + 1}选 ${name(a)}：${a.error}`);
    return el('p', { class: 'wf-plan-note', title: failures.join('\n') || null }, [
      text,
      failures.length ? el('span', { class: 'wf-plan-fallback', text: ` · ${failures.length} 个排程模型没接通` }) : null
    ]);
  }

  function planTable(run) {
    const rows = run.plan?.rows || [];
    if (rows.length < 2) return null;
    return el(
      'ol',
      { class: 'wf-plan' },
      rows.map(row => {
        const c = row.companionId === Workflows.MAIN.id ? Workflows.MAIN : companion(row.companionId);
        return el('li', {}, [
          el('span', { class: 'wf-plan-order', text: String(row.order) }),
          el('span', { class: 'wf-plan-who' }, [
            avatar(c || { avatar: '·' }, 'wf-mini-avatar'),
            el('span', { text: row.companionName || c?.name || '伙伴' })
          ]),
          el('span', { class: 'wf-plan-task', text: (row.label ? row.label + ' · ' : '') + oneLine(row.task, 200) }),
          row.verify ? el('span', { class: 'wf-badge', text: '验收' }) : null
        ]);
      })
    );
  }

  function ledgerChanges(step) {
    const l = step.ledger;
    if (!l) return null;
    const parts = [
      l.added?.length ? `新增命题 ${l.added.join('、')}` : '',
      ...(l.status || []),
      l.verifiers?.length ? `新检查项 ${l.verifiers.join('、')}` : '',
      l.proposal ? 'PLAN 修改提议待你确认' : '',
      l.log ? '写了 CHANGELOG' : ''
    ].filter(Boolean);
    if (!parts.length && !l.rejected?.length) return null;
    return el('p', { class: 'wf-step-ledger' }, [
      icon('ledger'),
      el('span', { text: parts.join(' · ') || '没有台账变更' }),
      l.rejected?.length
        ? el('span', {
            class: 'wf-step-rejected',
            title: l.rejected.join('\n'),
            text: ` · ${l.rejected.length} 条被拒绝`
          })
        : null
    ]);
  }

  function renderStep(run, step, index) {
    // The conversation model answers its part in the conversation; the card only points there.
    const main = step.companionId === Workflows.MAIN.id;
    const { duty, body } = main ? { duty: '', body: '' } : splitDuty(step.output);
    const key = run.id + ':' + index;
    const long = body.length > 900;
    const showAll = fullSteps.has(key);
    const meta = [
      step.label && step.label !== step.companionName ? step.label : '',
      step.attempt ? `第 ${step.attempt + 1} 次` : '',
      step.status === 'running' && step.started && !queued(step) ? liveSince(step.started, '已 ') : '',
      typeof step.timeLimitMinutes === 'number' ? limitText(run, step.timeLimitMinutes) : '',
      step.checkpoint ? tr('进度已保留') : '',
      step.ended && step.started && step.status !== 'running' ? duration(step.started, step.ended) : ''
    ];
    const output = body.trim()
      ? (() => {
          const node = renderMarkdown(body);
          node.classList.add('wf-step-output');
          if (long && !showAll) node.classList.add('clamped');
          return node;
        })()
      : null;
    return el('section', { class: `wf-step ${step.status}${step.verdict ? ' verdict-' + step.verdict : ''}` }, [
      el('header', { class: 'wf-step-head' }, [
        avatar(companion(step.companionId) || step, 'room-avatar wf-step-avatar'),
        el('span', { class: 'wf-step-who' }, [
          el('strong', { text: step.companionName }),
          meta.some(Boolean) ? el('span', { class: 'wf-step-meta' }, metaParts(meta)) : null
        ]),
        el('span', { class: 'wf-step-side' }, [
          verdictBadge(step),
          step.verify && step.verdict
            ? null
            : el('span', {
                class: `wf-step-status ${queued(step) ? 'queued' : step.status}`,
                'aria-live': 'polite',
                text: step.status === 'running' && step.runtime?.stalled ? tr('未收到新活动') : stepLabel(step)
              }),
        ])
      ]),
      run.kind === 'exam' ? Workflows.seatInfo(step) : null,
      duty
        ? el('p', { class: 'wf-step-duty', text: `我负责：${duty}` })
        : main || (!output && step.status === 'waiting')
          ? el('p', { class: 'wf-step-duty', text: oneLine(step.task, 200) })
          : null,
      main ? null : Workflows.processBlock?.(step),
      main && step.mainMessageId
        ? textAction(step.status === 'running' ? '看它正在回答' : '看它的回答', () =>
            Workflows.scrollToMessage(step.mainMessageId)
          )
        : output,
      long
        ? textAction(showAll ? '收起' : '展开全文', () => {
            if (showAll) fullSteps.delete(key);
            else fullSteps.add(key);
            renderMessages();
          })
        : null,
      step.error ? el('p', { class: 'wf-step-error', text: notice(step.error) }) : null,
      step.notes?.length
        ? el(
            'ul',
            { class: 'wf-step-notes' },
            step.notes.slice(-6).map(note => el('li', { text: notice(note) }))
          )
        : null,
      ledgerChanges(step)
    ]);
  }

  function renderCard(msg) {
    const run = msg.details.workflowRun;
    if (run.kind === 'exam' && run.status === 'proposed') return Workflows.renderExamProposal(msg);
    const exam = run.kind === 'exam';
    const live = LIVE.includes(run.status);
    // Nothing at work yet: every live step is waiting for its companion's earlier request.
    const waiting =
      live && (run.steps || []).some(queued) && !(run.steps || []).some(s => s.status === 'running' && !queued(s));
    const failed = failedRun(run);
    const open = expanded.has(run.id) ? expanded.get(run.id) : live || failed;
    const card = el('div', {
      class: `wf-card ${run.status}${failed ? ' failed-run' : ''}${open ? ' open' : ''}`,
      'data-run-id': run.id
    });

    const meta = [
      TRIGGER_LABEL[run.trigger] || '',
      run.isolated ? tr('单向可见') : '',
      when(run.started),
      typeof run.timeLimitMinutes === 'number' ? limitText(run, run.timeLimitMinutes) : '',
      run.ended ? `用时 ${duration(run.started, run.ended)}` : live ? liveSince(run.started, waiting ? '已等 ' : '已 ') : ''
    ];
    const head = el('button', { type: 'button', class: 'wf-card-head', 'aria-expanded': String(open) }, [
      el('span', { class: 'wf-card-title' }, [
        el('strong', { text: run.title }),
        el('span', { class: 'wf-card-meta' }, metaParts(meta))
      ]),
      el('span', { class: `wf-status ${waiting ? 'queued' : run.status}` }, [
        live ? el('i', { class: waiting ? 'wf-dot' : 'wf-dot running' }) : null,
        waiting ? '排队中' : RUN_LABEL[run.status] || run.status
      ]),
      icon('chevron', 'wf-chevron')
    ]);

    const strip = el('div', { class: 'wf-card-strip' }, [
      el(
        'span',
        { class: 'wf-card-steps' },
        latestSteps(run).map(step =>
          el(
            'span',
            {
              class: `wf-chip ${step.status}${queued(step) ? ' queued' : ''}`,
              title: `${step.companionName}${step.label ? ' · ' + step.label : ''} · ${stepLabel(step)}`
            },
            [el('span', { class: 'wf-chip-avatar', text: step.avatar || '·' }), stepMark(step)]
          )
        )
      ),
      el('span', { class: 'wf-card-summary', text: summaryLine(run) })
    ]);

    const steps = run.steps || [];
    const body = el('div', { class: 'wf-card-body', hidden: !open }, [
      ...(exam ? Workflows.examFacts(run) : [planNote(run), planTable(run)]),
      run.status === 'planning' && !steps.length ? el('p', { class: 'wf-plan-note', text: '正在排执行顺序…' }) : null,
      ...steps.map((step, index) => renderStep(run, step, index)),
      run.notes?.length
        ? el(
            'ul',
            { class: 'wf-card-notes' },
            run.notes.map(note => el('li', { text: notice(note) }))
          )
        : null
    ]);

    head.onclick = () => {
      const next = !card.classList.contains('open');
      expanded.set(run.id, next);
      card.classList.toggle('open', next);
      head.setAttribute('aria-expanded', String(next));
      body.hidden = !next;
    };

    const target = run.mountId ? mount(run.mountId) : null;
    const actions = el('div', { class: 'wf-card-actions' }, [
      live
        ? el(
            'button',
            { type: 'button', class: 'room-text-action', onclick: () => stopRun(run.id).catch(e => toast(e.message)) },
            [icon('stop'), el('span', { text: '停止' })]
          )
        : run.status === 'cancelled'
          ? null
          : el(
            'button',
            {
              type: 'button',
              class: 'room-text-action',
              title: '回复这次运行：结果会随你的下一条消息发给对话模型',
              onclick: () => startReply(msg)
            },
            [icon('reply'), el('span', { text: '回复' })]
          ),
      !live && run.kind === 'adhoc' && run.plan?.rows?.length
        ? el(
            'button',
            {
              type: 'button',
              class: 'room-text-action',
              title: '把这次的分工保存成可复用的工作流',
              onclick: () => Workflows.saveRunAsWorkflow(msg)
            },
            [icon('save'), el('span', { text: '保存为工作流' })]
          )
        : null,
      run.ledger && target
        ? el('button', { type: 'button', class: 'room-text-action', onclick: () => Workflows.openLedger(target.id) }, [
            icon('ledger'),
            el('span', { text: '台账' })
          ])
        : null
    ]);

    card.append(head, strip, body, actions);
    return card;
  }

  // What a card draws besides its own message: its companions' names and avatars, whether its
  // folder still exists, and which long outputs are open. The conversation rebuilds a card only
  // when this or the message changes, so one companion's progress does not redraw every card.
  function cardContext(msg) {
    const run = msg.details.workflowRun;
    const ids = new Set([...(run.steps || []), ...(run.plan?.rows || [])].map(item => item.companionId));
    const people = [...ids].map(id => {
      const c = companion(id);
      return c ? [id, c.name, c.avatar] : id;
    });
    const open = [...fullSteps].filter(key => key.startsWith(run.id + ':'));
    return JSON.stringify([people, run.mountId ? !!mount(run.mountId) : 0, open]);
  }

  Object.assign(Workflows, { renderCard, cardHeader, cardContext, planTable });
})();

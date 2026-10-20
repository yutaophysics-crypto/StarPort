'use strict';

// The ledger of a mounted workflow: PLAN and proposed changes, claims, CHANGELOG and checks.
// Part of StarportWorkflows (workflows.js).
(() => {
  const Workflows = globalThis.StarportWorkflows;
  const { el, icon, avatar, showDialog, closeDialog, segmented } = globalThis.StarportUI;
  const { call, renderMarkdown, companion, workflow, mount, chatById, when } = Workflows;
  const CLAIM_LABEL = { open: '未决', verified: '成立', refuted: '不成立', dropped: '已放弃' };

  // --- the ledger ------------------------------------------------------------------------------
  async function openLedger(mountId, tab = 'plan') {
    const target = mount(mountId);
    const wf = workflow(target?.workflowId);
    let view;
    try {
      view = await api('/mounts/' + mountId + '/ledger');
    } catch (error) {
      toast(error.message);
      return;
    }
    const reopen = next => openLedger(mountId, next);
    const pending = (view.proposals || []).filter(p => p.status === 'pending');
    const claims = view.claims?.claims || [];
    const panel = el('div', { class: 'wf-ledger-panel' });

    async function edit(body, message) {
      await call('/mounts/' + mountId + '/ledger', 'PATCH', body);
      toast(message);
    }

    function drawPlan() {
      const plan = el('textarea', { rows: '16', class: 'wf-mono' });
      plan.value = view.plan;
      const save = el('button', { type: 'button', class: 'secondary-button', text: '保存 PLAN', disabled: true });
      plan.oninput = () => {
        save.disabled = plan.value === view.plan || !plan.value.trim();
      };
      save.onclick = async () => {
        save.disabled = true;
        try {
          await edit({ plan: plan.value }, '已保存 PLAN，并提交了一次 git');
          reopen('plan');
        } catch (error) {
          toast(error.message);
          save.disabled = false;
        }
      };
      panel.replaceChildren(
        ...pending.map(p => {
          const proposed = el('textarea', { rows: '10', class: 'wf-mono' });
          proposed.value = p.plan || view.plan;
          const by = companion(p.by);
          return el('section', { class: 'wf-proposal' }, [
            el('header', {}, [
              avatar(by, 'wf-mini-avatar'),
              el('strong', { text: `${by?.name || p.by} 提议修改 PLAN` }),
              el('time', { text: when(p.created) })
            ]),
            el('p', { class: 'wf-proposal-summary', text: p.summary }),
            p.plan
              ? el('details', {}, [el('summary', { text: '看提议的新 PLAN（可以先改再接受）' }), proposed])
              : el('p', { class: 'room-field-hint', text: '只给了理由，没有给完整的新 PLAN；接受前请在下面自己改。' }),
            el('div', { class: 'wf-inline' }, [
              p.plan
                ? el('button', {
                    type: 'button',
                    class: 'primary-button',
                    text: '接受',
                    onclick: async () => {
                      try {
                        await edit(
                          { proposal: { id: p.id, action: 'accept', plan: proposed.value } },
                          '已接受，PLAN 已更新'
                        );
                        reopen('plan');
                      } catch (error) {
                        toast(error.message);
                      }
                    }
                  })
                : null,
              el('button', {
                type: 'button',
                class: 'secondary-button',
                text: '拒绝',
                onclick: async () => {
                  try {
                    await edit({ proposal: { id: p.id, action: 'reject' } }, '已拒绝这条提议');
                    reopen('plan');
                  } catch (error) {
                    toast(error.message);
                  }
                }
              })
            ])
          ]);
        }),
        view.exists
          ? ''
          : el('p', {
              class: 'room-dialog-note',
              text: '台账还没有建立。第一次运行时会按模板生成；也可以现在就写好 PLAN。'
            }),
        plan,
        el('div', { class: 'wf-inline' }, [
          save,
          el('span', { class: 'room-field-hint', text: 'PLAN 只有你能改；伙伴只能提议。' })
        ])
      );
    }

    function drawClaims() {
      if (!claims.length) {
        panel.replaceChildren(
          el('p', {
            class: 'room-dialog-note',
            text: '还没有命题。伙伴在运行中提出的可检验判断、预测会记在这里；你和其他伙伴来判定。'
          })
        );
        return;
      }
      const scoreLine = companionId => {
        const score = Workflows.data?.scores?.[companionId];
        return score ? ` · 预测 Brier ${score.brier}（${score.n} 条）` : '';
      };
      panel.replaceChildren(
        el(
          'ul',
          { class: 'wf-claims' },
          [...claims].reverse().map(claim => {
            const by = companion(claim.by);
            const status = el(
              'select',
              { 'aria-label': `${claim.id} 的判定` },
              Object.entries(CLAIM_LABEL).map(([value, label]) => el('option', { value, text: label }))
            );
            status.value = claim.status;
            const noteInput = el('input', { type: 'text', placeholder: '依据（可选）', maxlength: '1000' });
            const apply = el('button', { type: 'button', class: 'secondary-button', text: '判定', disabled: true });
            status.onchange = () => {
              apply.disabled = status.value === claim.status;
            };
            apply.onclick = async () => {
              apply.disabled = true;
              try {
                await edit(
                  { claim: { id: claim.id, status: status.value, note: noteInput.value.trim() } },
                  `${claim.id} → ${CLAIM_LABEL[status.value]}`
                );
                reopen('claims');
              } catch (error) {
                toast(error.message);
                apply.disabled = false;
              }
            };
            const p = claim.prediction;
            return el('li', { class: `wf-claim ${claim.status}` }, [
              el('div', { class: 'wf-claim-head' }, [
                el('span', { class: 'wf-claim-id', text: claim.id }),
                el('span', {
                  class: `wf-badge ${claim.status === 'verified' ? 'good' : claim.status === 'refuted' ? 'bad' : ''}`,
                  text: CLAIM_LABEL[claim.status] || claim.status
                }),
                el('span', {
                  class: 'wf-claim-by',
                  text: `${by?.name || claim.by} · ${when(claim.created)}${claim.depends?.length ? ' · 依赖 ' + claim.depends.join('、') : ''}${scoreLine(claim.by)}`
                })
              ]),
              el('p', { class: 'wf-claim-text', text: claim.text }),
              p
                ? el('p', {
                    class: 'wf-claim-prediction',
                    text: `预测 p = ${p.probability} · 截止 ${p.deadline} · 判据：${p.criterion}`
                  })
                : null,
              claim.history?.length
                ? el('p', {
                    class: 'room-field-hint',
                    text: claim.history
                      .map(
                        h =>
                          `${CLAIM_LABEL[h.to] || h.to}（${h.by === 'user' ? '你' : companion(h.by)?.name || h.by}${h.note ? '：' + h.note : ''}）`
                      )
                      .join(' → ')
                  })
                : null,
              el('div', { class: 'wf-inline wf-claim-rule' }, [status, noteInput, apply])
            ]);
          })
        )
      );
    }

    function drawChangelog() {
      const plain = text => el('pre', { class: 'wf-mono', text });
      panel.replaceChildren(
        view.changelog.trim()
          ? renderMarkdown(view.changelog, plain)
          : el('p', { class: 'room-dialog-note', text: '还没有记录。' })
      );
    }

    function drawVerifiers() {
      panel.replaceChildren(
        view.verifiers.length
          ? el(
              'ol',
              { class: 'wf-verifiers' },
              view.verifiers.map(v =>
                el('li', {}, [
                  el('strong', { text: v.name }),
                  el('span', { text: v.how }),
                  el('small', { text: `${companion(v.by)?.name || v.by || ''} · ${when(v.added)}` })
                ])
              )
            )
          : el('p', { class: 'room-dialog-note', text: '还没有检查项。伙伴发现值得每次开工前都检查的东西时会加进来。' })
      );
    }

    const draw = { plan: drawPlan, claims: drawClaims, changelog: drawChangelog, verifiers: drawVerifiers };
    const open = claims.filter(c => c.status === 'open').length;
    const tabs = segmented(
      [
        { value: 'plan', label: pending.length ? `PLAN · ${pending.length} 条提议` : 'PLAN' },
        { value: 'claims', label: claims.length ? `命题 ${open}/${claims.length}` : '命题' },
        { value: 'changelog', label: 'CHANGELOG' },
        { value: 'verifiers', label: view.verifiers.length ? `检查项 ${view.verifiers.length}` : '检查项' }
      ],
      tab,
      next => draw[next](),
      '台账内容'
    );
    (draw[tab] || drawPlan)();

    showDialog({
      size: 'wide ledger',
      eyebrow: `${wf?.name || '工作流'} · ${view.project ? `项目「${view.project.name}」` : chatById(view.chatId)?.title || ''}`,
      title: '台账',
      body: [
        view.project
          ? el('p', {
              class: 'room-field-hint wf-ledger-shared',
              text: view.sharedWith?.length
                ? `项目里挂了这个工作流的对话共用这份台账：${[chatById(view.chatId)?.title, ...view.sharedWith.map(m => m.title)].filter(Boolean).join('、')}`
                : '项目里挂了这个工作流的对话会共用这份台账。'
            })
          : null,
        tabs,
        panel
      ].filter(Boolean),
      footer: [
        el('span', { class: 'wf-ledger-path', title: view.path, text: view.path }),
        el(
          'button',
          {
            type: 'button',
            class: 'secondary-button',
            disabled: !view.exists,
            onclick: () => api('/folders/open', 'POST', { path: view.path }).catch(e => toast(e.message))
          },
          [icon('folder'), el('span', { text: '打开文件夹' })]
        ),
        el('button', { type: 'button', class: 'primary-button', text: '完成', onclick: closeDialog })
      ]
    });
  }

  Object.assign(Workflows, { openLedger });
})();

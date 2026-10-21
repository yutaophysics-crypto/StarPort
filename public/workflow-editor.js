'use strict';

// The workflow library and editor, the workflow settings, and saving an @companion run as a
// workflow. Part of StarportWorkflows (workflows.js).
(() => {
  const Workflows = globalThis.StarportWorkflows;
  const { el, iconButton, textAction, field, showDialog, closeDialog, confirmDialog, modelPicker } =
    globalThis.StarportUI;
  const { tr, call, workflows, chatById, positionsOf, oneLine, planTable } = Workflows;

  // --- saving an ad-hoc plan as a workflow ---------------------------------------------------
  function saveRunAsWorkflow(msg) {
    const run = msg.details.workflowRun;
    const chatId = msg.chat_id || state.chat?.id;
    const name = el('input', { type: 'text', value: run.title.replace(/^点名\s*/, '') + ' · 分工', maxlength: '80' });
    showDialog({
      eyebrow: '保存为工作流',
      title: run.title,
      focus: name,
      body: [
        el('p', {
          class: 'room-dialog-note',
          text: '执行顺序里的每一行会变成一个位置：同一步并行，后一步看得到前一步的产出。现在坐着的伙伴会作为默认人选。'
        }),
        planTable(run),
        field('工作流名称', name)
      ],
      footer: [
        el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: closeDialog }),
        el('button', { type: 'submit', class: 'primary-button', text: '保存' })
      ],
      onsubmit: async () => {
        if (!name.value.trim()) {
          name.focus();
          throw new Error('请填写工作流名称');
        }
        const result = await call('/chats/' + chatId + '/runs/' + msg.id + '/save-workflow', 'POST', {
          name: name.value.trim()
        });
        toast(`已保存工作流「${result.workflow.name}」`);
        Workflows.openMount({
          chatId,
          draft: { workflowId: result.workflow.id, assignments: result.assignments },
          note: '已保存到工作流库。要挂到这个对话上，以后一键或定时运行吗？'
        });
      }
    });
  }

  // --- workflow editor -----------------------------------------------------------------------
  function openEditor(existing = null, { onDone = null } = {}) {
    const done = saved => (onDone ? onDone(saved) : saved ? openLibrary() : closeDialog());
    const draft = existing
      ? JSON.parse(JSON.stringify(existing))
      : {
          name: '',
          description: '',
          acceptance: '',
          ledger: false,
          retries: 0,
          planTemplate: '',
          stages: [{ name: '', positions: [{ name: '', task: '', verify: false }] }]
        };
    const defaultTemplate = Workflows.data?.defaults?.planTemplate || '';

    const name = el('input', {
      type: 'text',
      value: draft.name,
      maxlength: '80',
      placeholder: '例如：每日收盘复盘、论文周报'
    });
    const description = el('textarea', { rows: '2', placeholder: '这个工作流要达成什么。每个位置的伙伴都会看到。' });
    description.value = draft.description || '';
    const acceptance = el('textarea', { rows: '2', placeholder: '怎样算做好了。验收位会逐条对照检查。' });
    acceptance.value = draft.acceptance || '';
    const retries = el(
      'select',
      {},
      [0, 1, 2, 3].map(n => el('option', { value: String(n), text: n ? `重做 ${n} 次` : '不重做' }))
    );
    retries.value = String(draft.retries || 0);
    const ledger = el('input', { type: 'checkbox', checked: !!draft.ledger });
    const template = el('textarea', { rows: '12', class: 'wf-mono' });
    template.value = draft.planTemplate || defaultTemplate;
    const templateBox = el('details', { class: 'wf-template', hidden: !draft.ledger }, [
      el('summary', { text: 'PLAN 模板（第一次运行时生成 PLAN.md）' }),
      template,
      el('span', { class: 'room-field-hint', text: '{name}、{description}、{acceptance} 会换成上面填的内容。' })
    ]);
    ledger.onchange = () => {
      templateBox.hidden = !ledger.checked;
    };

    const stagesBox = el('div', { class: 'wf-stages' });

    function move(list, from, to) {
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      drawStages();
    }

    function drawStages(focusLast = null) {
      stagesBox.replaceChildren(
        ...draft.stages.map((stage, si) => {
          const stageName = el('input', {
            type: 'text',
            value: stage.name,
            maxlength: '60',
            placeholder: `第 ${si + 1} 阶段`,
            'aria-label': `第 ${si + 1} 阶段名称`
          });
          stageName.oninput = () => {
            stage.name = stageName.value;
          };
          const positions = stage.positions.map((position, pi) => {
            const positionName = el('input', {
              type: 'text',
              value: position.name,
              maxlength: '60',
              placeholder: '位置名称，例如：信息扫描',
              'aria-label': '位置名称'
            });
            positionName.oninput = () => {
              position.name = positionName.value;
            };
            const task = el('textarea', {
              rows: '3',
              placeholder: '这个位置每次要做的事。坐在这里的伙伴只做这一部分。',
              'aria-label': '任务'
            });
            task.value = position.task;
            task.oninput = () => {
              position.task = task.value;
            };
            const verify = el('input', { type: 'checkbox', checked: !!position.verify });
            verify.onchange = () => {
              position.verify = verify.checked;
            };
            if (focusLast === `${si}:${pi}`) setTimeout(() => positionName.focus());
            return el('div', { class: 'wf-position' }, [
              el('div', { class: 'wf-position-head' }, [
                positionName,
                el(
                  'label',
                  {
                    class: 'room-check wf-verify',
                    title: '验收位：对照验收标准检查上游产出，最后一行写「验收：通过」或「验收：不通过——原因」'
                  },
                  [verify, el('span', { text: '验收位' })]
                ),
                stage.positions.length > 1
                  ? iconButton('cross', '删除这个位置', () => {
                      stage.positions.splice(pi, 1);
                      drawStages();
                    })
                  : null
              ]),
              task
            ]);
          });
          return el('section', { class: 'wf-stage' }, [
            el('header', { class: 'wf-stage-head' }, [
              el('span', { class: 'wf-stage-index', text: String(si + 1) }),
              stageName,
              si > 0 ? iconButton('up', '上移这一阶段', () => move(draft.stages, si, si - 1)) : null,
              si < draft.stages.length - 1
                ? iconButton('down', '下移这一阶段', () => move(draft.stages, si, si + 1))
                : null,
              draft.stages.length > 1
                ? iconButton('trash', '删除这一阶段', () => {
                    draft.stages.splice(si, 1);
                    drawStages();
                  })
                : null
            ]),
            ...positions,
            stage.positions.length < 8
              ? textAction('＋ 同一阶段再加一个位置（并行）', () => {
                  stage.positions.push({ name: '', task: '', verify: false });
                  drawStages(`${si}:${stage.positions.length - 1}`);
                })
              : null
          ]);
        }),
        draft.stages.length < 12
          ? el('button', {
              type: 'button',
              class: 'secondary-button wf-add-stage',
              text: '＋ 下一阶段',
              onclick: () => {
                draft.stages.push({ name: '', positions: [{ name: '', task: '', verify: false }] });
                drawStages(`${draft.stages.length - 1}:0`);
              }
            })
          : null
      );
    }
    drawStages();

    const mountedIn = existing ? (Workflows.data?.mounts || []).filter(m => m.workflowId === existing.id) : [];
    const remove = existing
      ? el('button', {
          type: 'button',
          class: 'secondary-button wf-footer-left',
          text: '删除',
          onclick: () =>
            confirmDialog({
              eyebrow: existing.name,
              title: '删除工作流？',
              text: mountedIn.length
                ? `它挂在 ${mountedIn.length} 个对话上，会一并卸下。已经产生的运行记录和台账文件保留。`
                : '已经产生的运行记录保留。',
              confirm: '删除工作流',
              danger: true,
              back: () => openEditor(existing, { onDone }),
              action: async () => {
                await call('/workflows/' + existing.id, 'DELETE');
                toast(`已删除工作流「${existing.name}」`);
                done(null);
              }
            })
        })
      : null;

    showDialog({
      size: 'wide',
      eyebrow: existing ? '编辑工作流' : '新工作流',
      title: existing ? existing.name : '新建工作流',
      focus: existing ? null : name,
      body: [
        field('名称', name),
        field('目标', description),
        field('验收标准', acceptance, '验收位按它判断「通过 / 不通过」。'),
        el('div', { class: 'room-field' }, [
          el('span', { class: 'room-field-label', text: '阶段与位置' }),
          el('span', {
            class: 'room-field-hint',
            text: '阶段依次进行，后一阶段看得到前面的产出；同一阶段的位置同时进行。坐在哪个位置的伙伴，在挂到对话上时再选。'
          }),
          stagesBox
        ]),
        field('验收不通过时', retries, '从验收位之前的那一阶段重做，带上验收意见。'),
        el('label', { class: 'room-check' }, [
          ledger,
          el('span', {}, [
            el('span', { text: '使用台账' }),
            el('span', {
              class: 'room-field-hint wf-check-hint',
              text: '每次运行都是新开始，靠台账接上：PLAN、命题（只增不改，不能自己判定自己的）、只追加的 CHANGELOG、每次开工先跑的检查项，每次运行后提交一次 git。不开时，只带上一次的结论。台账存在工作文件夹里，同一项目里挂这个工作流的对话共用一份。'
            })
          ])
        ]),
        templateBox
      ],
      footer: [
        remove,
        el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: () => done(undefined) }),
        el('button', { type: 'submit', class: 'primary-button', text: existing ? '保存' : '创建' })
      ],
      onsubmit: async () => {
        if (!name.value.trim()) {
          name.focus();
          throw new Error('请填写工作流名称');
        }
        const empty = draft.stages.flatMap(s => s.positions).find(p => !p.task.trim());
        if (empty) throw new Error(`「${empty.name || '未命名位置'}」还没有写任务`);
        const payload = {
          name: name.value.trim(),
          description: description.value.trim(),
          acceptance: acceptance.value.trim(),
          retries: Number(retries.value),
          ledger: ledger.checked,
          planTemplate: template.value.trim() === defaultTemplate.trim() ? '' : template.value,
          stages: draft.stages.map(stage => ({
            ...(stage.id ? { id: stage.id } : {}),
            name: stage.name.trim(),
            positions: stage.positions.map(p => ({
              ...(p.id ? { id: p.id } : {}),
              name: p.name.trim(),
              task: p.task.trim(),
              verify: !!p.verify
            }))
          }))
        };
        const saved = existing
          ? await call('/workflows/' + existing.id, 'PATCH', payload)
          : await call('/workflows', 'POST', payload);
        toast(existing ? `已保存「${saved.name}」` : `已创建工作流「${saved.name}」`);
        done(saved);
      }
    });
  }
  // --- settings: the planner chain and the limits -----------------------------------------
  function openSettings() {
    const settings = Workflows.data?.settings;
    // New static files can be served while the busy backend is still waiting to reload.
    if (!settings || typeof settings.stepLimitEnabled !== 'boolean') {
      showDialog({
        title: tr('工作流设置'),
        eyebrow: tr('等待更新'),
        body: [
          el('p', {
            class: 'room-dialog-note',
            role: 'status',
            text: tr('不限时更新尚未加载。当前任务结束后会自动更新；更新前仍沿用旧规则，不会为了更新中断任务。')
          })
        ],
        footer: [el('button', { type: 'button', class: 'primary-button', text: tr('关闭'), onclick: closeDialog })]
      });
      return;
    }
    let rows = [0, 1, 2].map(i => settings.planners[i] || { provider: '', model: '', effort: '' });
    const box = el('div', { class: 'wf-planners' });
    let pickers = [];
    const drawRows = () => {
      pickers = rows.map(row => modelPicker(row, { allowNone: true }));
      box.replaceChildren(
        ...pickers.map((picker, i) =>
          el('div', { class: 'wf-planner' }, [
            el('span', { class: 'wf-planner-rank', text: ['第一选', '第二选', '第三选'][i] }),
            picker.provider,
            picker.model,
            picker.effort
          ])
        )
      );
    };
    drawRows();
    const retries = el(
      'select',
      {},
      [0, 1, 2, 3].map(n => el('option', { value: String(n), text: n ? `重做 ${n} 次` : '不重做' }))
    );
    retries.value = String(settings.verifyRetries ?? 0);
    const minutes = el('input', {
      type: 'number',
      min: '3',
      max: '240',
      step: '1',
      value: String(settings.stepMinutes ?? 30)
    });
    const limitEnabled = el('input', {
      type: 'checkbox',
      checked: settings.stepLimitEnabled,
      'aria-label': tr('启用单步时限')
    });
    const syncLimit = () => {
      minutes.disabled = !limitEnabled.checked;
      minutes.required = limitEnabled.checked;
      minutes.setAttribute('aria-disabled', String(!limitEnabled.checked));
    };
    limitEnabled.onchange = syncLimit;
    syncLimit();

    showDialog({
      size: 'wide',
      eyebrow: '工作流',
      title: '工作流设置',
      body: [
        el('div', { class: 'room-field' }, [
          el('div', { class: 'room-field-head' }, [
            el('span', { class: 'room-field-label', text: '排执行顺序的模型' }),
            textAction('恢复默认', () => {
              rows = (Workflows.data?.defaults?.planners || []).map(p => ({ ...p }));
              while (rows.length < 3) rows.push({ provider: '', model: '', effort: '' });
              drawRows();
            })
          ]),
          el('span', {
            class: 'room-field-hint',
            text: '一次点名好几位伙伴时，先由它把原话排成执行顺序表。一选接不通就用二选，再不通用三选；都不通时按原话里的先后排。'
          }),
          box
        ]),
        el('div', { class: 'room-field-grid' }, [
          field('点名时验收不通过', retries, '工作流有自己的设置，这里只管临时点名。'),
          el('div', { class: 'room-field' }, [
            el('span', { class: 'room-field-label', text: tr('伙伴工作时长') }),
            el('label', { class: 'room-check' }, [limitEnabled, el('span', { text: tr('启用单步时限') })]),
            el('span', {
              class: 'room-field-hint',
              text: tr('默认不限总时长。连续 5 分钟没有新活动时提醒，任务仍会继续。')
            }),
            field(
              tr('每一步最长（分钟）'),
              minutes,
              tr('仅勾选后生效。临近时限会提醒，到时停止并保留已有进度和执行记录。更改只影响之后启动的步骤。')
            )
          ])
        ])
      ],
      footer: [
        el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: closeDialog }),
        el('button', { type: 'submit', class: 'primary-button', text: '保存' })
      ],
      onsubmit: async () => {
        const planners = pickers
          .map(p => p.value())
          .filter(p => p.provider)
          .map(({ provider, model, effort }) => ({ provider, model, effort }));
        await call('/workflows/settings', 'PUT', {
          planners,
          verifyRetries: Number(retries.value),
          stepLimitEnabled: limitEnabled.checked,
          stepMinutes: limitEnabled.checked ? Number(minutes.value) : settings.stepMinutes
        });
        toast('已保存工作流设置');
        closeDialog();
      }
    });
  }
  // --- the library ---------------------------------------------------------------------------
  function openLibrary() {
    const chat = state.chat;
    const list = el('ul', { class: 'wf-library' });
    for (const wf of workflows()) {
      const mounts = (Workflows.data?.mounts || []).filter(m => m.workflowId === wf.id);
      const positions = positionsOf(wf).length;
      const where = mounts.map(m => chatById(m.chatId)?.title).filter(Boolean);
      const here = chat && mounts.some(m => m.chatId === chat.id);
      list.append(
        el('li', {}, [
          el('span', { class: 'wf-library-text' }, [
            el('strong', { text: wf.name }),
            el('span', {
              class: 'wf-library-meta',
              text: [
                `${wf.stages.length} 个阶段 · ${positions} 个位置`,
                wf.ledger ? '台账' : '',
                wf.retries ? `验收不通过重做 ${wf.retries} 次` : ''
              ]
                .filter(Boolean)
                .join(' · ')
            }),
            wf.description ? el('span', { class: 'wf-library-desc', text: oneLine(wf.description, 120) }) : null,
            where.length ? el('span', { class: 'wf-library-where', text: `挂在：${where.join('、')}` }) : null
          ]),
          el('span', { class: 'wf-library-actions' }, [
            textAction('编辑', () => openEditor(wf, { onDone: () => openLibrary() })),
            chat && !here
              ? textAction('挂到这个对话', () => Workflows.openMount({ chatId: chat.id, draft: { workflowId: wf.id } }))
              : null
          ])
        ])
      );
    }
    showDialog({
      size: 'wide',
      eyebrow: '工作流',
      title: '工作流库',
      body: [
        el('p', {
          class: 'room-dialog-note',
          text: '工作流只写「有哪些位置、每个位置做什么」；谁来坐、什么时候跑，在挂到对话上时决定。同一个工作流可以挂在不同房间。'
        }),
        workflows().length ? list : el('p', { class: 'room-desk-empty', text: '还没有工作流。' })
      ],
      footer: [
        el('button', { type: 'button', class: 'secondary-button', text: '工作流设置…', onclick: openSettings }),
        el('button', {
          type: 'button',
          class: 'secondary-button',
          text: '＋ 新建工作流',
          onclick: () => openEditor(null, { onDone: () => openLibrary() })
        }),
        el('button', { type: 'button', class: 'primary-button', text: '完成', onclick: closeDialog })
      ]
    });
  }

  Object.assign(Workflows, { saveRunAsWorkflow, openEditor, openSettings, openLibrary });
})();

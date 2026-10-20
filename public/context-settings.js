'use strict';

// Settings → 上下文与压缩: how much history a new session reads, and which models write the summary.
globalThis.StarportContextSettings = (() => {
  const { el, field, textAction, showDialog, closeDialog, modelPicker, PROVIDER_LABELS } = globalThis.StarportUI;

  async function open() {
    let settings;
    try {
      settings = await api('/context/settings');
    } catch (error) {
      if (/没有这个接口|\(404\)/.test(error.message) && globalThis.StarportSettings?.contextUnavailable)
        globalThis.StarportSettings.contextUnavailable();
      else toast(error.message);
      return;
    }
    const enabled = el('select', {}, [
      el('option', { value: 'on', text: '开' }),
      el('option', { value: 'off', text: '关（只附带放得下的最近消息）' })
    ]);
    enabled.value = settings.enabled ? 'on' : 'off';
    const budgetInputs = {};
    const budgets = el(
      'div',
      { class: 'room-field-grid' },
      Object.entries(PROVIDER_LABELS).map(([id, label]) => {
        budgetInputs[id] = el('input', {
          type: 'number',
          min: '8',
          max: '1000',
          step: '1',
          value: String(settings.budgets[id] ?? settings.defaults.budgets[id])
        });
        const cap = settings.byteCaps?.[id];
        return field(
          `${label}（千 token）`,
          budgetInputs[id],
          cap
            ? `星港另设 ${cap.toLocaleString()} 字节的单次输入保护（避免已观察到的截断），这不是模型窗口；调高 token 预算不会解除这项保护。`
            : ''
        );
      })
    );
    let rows = [0, 1, 2].map(i => settings.summarizers[i] || { provider: '', model: '', effort: '' });
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
    showDialog({
      size: 'wide',
      eyebrow: '上下文',
      title: '上下文与压缩',
      body: [
        el('p', {
          class: 'room-dialog-note',
          text: '换模型、开分支或改了对话设置后，新会话要从头读这个对话。读不下时，较早的部分先压缩成摘要，最近几轮保留原文，原文另存在工作目录的 .starport/history 里。摘要属于对话，换模型时直接复用，只有新内容又多到放不下才再压缩。同一个模型接着聊时，原工具自己管理上下文。'
        }),
        el('p', {
          class: 'room-dialog-note',
          text: '以下是星港交接历史时的预算，单位是估算 token，不是汉字数，也不是模型的完整上下文窗口。'
        }),
        field('自动压缩', enabled),
        el('div', { class: 'room-field' }, [
          el('div', { class: 'room-field-head' }, [
            el('span', { class: 'room-field-label', text: '新会话最多读多少历史' }),
            textAction('恢复默认', () => {
              for (const [id, input] of Object.entries(budgetInputs))
                input.value = String(settings.defaults.budgets[id]);
            })
          ]),
          el('span', {
            class: 'room-field-hint',
            text: '超过就触发压缩。压缩后最近的原文约占这个上限的四成，留出余量，不会每次换模型都压缩。'
          }),
          budgets
        ]),
        el('div', { class: 'room-field' }, [
          el('div', { class: 'room-field-head' }, [
            el('span', { class: 'room-field-label', text: '写摘要的模型' }),
            textAction('恢复默认', () => {
              rows = (settings.defaults.summarizers || []).map(p => ({ ...p }));
              while (rows.length < 3) rows.push({ provider: '', model: '', effort: '' });
              drawRows();
            })
          ]),
          el('span', {
            class: 'room-field-hint',
            text: '一选接不通就用二选，再不通用三选；都不通时这一轮只附带最近的消息。摘要在只读的临时会话里写，写完就删掉。'
          }),
          box
        ])
      ],
      footer: [
        el('button', { type: 'button', class: 'secondary-button', text: '取消', onclick: closeDialog }),
        el('button', { type: 'submit', class: 'primary-button', text: '保存' })
      ],
      onsubmit: async () => {
        const summarizers = pickers
          .map(p => p.value())
          .filter(p => p.provider)
          .map(({ provider, model, effort }) => ({ provider, model, effort }));
        const values = Object.fromEntries(Object.entries(budgetInputs).map(([id, input]) => [id, Number(input.value)]));
        await api('/context/settings', 'PUT', { enabled: enabled.value === 'on', budgets: values, summarizers });
        toast('已保存上下文设置');
        closeDialog();
      }
    });
  }

  return { open };
})();

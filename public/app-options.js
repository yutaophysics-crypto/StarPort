'use strict';

// The right panel's tool tab: which tool a chat uses, its options, and the model and
// thinking-level fields; also the tool cards on the welcome page and the connection list in Settings.

const modelLists = new Map();
const customModels = new Map();

const modelContext = () =>
  JSON.stringify([
    currentId(),
    currentProvider()?.command,
    currentProvider()?.prefixArgs,
    state.chat?.workspace || state.workspace
  ]);
const modelDraftKey = () => JSON.stringify([state.chat?.id || 'new', currentId()]);
const modelValue = model => (model.provider ? JSON.stringify([model.provider, model.id]) : model.id);

function renderWelcome() {
  const root = $('#welcome-providers');
  root.replaceChildren();
  for (const p of state.providers) {
    const selected = currentId() === p.id;
    const button = el(
      'button',
      {
        class: 'provider-card' + (selected ? ' selected' : ''),
        'aria-pressed': String(selected)
      },
      [
        mark(p),
        el('span', {}, [el('strong', { text: p.name }), el('small', { text: t(p.installed ? '已安装' : '待连接') })]),
        selected ? el('span', { class: 'check', text: '✓' }) : null
      ]
    );
    button.onclick = () => switchProvider(p.id);
    root.append(button);
  }
}

function saveOptions(p, updated) {
  if (state.chat) {
    state.chat.options[p.id] = updated;
    queueSave({ options: updated });
  } else {
    state.options[p.id] = updated;
  }
  globalThis.StarportContext?.render();
}

async function fetchModels(force = false) {
  const key = modelContext();
  const p = currentProvider();
  const previous = modelLists.get(key);
  if (!p || previous?.loading || (!force && previous)) return;
  const entry = { ...previous, loading: true };
  modelLists.set(key, entry);
  try {
    const result = await api(
      '/providers/' +
        p.id +
        '/models?' +
        new URLSearchParams({
          workspace: state.chat?.workspace || state.workspace,
          ...(force ? { refresh: '1' } : {})
        })
    );
    delete entry.effort;
    Object.assign(entry, result);
  } catch {
    entry.models = [];
    delete entry.effort;
    entry.source = 'unavailable';
  } finally {
    entry.loading = false;
    if (key === modelContext()) {
      renderModelField();
      renderEffortField();
    }
  }
}

function renderModelField() {
  const root = $('#model-field');
  const p = currentProvider();
  if (!root || !p) return;
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const caret = focused?.id === 'custom-model' ? [focused.selectionStart, focused.selectionEnd] : null;
  const data = modelLists.get(modelContext());
  const models = data?.models || [];
  const values = opts();
  const draftKey = modelDraftKey();
  const selected = models.find(m => m.id === values.model && (!m.provider || m.provider === values.provider));
  const custom = customModels.has(draftKey);

  const select = el(
    'select',
    {
      id: 'option-model',
      name: 'model',
      'aria-describedby': 'model-source',
      disabled: !!state.run
    },
    [
      el('option', { value: '', text: t('跟随工具默认') }),
      ...models.map(m =>
        el('option', {
          value: modelValue(m),
          text: m.label + (m.provider ? ' · ' + m.provider : ''),
          title: m.resolvedModel || m.id
        })
      ),
      values.model && !selected
        ? el('option', { value: '__saved__', text: values.model + ' · ' + t('当前设置') })
        : null,
      el('option', { value: '__custom__', text: t('自定义模型…') })
    ]
  );
  select.value = custom ? '__custom__' : selected ? modelValue(selected) : values.model ? '__saved__' : '';

  const refresh = el('button', {
    type: 'button',
    class: 'model-refresh',
    text: t('刷新列表'),
    disabled: !!state.run || !!data?.loading
  });
  refresh.onclick = () => {
    fetchModels(true);
    renderModelField();
    renderEffortField();
  };

  const sources = {
    native: '来自工具的模型列表',
    aliases: '未取得实际版本，暂显示模型别名',
    configured: '来自本地配置与已安装模型目录',
    unavailable: '暂未取得列表，可用默认或自定义模型'
  };
  const source = el('small', {
    id: 'model-source',
    class: 'model-source',
    role: 'status',
    text: t(data?.loading ? '正在读取模型…' : sources[data?.source] || '正在读取模型…')
  });

  const children = [el('label', { for: 'option-model', text: t('模型') }), select];
  if (custom) {
    const input = el('input', {
      id: 'custom-model',
      type: 'text',
      value: customModels.get(draftKey),
      placeholder: t('输入模型名称'),
      'aria-label': t('自定义模型'),
      disabled: !!state.run,
      maxlength: '500'
    });
    input.oninput = () => customModels.set(draftKey, input.value);
    input.onchange = () => {
      saveOptions(p, { ...opts(), model: input.value.trim() });
      renderEffortField();
    };
    children.push(input);
  }
  children.push(el('div', { class: 'model-meta' }, [source, refresh]));
  root.replaceChildren(...children);

  if (focused?.id && !state.run) {
    const replacement = document.getElementById(focused.id);
    replacement?.focus({ preventScroll: true });
    if (caret && replacement) replacement.setSelectionRange(...caret);
  }

  select.onchange = () => {
    if (select.value === '__custom__') {
      customModels.set(draftKey, values.model);
      renderModelField();
      $('#custom-model').focus();
      return;
    }
    customModels.delete(draftKey);
    if (select.value === '__saved__') {
      renderModelField();
      return;
    }
    const chosen = models.find(m => modelValue(m) === select.value);
    const updated = { ...opts(), model: chosen?.id || '' };
    if (p.id === 'deepseek') updated.provider = chosen?.provider || '';
    saveOptions(p, updated);
    renderFeatures();
  };
}

function renderEffortField() {
  const root = $('#effort-field');
  const p = currentProvider();
  if (!root || !p) return;
  const focus = root.contains(document.activeElement);
  const data = modelLists.get(modelContext());
  const values = opts();
  const model = values.model
    ? data?.models?.find(
        m =>
          (m.id === values.model || m.resolvedModel === values.model) && (!m.provider || m.provider === values.provider)
      )
    : null;
  const capability = model?.effort || data?.effort;
  const choices = capability?.choices || [];
  const unavailable = !!values.effort && !choices.some(c => c.value === values.effort);

  const select = el(
    'select',
    {
      id: 'option-effort',
      name: 'effort',
      'aria-describedby': 'effort-status',
      'aria-invalid': String(unavailable && !data?.loading),
      disabled: !!state.run || !!data?.loading || (!choices.length && !values.effort)
    },
    [
      el('option', { value: '', text: t('跟随工具默认') }),
      ...choices.map(c =>
        el('option', {
          value: c.value,
          text:
            c.label +
            (c.value === capability.defaultLevel ? ' · ' + t('模型默认') : '') +
            (c.warning ? ' · ' + t(c.warning) : ''),
          title: c.description || c.label
        })
      ),
      unavailable
        ? el('option', { value: values.effort, text: values.effort + ' · ' + t('当前不可用'), disabled: true })
        : null
    ]
  );
  select.value = values.effort || '';

  const statusText = data?.loading
    ? '正在读取原生思考档位…'
    : unavailable
      ? '已选档位不适用于当前模型，请重新选择。'
      : !capability
        ? values.model
          ? '暂未取得此模型的档位，仅可跟随工具默认。'
          : '选择具体模型后，显示对应的思考档位。'
        : !choices.length
          ? '此模型不提供可调思考档位。'
          : '';

  const selected = choices.find(c => c.value === values.effort);
  const statusNode = el('small', {
    id: 'effort-status',
    class: 'effort-status' + (unavailable && !data?.loading ? ' error' : ''),
    role: 'status',
    text: statusText ? t(statusText) : ''
  });
  statusNode.hidden = !statusText;

  root.replaceChildren(
    el('label', { for: 'option-effort', text: t('思考强度') }),
    select,
    statusNode,
    ...(selected?.warning ? [el('small', { class: 'effort-warning', text: t(selected.warning) })] : [])
  );

  select.onchange = () => {
    saveOptions(p, { ...opts(), effort: select.value });
    renderEffortField();
  };
  if (focus && !select.disabled) select.focus({ preventScroll: true });
}

function renderFeatures() {
  const p = currentProvider();
  if (!p) return;
  const select = $('#provider-select');
  select.replaceChildren(...state.providers.map(item => el('option', { value: item.id, text: item.name })));
  select.value = p.id;
  select.disabled = !!state.run;
  select.title = t(p.notes || '');

  const status = $('#provider-status');
  status.textContent = t(
    p.verification ? (p.verification.ok ? '已通过实际对话验证' : '最近一次调用失败 · 查看连接设置') : p.statusLabel
  );
  status.classList.toggle('error', p.status === 'missing' || p.verification?.ok === false);

  const form = $('#provider-options');
  const values = opts();
  form.replaceChildren();

  for (const field of p.fields) {
    if (field.when && !Object.entries(field.when).every(([k, v]) => values[k] === v)) continue;
    if (field.key === 'model') {
      form.append(el('div', { id: 'model-field', class: 'model-field' }));
      continue;
    }
    if (field.key === 'effort') {
      form.append(el('div', { id: 'effort-field', class: 'effort-field' }));
      continue;
    }
    if (p.id === 'codex' && field.key === 'permissionMode') {
      const choice = field.choices.find(item => item.value === values.permissionMode) || field.choices[0];
      const button = el(
        'button',
        {
          id: 'option-sandbox',
          type: 'button',
          class: 'permission-field-button',
          disabled: !!state.run,
          'aria-haspopup': 'dialog',
          'aria-label': t('更改 Codex 权限')
        },
        [el('span', { text: t(choice.label) }), el('span', { 'aria-hidden': 'true', text: '⌄' })]
      );
      button.onclick = () => globalThis.StarportPermissions?.open();
      form.append(
        el('div', { class: 'permission-field' }, [
          el('label', { for: 'option-sandbox', text: t(field.label) }),
          button,
          el('small', { class: 'permission-summary', text: t(choice.description || '') })
        ])
      );
      continue;
    }

    const label = el('label', { class: field.type === 'checkbox' ? 'checkbox' : '' });
    const id = 'option-' + field.key;
    let input;
    if (field.type === 'select') {
      input = el(
        'select',
        { id, name: field.key },
        field.choices.map(c => el('option', { value: c.value, text: t(c.label) }))
      );
      input.value = values[field.key];
    } else if (field.type === 'textarea') {
      input = el('textarea', {
        id,
        name: field.key,
        value: values[field.key],
        placeholder: t(field.placeholder || '')
      });
    } else {
      input = el('input', {
        id,
        name: field.key,
        type: field.type === 'checkbox' ? 'checkbox' : field.type === 'number' ? 'number' : 'text',
        value: values[field.key],
        placeholder: t(field.placeholder || '')
      });
    }
    input.disabled = !!state.run;
    if (field.type === 'number') input.min = '1';
    if (field.type === 'checkbox') {
      input.checked = !!values[field.key];
      label.append(input, t(field.label));
    } else {
      label.append(t(field.label), input);
    }

    const choiceHelp =
      field.type === 'select' && field.choices.some(choice => choice.description)
        ? el('small', {
            id: id + '-description',
            class: 'permission-summary',
            role: 'status',
            text: t(field.choices.find(choice => choice.value === input.value)?.description || '')
          })
        : null;
    if (choiceHelp) {
      input.setAttribute('aria-describedby', choiceHelp.id);
      label.append(choiceHelp);
    }

    input.onchange = () => {
      if (choiceHelp) {
        choiceHelp.textContent = t(field.choices.find(choice => choice.value === input.value)?.description || '');
      }
      const updated = {
        ...opts(),
        [field.key]: field.type === 'checkbox' ? input.checked : input.value
      };
      if (state.chat) {
        state.chat.options[p.id] = updated;
        queueSave({ options: updated });
      } else {
        state.options[p.id] = updated;
      }
      if (field.key === 'mode') renderFeatures();
      else if (field.key === 'provider') {
        renderModelField();
        renderEffortField();
      }
    };
    form.append(label);
  }

  if (!p.fields.length) {
    form.append(el('p', { class: 'muted', text: t('使用 DeepSeek Harness 中已配置的默认模型和工具。') }));
  }
  $('#provider-note').textContent = t(p.notes);
  $('#composer-provider').textContent = p.name;
  renderModelField();
  renderEffortField();
  fetchModels();
  globalThis.StarportComposer?.render();
  globalThis.StarportPermissions?.render();
  renderWelcome();
  globalThis.StarportAgentsRoom?.scheduleRender();
}

async function switchProvider(id) {
  if (state.run) {
    toast('请先停止当前执行，再切换工具。');
    return;
  }
  viewRevision++;
  if (state.chat) {
    state.chat.provider = id;
    await queueSave({ provider: id });
  } else {
    state.selected = id;
  }
  localStorage.setItem('hub-provider', id);
  renderFeatures();
  renderRun();
}

function renderConnections() {
  const root = $('#connection-list');
  root.replaceChildren();
  for (const p of state.providers) {
    const status = p.verification
      ? p.verification.ok
        ? '最近一次对话成功'
        : p.verification.error
      : p.error || p.statusLabel;
    const row = el('section', { class: 'connection-item' }, [
      el('header', {}, [
        mark(p),
        el('h3', { text: p.name }),
        el('small', { text: p.version || t(p.installed ? '版本未知' : '未安装') })
      ]),
      el('p', {
        class: 'status-text' + (p.verification?.ok === false ? ' error' : ''),
        text: notice(status)
      })
    ]);
    const details = el('details', {}, [el('summary', { text: t('程序路径与高级设置') })]);
    const command = el('input', { value: p.command || '', placeholder: t('可执行文件完整路径') });
    const args = el('input', {
      value: JSON.stringify(p.prefixArgs || []),
      placeholder: t('前置参数 JSON 数组，如 []')
    });
    details.append(el('label', {}, [t('程序'), command]), el('label', {}, [t('前置参数'), args]));
    const save = el('button', { class: 'secondary-button', text: t('保存并检查') });
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api('/providers/' + p.id, 'PUT', {
          command: command.value,
          prefixArgs: JSON.parse(args.value || '[]')
        });
        await refresh();
        renderConnections();
        toast('已保存');
      } catch (e) {
        toast(e.message);
      } finally {
        save.disabled = false;
      }
    };
    details.append(
      save,
      el('p', {}, [el('a', { href: p.source, target: '_blank', rel: 'noreferrer', text: t('查看官方接入说明') })])
    );
    row.append(details);
    root.append(row);
  }
}

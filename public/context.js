'use strict';

globalThis.StarportContext = (() => {
  const button = $('#context-indicator'), dialog = $('#context-dialog');
  const number = value => value.toLocaleString(i18n.locale, { maximumFractionDigits: 1 });
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const pending = new Map();
  let lastKey = null;
  const binding = () => {
    const options = opts();
    return JSON.stringify([currentId(), state.chat?.workspace || state.workspace, options.worktree || false, options.model || '', options.provider || '']);
  };
  const key = () => JSON.stringify([state.chat?.id, binding()]);

  async function refresh(force = false, notify = force) {
    if (!state.chat) return;
    const requestKey = key(), chatId = state.chat.id;
    if (pending.has(requestKey)) return pending.get(requestKey);
    const request = (async () => {
      try {
        const data = await api('/chats/' + encodeURIComponent(chatId) + '/context' + (force ? '?refresh=1' : ''));
        // A slower HTTP reply must not roll back a newer native usage event.
        const previous = state.context?.binding === binding() ? Date.parse(state.context.updatedAt) || 0 : 0;
        if (requestKey === key() && (!previous || (Date.parse(data?.updatedAt) || 0) >= previous)) state.context = data;
      } catch (error) {
        if (notify && requestKey === key()) toast(error.message);
      } finally {
        pending.delete(requestKey);
        render();
      }
    })();
    pending.set(requestKey, request);
    render();
    return request;
  }

  function current() {
    const data = state.chat && state.context?.binding === binding() ? state.context : {
      status: ['codex', 'claude'].includes(currentId()) ? 'waiting' : 'unavailable'
    };
    // Also handles the previous server while it waits for busy agents to finish.
    // Never reuse its projected denominator or percentage as native capacity.
    const capacity = count(Object.hasOwn(data, 'modelWindowTokens') ? data.modelWindowTokens :
      data.limits ? data.limits.modelWindowTokens : data.windowTokens);
    const usedTokens = count(data.usedTokens), windowTokens = capacity > 0 ? capacity : null;
    let status = data.status;
    if (status === 'ready' || status === 'inconsistent')
      status = usedTokens === null ? 'waiting' : windowTokens && usedTokens > windowTokens ? 'inconsistent' : 'ready';
    return { ...data, status, usedTokens, windowTokens,
      percent: status === 'ready' && usedTokens !== null && windowTokens ? usedTokens / windowTokens * 100 : null };
  }

  function label(data) {
    if (data.status === 'compacting') return t('正在压缩…');
    if (data.status === 'inconsistent') return t('计量异常');
    if (data.status === 'unavailable') return t('暂不支持');
    if (data.usedTokens === null) return t('待获取');
    return data.percent === null ? number(data.usedTokens) + ' tokens' : number(data.percent) + '%';
  }

  function details(data) {
    const body = $('#context-body');
    body.replaceChildren();
    body.append(el('p', { class: 'context-summary', text: (currentProvider()?.name || currentId()) + ' · ' + label(data) }));
    if (data.model) body.append(el('p', { class: 'muted', text: data.model }));
    const note = text => el('p', { class: 'muted', text: t(text) });
    const section = (title, rows) => {
      const list = el('dl', { class: 'context-facts' });
      for (const [name, value, unit = 'tokens'] of rows)
        list.append(el('dt', { text: t(name) }), el('dd', { text: value == null ? t('未提供') : number(value) + ' ' + unit }));
      body.append(el('h3', { class: 'context-section-title', text: t(title) }), list);
    };

    section('模型窗口占用', [['最近一次占用', data.usedTokens], ['模型窗口（原工具报告）', data.windowTokens]]);
    const explanation = data.status === 'inconsistent' ? '原工具报告的占用大于窗口容量，暂不显示百分比。原始数值保留在上方，等待新的用量报告。' :
      data.status === 'unavailable' ? '当前接入方式尚未提供可核对的上下文占用，暂不估算百分比。' :
      data.status === 'compacting' ? '正在压缩上下文，完成后等待新的用量报告。' :
      data.usedTokens === null ? '发送消息后，等待原工具报告。旧记录、导入的对话或重置后的会话可能暂时没有数据。' :
      data.windowTokens === null ? '原工具尚未报告模型窗口容量；保留占用数，不估算百分比。' :
      data.basis === 'claude-input' ? '采用 Claude Code 状态栏口径：最近一次请求的输入，包含缓存读写，不包含输出。' :
      '采用 Codex 最近一次请求的 Token 总数与原工具报告的窗口容量；不使用累计消耗。';
    body.append(note(explanation));

    const limits = data.limits || {};
    const policyWindow = limits.compactionKind === 'window' || currentId() === 'claude';
    const nativeRows = [[policyWindow ? '压缩策略窗口' : '压缩触发参考值', limits.nativeAutoCompactTokens]];
    if (limits.nativeWindowTokens) nativeRows.push(['原工具配置的窗口', limits.nativeWindowTokens]);
    section('原工具自动压缩', nativeRows);
    if (limits.status === 'waiting') body.append(note('正在读取原工具的压缩参考信息…'));
    else if (['error', 'unavailable'].includes(limits.status)) body.append(note('暂未取得原工具的压缩参考信息；不影响已报告的模型窗口占用。'));
    else if (limits.nativeAutoCompactTokens == null) body.append(note('原工具未提供明确的压缩线，默认值不作猜测。'));
    if (limits.nativeAutoCompactTokens) body.append(note(policyWindow ?
      '这是压缩策略窗口；Claude Code 会预留空间，实际压缩可能更早。它不作为窗口占用率的分母。' :
      '这是自动压缩的配置参考，不作为窗口占用率的分母，也不是准确的压缩倒计时。'));
    if (limits.autoCompactScope === 'body_after_prefix') body.append(note('此压缩线只计算前缀之后的新增内容，不能与当前总占用直接相减。'));
    body.append(note('读取的是当前配置；正在运行的任务是否立即采用新设置，由原工具决定。'));

    const transferRows = [['星港历史交接预算', limits.starportTokens]];
    if (limits.starportBytes) transferRows.push(['单次输入保护', limits.starportBytes, 'bytes']);
    section('星港历史交接', transferRows);
    body.append(note('只在新会话交接历史时使用，不参与当前模型窗口占用率的计算。超过预算时由星港整理摘要，连续会话的压缩由原工具管理。'));
    if (limits.starportBytes) body.append(note('字节保护只限制单次交接的传输大小，不代表模型的上下文窗口。'));
    body.append(note('随原工具事件更新。尚未发送的文字和待转入的历史未计入；这不是账号剩余额度，也不是自动压缩倒计时。'));
    if (data.updatedAt) body.append(el('p', { class: 'muted', text: t('最后报告：{time}', { time: new Date(data.updatedAt).toLocaleString(i18n.locale) }) }));
    const reload = el('button', { class: 'secondary-button', text: t('刷新参考信息') });
    reload.disabled = pending.has(key());
    reload.onclick = () => refresh(true);
    body.append(reload);
  }

  function render() {
    const data = current(), text = t('上下文') + ' · ' + label(data);
    button.title = text + (data.windowTokens ? ' · ' + t('模型窗口（原工具报告）') + ': ' + number(data.windowTokens) + ' tokens' : '');
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('context-high', data.percent >= 80 || data.status === 'inconsistent');
    const track = el('span', { class: 'context-track', 'aria-hidden': 'true' }), fill = el('span');
    if (data.percent !== null) {
      fill.style.width = Math.min(100, Math.max(0, data.percent)) + '%';
      track.append(fill);
    }
    button.replaceChildren(track, el('span', { text }));
    if (dialog.open) details(data);
    const selected = key();
    if (state.chat && selected !== lastKey) { lastKey = selected; Promise.resolve().then(() => refresh()); }
  }

  button.onclick = () => {
    const close = el('button', { class: 'icon-button', text: '×', 'aria-label': t('关闭') });
    close.onclick = () => dialog.close();
    dialog.replaceChildren(el('div', { class: 'dialog-heading' }, [el('h2', { id: 'context-heading', text: t('上下文占用') }), close]),
      el('div', { id: 'context-body', class: 'dialog-body' }));
    details(current());
    dialog.showModal();
    refresh(true);
  };
  setInterval(() => { if (!document.hidden && state.chat) refresh(true, false); }, 30000);
  render();
  return { render, refresh };
})();

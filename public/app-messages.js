'use strict';

// The conversation: messages and run cards, branch links, questions and approvals from the tool,
// and the run's status line, queue and goal under the composer.

function markdown(text) {
  text = globalThis.StarportMemoryProtocol?.split(text).text ?? text;
  const div = el('div', { class: 'message-body' });
  const files = new Map();
  const context = { chatId: state.chat?.id };
  let prefix = 'starport-local-file-';
  while (String(text).includes(prefix)) prefix += 'x';
  const localLink = reference => {
    if (!globalThis.StarportFiles?.isReference(reference)) return null;
    const key = '#' + prefix + files.size;
    files.set(key, reference);
    return key;
  };
  try {
    div.innerHTML = DOMPurify.sanitize(
      StarportMarkdown.render(text, {
        errorLabel: t('公式暂无法渲染，保留原文'),
        pendingLabel: t('公式尚未完整，等待后续内容'),
        localLink
      }),
      {
        FORBID_TAGS: ['img', 'iframe', 'form', 'input', 'button', 'video', 'audio'],
        FORBID_ATTR: ['id', 'name'],
        ADD_ATTR: ['target']
      }
    );
  } catch {
    div.textContent = text;
  }
  for (const link of div.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#starport-chat=')) {
      link.onclick = event => {
        event.preventDefault();
        globalThis.StarportSharedContext?.openCitation(href);
      };
    } else if (files.has(href)) {
      StarportFiles.bind(link, files.get(href), context);
    } else if (!/^https?:\/\//i.test(href)) {
      link.removeAttribute('href');
    } else {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  globalThis.StarportFiles?.decorate(div, context);
  globalThis.StarportCodeCopy?.decorate(div);
  return div;
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? t('{m} 分 {s} 秒', { m, s }) : t('{s} 秒', { s });
}

function renderMessages() {
  const container = $('#conversation');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 110;
  const root = $('#messages');
  globalThis.StarportActivity?.remember(root);
  root.replaceChildren();
  for (const msg of StarportLive.orderedMessages(state.messages)) {
    const p = provider(msg.provider);
    // A workflow or @companion run is a card the server keeps current, not a model reply.
    const workflows = msg.details?.workflowRun ? globalThis.StarportWorkflows : null;
    const header = workflows
      ? workflows.cardHeader(msg)
      : el('div', { class: 'message-header' }, [
          msg.role === 'user' ? el('span', { class: 'provider-mark', text: t('你') }) : mark(p),
          el('strong', { text: msg.role === 'user' ? t('你') : p?.name || t('助手') }),
          el('time', {
            text: new Date(msg.created).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' })
          })
        ]);
    const row = el(
      'article',
      { class: 'message ' + msg.role + (workflows ? ' workflow-run' : ''), 'data-message-id': msg.id },
      [
        header,
        msg.role === 'user' && msg.details?.runRef && globalThis.StarportWorkflows
          ? StarportWorkflows.refChip(msg.details.runRef)
          : null,
        msg.role === 'user'
          ? el('div', { class: 'message-body', text: msg.content })
          : workflows
            ? workflows.renderCard(msg)
            : StarportActivity.render(msg, { el, t, markdown, chatId: state.chat?.id || '' })
      ]
    );
    if (msg.details?.attachments?.length) {
      row.append(globalThis.StarportComposer?.attachmentList(msg.details.attachments) || '');
    }
    if (msg.role === 'assistant' && msg.details?.memory) {
      const memory = msg.details.memory;
      const used = memory.ids?.length || 0;
      const candidates = memory.candidates?.length || 0;
      if (used || candidates || memory.browsed?.length) {
        const context = {
          chatId: state.chat?.id,
          messageId: msg.id,
          chatTitle: state.chat?.title,
          created: msg.created,
          providerName: provider(msg.provider)?.name || msg.provider
        };
        const button = el('button', {
          type: 'button',
          class: 'memory-receipt',
          title: t('查看本轮记忆详情'),
          text: t('共同记忆 {used} 条 · 新候选 {candidates} 条', { used, candidates })
        });
        button.onclick = () =>
          globalThis.StarportMemory?.showReceipt(memory, context).catch(error => toast(error.message));
        row.append(button);
      }
    }
    if (msg.role === 'assistant' && msg.details?.memory?.sources?.length) {
      const sources = el('div', { class: 'history-sources' }, [el('span', { text: t('历史来源') })]);
      for (const source of msg.details.memory.sources.slice(0, 12)) {
        const button = el('button', { type: 'button', text: source.title });
        button.onclick = () => globalThis.StarportSharedContext?.openCitation(source.citation);
        sources.append(button);
      }
      row.append(sources);
    }
    if (msg.details?.guidance) {
      const labels = {
        sending: '正在提交…',
        queued: '已排队，当前任务完成后继续',
        accepted: '已交给当前任务',
        delivered: '已发送至原工具',
        'not-delivered': '未送达原工具'
      };
      if (msg.provider === 'claude') labels.queued = '等待 Claude 在执行间隙接收';
      row.append(
        el('small', { class: 'guidance-receipt', text: t(labels[msg.details.guidance.state] || '未确认送达') })
      );
    }
    for (const text of msg.details?.notices || []) {
      row.append(el('div', { class: 'notice', text: notice(text) }));
    }
    if (msg.details?.error) {
      row.append(el('div', { class: 'error-note', text: notice(msg.details.error) }));
    } else if (msg.status === 'interrupted') {
      row.append(el('div', { class: 'notice', text: t('本次执行已停止，已有内容已保存。') }));
    }
    if (msg.role === 'assistant' && !workflows && !['running', 'pending'].includes(msg.status)) {
      const branch = el('button', {
        type: 'button',
        class: 'message-branch',
        title: t('把到这条回复为止的对话复制成一个新对话，从这里继续'),
        text: t('从这里分支')
      });
      branch.onclick = () => branchFrom(msg.id);
      row.append(branch);
    }
    root.append(row);
    if (state.chat?.options?.branch?.at === msg.id) root.append(branchOrigin(state.chat.options.branch));
  }
  renderRun();
  globalThis.StarportSubagents?.tick();
  globalThis.StarportActivity?.restoreFocus(root);
  if (atBottom) container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
  markViewed();
  globalThis.StarportAgentsRoom?.scheduleRender();
}

// A branch copies the history up to one reply into a new chat and continues there.
async function branchFrom(messageId) {
  const chatId = state.chat?.id;
  if (!chatId) return;
  try {
    const chat = await api('/chats/' + chatId + '/branch', 'POST', { messageId });
    if (!state.chats.some(row => row.id === chat.id)) state.chats = [chat, ...state.chats];
    await openChat(chat.id);
    toast('已开分支：{title}', { title: chat.title });
  } catch (error) {
    toast(error.message);
  }
}
function branchOrigin(branch) {
  const source = state.chats.find(row => row.id === branch.chatId);
  const line = el('div', { class: 'branch-origin' });
  if (!source) {
    line.append(el('span', { text: t('分支起点 · 原对话已删除') }));
    return line;
  }
  const open = el('button', { type: 'button', text: source.title });
  open.onclick = () => openChat(source.id).catch(error => toast(error.message));
  line.append(el('span', { text: t('分支起点 · 以上内容复制自') }), open);
  return line;
}

let approvalKey = '';
let questionKey = '';

function renderQuestions() {
  const root = $('#questions');
  if (!root || !globalThis.StarportQuestions) return;
  const { message, questions } = StarportQuestions.latest(state);
  const chatId = state.chat?.id;
  const key = JSON.stringify([
    i18n.language,
    chatId,
    message?.id,
    questions.map(q => q.id),
    state.run?.inputMode,
    !!state.run,
    state.run?.inputReady
  ]);
  if (key === questionKey) return;
  questionKey = key;
  StarportApprovals.remember(root);
  root.replaceChildren();
  if (!questions.length || !chatId) return;

  const description = state.run
    ? t(
        state.run.inputMode === 'steer'
          ? '回答会作为补充指示加入当前任务，不会停止任务。'
          : '回答会加入队列，原工具完成当前任务后继续处理。'
      )
    : t('提交后继续这段对话；输入框里的草稿会保留。');

  root.append(
    StarportApprovals.render(
      {
        id: 'text:' + message.id,
        provider: message.provider,
        kind: 'question',
        params: {
          title: t('回答助手的问题'),
          description,
          questions,
          canCancel: false,
          submitDisabled: !!state.run && !state.run.inputReady
        }
      },
      {
        el,
        t,
        scope: chatId,
        answer: async response => {
          if (
            state.chat?.id !== chatId ||
            state.messages.findLast(row => row.role === 'assistant')?.id !== message.id
          ) {
            throw new Error(t('问题已失效，请重新打开对话'));
          }
          if (response.decision === 'skip') {
            const data = await api('/chats/' + chatId + '/question-skip', 'POST', {
              replyTo: { messageId: message.id, questions: questions.map(q => q.id) }
            });
            liveSync?.receive(data);
            if (state.chat?.id === chatId) renderQuestions();
            return;
          }
          const text = StarportQuestions.answerText(questions, response.answers);
          const metadata = {
            replyTo: { messageId: message.id, questions: questions.map(q => q.id) },
            preserveDraft: true
          };
          if (state.run) return sendGuidance(text, metadata);
          return sendMessage(text, metadata);
        },
        onError: error => toast(error.message)
      }
    )
  );
}

function runStatusLine(run) {
  if (!run) return '';
  const approvals = run.approvals?.length;
  const compacting = run.phase === 'compacting';
  const parts = [t(approvals ? '等待你的决定' : compacting ? '正在压缩上下文…' : '正在处理…')];
  if (!approvals && !compacting) {
    const tools = [...state.messages].reverse().find(m => m.role === 'assistant')?.details?.tools || [];
    const current = tools.filter(tool => tool.status === 'running').pop();
    if (current) parts.push(t('正在执行：{name}', { name: current.name || t('工具') }));
  }
  const children =
    globalThis.StarportSubagents?.rows([...state.messages].reverse().find(m => m.role === 'assistant')) || [];
  if (children.length) parts.push(StarportSubagents.summary(children));
  parts.push(t('已运行 {time}', { time: formatDuration((Date.now() - new Date(run.started).getTime()) / 1000) }));
  if (run.stalled) {
    parts.push(t('已 {time} 没有新输出', { time: formatDuration((Date.now() - run.lastEventAt) / 1000) }));
  }
  return parts.join(' · ');
}

function renderComposerAction() {
  const button = $('#send');
  const stop =
    !!state.run && !$('#prompt').value.trim() && !(state.run.takesAttachments && globalThis.StarportComposer?.ids().length);
  const label = t(stop ? '停止任务' : state.run ? '加入队列' : '发送消息');
  button.type = stop ? 'button' : 'submit';
  button.dataset.action = stop ? 'stop' : 'send';
  button.disabled =
    sendingMessage ||
    stoppingRun === state.run?.id ||
    (!stop && !state.run && !$('#prompt').value.trim() && !globalThis.StarportComposer?.ids().length);
  button.setAttribute('aria-label', label);
  button.title = label + (stop ? '' : ' · Enter');
  button.querySelector('.send-icon').toggleAttribute('hidden', stop);
  button.querySelector('.stop-icon').toggleAttribute('hidden', !stop);
}

function renderRun() {
  globalThis.StarportContext?.render();
  renderComposerAction();
  const hint = $('#composer-guidance');
  if (hint) {
    hint.hidden = !state.run;
    hint.textContent = state.run
      ? t(
          state.run.inputMode === 'steer'
            ? state.run.provider === 'claude'
              ? '消息会先加入等待队列；点击“引导”可在执行间隙补充指示，不停止当前操作。'
              : '消息会先加入等待队列；点击“引导”可立即加入当前任务。'
            : '消息会先加入等待队列，当前任务完成后发送。'
        )
      : '';
  }
  globalThis.StarportQueue?.render($('#message-queue'), {
    state,
    el,
    t,
    language: i18n.language,
    onError: error => toast(error.message),
    action: async (type, row, text) => {
      const chatId = row.chat_id;
      const base = '/chats/' + chatId + '/queue/' + row.id;
      const data = await api(
        base + (type === 'begin-edit' ? '/edit' : ['steer', 'send', 'cancel-edit'].includes(type) ? '/' + type : ''),
        type === 'edit' ? 'PATCH' : type === 'delete' ? 'DELETE' : 'POST',
        {
          revision: row.revision,
          ...(type === 'edit' ? { text } : {}),
          ...(type === 'steer' ? { runId: state.run?.id } : {})
        }
      );
      if (state.chat?.id === chatId) {
        liveSync?.receive({ chatId, ...data });
        renderMessages();
      }
      liveSync?.reconcile();
      return data;
    }
  });
  const status = runStatusLine(state.run);
  $('#cover-run-status').textContent = status;
  $('#run-status').textContent = status;
  $('#run-status').classList.toggle('stalled', !!state.run?.stalled);
  $('#run-status').title = state.run?.stalled
    ? t('可能仍在执行一个长步骤，也可能卡住了。不会自动停止：可以继续等待，或用停止按钮结束。')
    : '';
  globalThis.StarportComposer?.render();
  globalThis.StarportPermissions?.render();

  const approvals = state.run?.approvals || [];
  const chatId = state.chat?.id;
  const key = i18n.language + chatId + state.run?.id + JSON.stringify(approvals.map(a => a.id));
  if (approvalKey !== key) {
    approvalKey = key;
    const root = $('#approvals');
    StarportApprovals.remember(root);
    root.replaceChildren();
    for (const request of approvals) {
      root.append(
        StarportApprovals.render(request, {
          el,
          t,
          scope: chatId + ':' + state.run.id,
          answer: answer => api('/chats/' + chatId + '/approval', 'POST', answer),
          onError: error => toast(error.message)
        })
      );
    }
  }
  renderQuestions();

  const goal = state.run?.goal || [...state.messages].reverse().find(m => m.details?.goal)?.details.goal;
  const box = $('#goal-status');
  box.hidden = !goal || currentId() !== 'codex';
  box.replaceChildren();
  if (goal && currentId() === 'codex') {
    const names = {
      active: '进行中',
      paused: '已暂停',
      blocked: '等待处理',
      usageLimited: '用量受限',
      budgetLimited: '已达预算',
      complete: '已完成'
    };
    const head = el('div', {}, [
      el('strong', { text: '◎ ' + t('目标') + ' · ' + t(names[goal.status] || goal.status) })
    ]);
    if (state.run && goal.status === 'active') {
      const pause = el('button', { text: t('暂停目标') });
      pause.onclick = () =>
        api('/chats/' + state.chat.id + '/goal', 'POST', { action: 'pause' }).catch(e => toast(e.message));
      head.append(pause);
    }
    box.append(
      head,
      el('p', { text: goal.objective }),
      el('small', {
        text: t('已用 {tokens} Token{budget} · {minutes} 分钟', {
          tokens: (goal.tokensUsed || 0).toLocaleString(i18n.locale),
          budget: goal.tokenBudget ? ' / ' + goal.tokenBudget.toLocaleString(i18n.locale) : '',
          minutes: Math.round((goal.timeUsedSeconds || 0) / 60)
        })
      })
    );
    if (!state.run && goal.status === 'paused') {
      const resume = el('button', { text: t('继续目标') });
      resume.onclick = () => {
        const options = { ...opts(), mode: 'goal', objective: goal.objective, tokenBudget: goal.tokenBudget || '' };
        state.chat.options.codex = options;
        queueSave({ options })
          .then(() => sendMessage(t('继续完成当前目标。')))
          .catch(e => toast(e.message));
      };
      box.append(resume);
    }
  }
}

'use strict';

// A companion step's process inside its run card, drawn like the main model's: the same
// collapsible view (activity.js), with the full prompt it was given on top and its answer while it
// streams (once done, the card shows the answer). The turn is read the first time it is opened;
// the live stream keeps it current. Part of StarportWorkflows (workflows.js).
(() => {
  const Workflows = globalThis.StarportWorkflows;
  const { el, PROVIDER_LABELS } = globalThis.StarportUI;
  const { tr, page } = Workflows;
  const STATUS = { running: 'running', done: 'complete', failed: 'error', stopped: 'interrupted' };
  // deskChatId:deskMessageId → { step, prompt, message, loaded, loading, stale, error, at, promptOpen }
  const turns = new Map();
  const timers = new Map();

  const tools = () => page || { el, t: tr, markdown: text => el('div', { class: 'message-body', text }) };

  // The step's own record of its turn, shown until the turn itself has been read.
  function stub(step) {
    return {
      id: step.deskMessageId,
      role: 'assistant',
      provider: step.provider,
      content: '',
      status: STATUS[step.status] || 'complete',
      created: step.started,
      details: { endedAt: step.ended ? Date.parse(step.ended) : undefined }
    };
  }

  function shown(step, turn) {
    const message = turn.message;
    if (!message) return stub(step);
    // The stream missed the end of the turn: follow the step until the final turn is read.
    if (message.status === 'running' && step.status !== 'running') {
      turn.stale = true;
      const own = stub(step);
      return { ...message, status: own.status, details: { ...message.details, endedAt: own.details.endedAt } };
    }
    return message;
  }

  function lead(step, turn) {
    const { el } = tools();
    const label = PROVIDER_LABELS[step.provider] || step.provider;
    const nodes = [
      el('p', {
        class: 'wf-desk-note',
        text: [label, step.model, tr('无人值守：需要审批的操作自动拒绝，提问自动跳过。')].filter(Boolean).join(' · ')
      })
    ];
    if (turn.prompt) {
      const prompt = el('details', { class: 'wf-desk-prompt' }, [
        el('summary', { text: tr('交给 {name} 的完整提示', { name: step.companionName }) }),
        el('pre', { text: turn.prompt })
      ]);
      prompt.open = !!turn.promptOpen;
      prompt.ontoggle = () => {
        turn.promptOpen = prompt.open;
      };
      nodes.unshift(prompt);
    }
    if (turn.error) nodes.push(el('p', { class: 'wf-step-error', text: turn.error }));
    return nodes;
  }

  function view(key) {
    const turn = turns.get(key);
    const step = turn.step;
    const { el, t, markdown } = tools();
    return globalThis.StarportActivity.render(shown(step, turn), {
      el,
      t,
      markdown,
      chatId: step.deskChatId,
      answer: step.status === 'running',
      autoOpen: false,
      pending: !turn.message && !turn.error,
      lead: () => lead(step, turn),
      onOpen: () => load(key)
    });
  }

  function processBlock(step) {
    if (!step.deskChatId || !step.deskMessageId || !globalThis.StarportActivity) return null;
    const key = step.deskChatId + ':' + step.deskMessageId;
    const turn = turns.get(key) || {};
    turns.delete(key);
    turns.set(key, Object.assign(turn, { step }));
    // Keep the turns cards showed most recently.
    for (const [old, entry] of turns) {
      if (turns.size <= 200) break;
      if (!entry.loading) turns.delete(old);
    }
    return el('div', { class: 'wf-step-process', 'data-desk-key': key }, [view(key)]);
  }

  async function load(key) {
    const turn = turns.get(key);
    // At most one read every few seconds: a turn still finishing on the server stays stale a moment.
    if (!turn || turn.loading || (turn.loaded && !turn.stale) || Date.now() - (turn.at || 0) < 3000) return;
    turn.loading = true;
    const [desk, id] = key.split(':');
    try {
      const data = await api('/desks/' + desk + '/turns/' + id);
      turn.prompt = data.prompt;
      turn.message = turn.message ? StarportLive.preferMessage(turn.message, data.message) : data.message;
      turn.loaded = true;
      turn.stale = false;
      turn.error = '';
    } catch (error) {
      turn.error = error.message;
    } finally {
      turn.loading = false;
      turn.at = Date.now();
      patch(key, 0);
    }
  }

  // live.js passes on packets for chats other than the open one; a desk's turn is one of them.
  function deskMessage(chatId, message) {
    const key = chatId + ':' + message?.id;
    const turn = turns.get(key);
    if (!turn) return;
    turn.message = turn.message ? StarportLive.preferMessage(turn.message, message) : message;
    patch(key);
  }

  // Redraw one turn in place, at most four times a second, keeping what is open and focused.
  function patch(key, delay = 250) {
    if (timers.has(key)) {
      if (delay) return;
      clearTimeout(timers.get(key));
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        const nodes = document.querySelectorAll('[data-desk-key="' + CSS.escape(key) + '"]');
        if (!nodes.length || !turns.has(key)) return;
        const conversation = document.querySelector('#conversation');
        const atBottom =
          conversation && conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 110;
        for (const node of nodes) {
          StarportActivity.remember(node);
          node.replaceChildren(view(key));
          StarportActivity.restoreFocus(node);
        }
        if (atBottom) conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'instant' });
      }, delay)
    );
  }

  Object.assign(Workflows, { processBlock, deskMessage });
})();

'use strict';

// Recovery is offered only for an exact, unsent startup refusal. The server
// validates the saved receipt and reuses the original user message/attachments.
globalThis.StarportCodexSession = (() => {
  const pending = new Set();
  function render(message) {
    const chatId = state.chat?.id, receipt = message.details?.nativeConflict;
    if (!chatId || state.chat.provider !== 'codex' || message.provider !== 'codex' ||
      message.role !== 'assistant' || message.status !== 'error' || receipt?.kind !== 'active-writer' ||
      receipt.delivery !== 'not-delivered' || receipt.recoverable === false || state.messages.at(-1)?.id !== message.id) return null;
    const busy = pending.has(chatId) || !!state.run || state.active.includes(chatId);
    const controls = el('div', { class: 'session-recovery-actions' });
    for (const [action, label] of [['retry', '重试连接'], ['independent', '在独立会话中继续']]) {
      const button = el('button', { type: 'button', disabled: busy, text: t(label) });
      button.onclick = async () => {
        if (pending.has(chatId) || state.chat?.id !== chatId || state.run || state.active.includes(chatId)) return;
        pending.add(chatId); renderMessages();
        try {
          await api('/chats/' + chatId + '/recover-session', 'POST', { messageId: message.id, action });
          if (state.chat?.id === chatId) await openChat(chatId);
        } catch (error) { toast(error.message); }
        finally { pending.delete(chatId); if (state.chat?.id === chatId) renderMessages(); }
      };
      controls.append(button);
    }
    return el('div', { class: 'session-recovery' }, [controls,
      el('small', { text: t('独立继续会交接已保存的聊天记录，沿用当前文件夹和权限；原窗口中的任务不会停止。') })]);
  }
  return { render };
})();

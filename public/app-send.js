'use strict';

// Sending: a new message, guidance for a running task, or a sentence the room takes (@ or 工作流);
// and stopping the running task.

// The server's answer to a send puts the user's message and the reply in place right away;
// the live stream keeps them current afterwards.
function acceptMessageResult(chatId, data) {
  if (state.chat?.id !== chatId || !data?.user || !data?.assistant) return;
  for (const row of [data.user, data.assistant]) {
    const index = state.messages.findIndex(message => message.id === row.id);
    if (index >= 0) {
      state.messages[index] = StarportLive.preferMessage(state.messages[index], row);
    } else {
      const before = row.role === 'user' ? state.messages.findIndex(message => message.id === data.assistant.id) : -1;
      state.messages.splice(before < 0 ? state.messages.length : before, 0, row);
    }
  }
  renderMessages();
}

let sendingMessage = false;
let stoppingRun = null;

// The first message of a new chat creates it, with the tool options chosen beforehand.
async function createDraftChat(text) {
  const sourceDraft = draftKey();
  const draftOptions = opts();
  const chat = await api('/chats', 'POST', {
    provider: state.selected,
    workspace: state.workspace,
    group_id: state.draftGroup
  });
  state.chat = chat;
  globalThis.StarportComposer?.moveDraft(sourceDraft, draftKey());
  localStorage.setItem(draftKey(), text);
  await queueSave({ options: draftOptions });
  localStorage.setItem('hub-chat', chat.id);
  localStorage.removeItem('hub-draft-new');
}

// metadata.replyTo: the text answers a question form; problems are thrown back to the form
// instead of shown in a toast. metadata.preserveDraft: keep what is in the composer.
async function sendMessage(text, metadata = {}) {
  const refuse = (message, values) => {
    if (metadata.replyTo) throw new Error(t(message, values));
    toast(message, values);
  };
  if (coverOpen || sendingMessage) {
    if (metadata.replyTo) throw new Error(t('正在提交…'));
    return;
  }
  let attachmentIds = metadata.replyTo ? [] : globalThis.StarportComposer?.ids() || [];
  const sourceDraft = draftKey();
  const originalInput = $('#prompt').value;
  if (!text.trim() && !attachmentIds.length) return;
  if (!metadata.replyTo && globalThis.StarportComposer?.busy) {
    toast('请等待附件添加完成');
    return;
  }
  if (globalThis.StarportPermissions?.busy) return refuse('正在保存权限，请稍候');
  if (!text.trim()) text = t('请查看这些附件。');
  const p = currentProvider();
  if (!p.installed) return refuse('尚未找到 {name}，请在连接与数据中配置程序。', { name: p.name });

  sendingMessage = true;
  $('#send').disabled = true;
  try {
    // A tool option still being edited is saved before the message goes out.
    const field = document.activeElement;
    if (field?.closest('#provider-options')) field.dispatchEvent(new Event('change'));
    const revision = viewRevision;
    await saveChain;
    // Reading video captions can take a while; give up if the chat or the input changed meanwhile.
    const unchanged = () =>
      revision === viewRevision && sourceDraft === draftKey() && originalInput === $('#prompt').value;
    if (!unchanged()) throw new Error(t('读取期间对话或输入已改变，请检查字幕附件后重新发送'));
    if (!metadata.replyTo) await globalThis.StarportComposer?.prepareVideos(text);
    if (!unchanged()) throw new Error(t('读取期间对话或输入已改变，请检查字幕附件后重新发送'));
    attachmentIds = metadata.replyTo ? [] : globalThis.StarportComposer?.ids() || [];
    if (!state.chat) await createDraftChat(text);

    // Replying to a run card sends that run's result along with the message.
    const chatId = state.chat.id;
    const sentDraft = draftKey();
    const runRef = metadata.replyTo ? null : globalThis.StarportWorkflows?.replyRef(chatId) || null;
    const accepted = await api('/chats/' + chatId + '/messages', 'POST', {
      text,
      attachments: attachmentIds,
      ...(metadata.replyTo ? { replyTo: metadata.replyTo } : {}),
      ...(runRef ? { runRef } : {})
    });
    if (runRef) StarportWorkflows.clearReply();
    if (!metadata.replyTo) {
      if (globalThis.StarportComposer?.consume) StarportComposer.consume(attachmentIds, sentDraft);
      else globalThis.StarportComposer?.clear(sentDraft);
    }
    if (!metadata.preserveDraft && state.chat?.id === chatId && $('#prompt').value === originalInput) {
      localStorage.removeItem(sentDraft);
      $('#prompt').value = '';
      resizePrompt();
    }
    acceptMessageResult(chatId, accepted);
    await liveSync?.reconcile();
    refresh().catch(error => toast(error.message));
    if (state.chat?.id === chatId) $('#conversation').scrollTop = $('#conversation').scrollHeight;
    return accepted;
  } catch (error) {
    if (metadata.replyTo) throw error;
    toast(error.message);
  } finally {
    sendingMessage = false;
    renderRun();
  }
}

// While a task runs, a message waits in the queue; an answer to the tool's question can go
// straight into the task when the tool accepts guidance (steer mode).
async function sendGuidance(text, metadata = {}) {
  if (coverOpen || sendingMessage) throw new Error(t('正在提交…'));
  const direct = !!metadata.replyTo && state.run?.inputMode === 'steer';
  if (!state.run || (direct && !state.run.inputReady)) {
    throw new Error(t('当前任务暂不接收补充消息；输入已保留，请稍后再试。'));
  }
  const attachmentIds = metadata.replyTo ? [] : globalThis.StarportComposer?.ids() || [];
  if (attachmentIds.length && !state.run.takesAttachments) throw new Error(t('运行中的补充消息暂仅支持文字，请先移除附件。'));
  if (attachmentIds.length && globalThis.StarportComposer?.busy) throw new Error(t('请等待附件添加完成'));
  if (typeof text === 'string' && !text.trim() && attachmentIds.length) text = t('请查看这些附件。');
  if (typeof text !== 'string' || !text.trim()) throw new Error(t('请输入问题的回答'));
  const chatId = state.chat.id;
  const runId = state.run.id;
  const key = draftKey();
  const originalInput = $('#prompt').value;
  sendingMessage = true;
  renderRun();
  try {
    const result = await api('/chats/' + chatId + (direct ? '/guidance' : '/queue'), 'POST', {
      text,
      runId,
      clientId: crypto.randomUUID(),
      ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
      ...(metadata.replyTo ? { replyTo: metadata.replyTo } : {})
    });
    if (['not-delivered', 'unconfirmed'].includes(result.delivery)) {
      throw new Error(result.user?.details?.error || t('未送达原工具'));
    }
    if (attachmentIds.length) globalThis.StarportComposer?.consume(attachmentIds, key);
    if (state.chat?.id === chatId) {
      liveSync?.receive({
        chatId,
        ...(result.user ? { message: result.user } : {}),
        ...(result.queue ? { queue: result.queue, queueVersion: result.queueVersion } : {})
      });
      if (!metadata.preserveDraft && $('#prompt').value === originalInput) {
        localStorage.removeItem(key);
        $('#prompt').value = '';
        resizePrompt();
      }
      renderMessages();
    }
    liveSync?.reconcile();
    return result;
  } finally {
    sendingMessage = false;
    renderRun();
  }
}

// What Enter or the send button does with the composer's text. An @mention of room companions,
// or the room's 工作流 mode, sends through the room instead (agents-room.js).
function sendInput() {
  if (globalThis.StarportAgentsRoom?.routeSend()) return Promise.resolve();
  const text = $('#prompt').value;
  if (state.run && !text.trim() && !(state.run.takesAttachments && globalThis.StarportComposer?.ids().length)) {
    return Promise.resolve();
  }
  return state.run ? sendGuidance(text) : sendMessage(text);
}

// The send button turns into a stop button while a task runs and the composer is empty.
async function stopCurrentRun() {
  const chatId = state.chat?.id;
  const runId = state.run?.id;
  if (!chatId || !runId || stoppingRun === runId) return;
  stoppingRun = runId;
  renderComposerAction();
  try {
    await api('/chats/' + chatId + '/stop', 'POST', {});
    await liveSync?.reconcile();
  } catch (error) {
    toast(error.message);
  } finally {
    if (stoppingRun === runId) stoppingRun = null;
    renderComposerAction();
  }
}

function resizePrompt() {
  const input = $('#prompt');
  input.style.height = 'auto';
  input.style.height = Math.min(230, input.scrollHeight) + 'px';
}

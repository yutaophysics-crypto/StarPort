import { isAbsolute, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { redact } from '../process.mjs';

function permitted(chat, link) {
  if (!chat || chat.options?.desk || !chat.workspace) return false;
  try {
    const path = realpathSync(chat.workspace);
    return link.workspaces.some(({ path: root }) => {
      try {
        const part = relative(realpathSync(root), path);
        return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
      } catch { return false; }
    });
  } catch {
    return false;
  }
}

const summary = (chat, running) => ({ id: chat.id, title: chat.title, provider: chat.provider, running, updated: chat.updated });
function promptView(request) {
  const params = request.params || {};
  const input = params.input || {};
  return {
    id: String(request.id), kind: request.kind === 'question' ? 'question' : 'permission',
    title: redact(request.title || params.toolName || request.method || '等待批准').slice(0, 200),
    detail: redact(String(params.command || input.command || input.file_path || '')).slice(0, 3000),
    questions: (params.questions || []).slice(0, 20).map(q => ({
      id: q.id, question: redact(q.question || '').slice(0, 1000), multiSelect: !!q.multiSelect,
      options: (q.options || []).slice(0, 20).map(option => ({ label: redact(option.label || '').slice(0, 300) })),
    })),
  };
}

export function mobileDesktop({ store, runner }) {
  return async (link, request) => {
    if (link.mobile !== true || request.caller !== link.user.id) throw Error('这台电脑未授权此手机账号');
    const { op, chatId, before, text, runId, requestId, decision, answers, id } = request.command;
    const groups = store.rooms();
    const visibleGroups = new Map(groups.map(group => [group.id, group.name]));
    const visible = chat => chat && (chat.group_id == null || visibleGroups.has(chat.group_id)) && permitted(chat, link);

    if (op === 'list') {
      return { chats: store.list().chats.filter(visible).slice(0, 300).map(chat => ({
        ...summary(chat, runner.active.has(chat.id)), group: visibleGroups.get(chat.group_id) || '',
      })) };
    }

    const chat = store.chat(chatId);
    if (!visible(chat)) throw Error('这个对话不在电脑允许手机访问的工作目录内');
    const run = runner.state(chatId);
    if (op === 'read') {
      const rows = store.mobileMessages(chatId, before);
      const active = runner.active.get(chatId)?.message;
      const latest = rows.slice(-40).map(row => {
        const item = active?.id === row.id ? active : row;
        const text = redact(item.content || '');
        return { id: item.id, role: item.role, provider: item.provider, status: item.status, created: item.created,
          content: text.slice(-12_000), truncated: text.length > 12_000,
          error: redact(item.details?.error || '').slice(0, 1600) };
      });
      return { chat: summary(chat, !!run), messages: latest, hasOlder: rows.length > latest.length,
        run: !before && run ? { id: run.id, approvals: run.approvals.map(promptView) } : null };
    }

    if (op === 'send') {
      const key = createHash('sha256').update(link.hubUrl + '\0' + link.user.id + '\0' + id).digest('hex');
      const previous = store.mobileSubmission(chatId, key);
      if (previous) {
        if (previous.content !== text) throw Error('该发送标识已用于其他消息');
        return { accepted: true };
      }
      await runner.start(chatId, text, [], { mobileSubmission: key });
      return { accepted: true };
    }

    if (!run || run.id !== runId) throw Error('这个任务已变更，请刷新对话');
    if (op === 'stop') {
      await runner.stop(chatId);
      return { stopped: true };
    }

    if (op === 'answer') {
      const prompt = run.approvals.find(item => String(item.id) === requestId);
      if (!prompt) throw Error('这个批准请求已结束');
      if (prompt.kind !== 'question' && (decision === 'skip' || answers !== undefined)) throw Error('批准选项无效');
      const normalized = { ...answers };
      if (run.provider === 'claude') {
        for (const question of prompt.params?.questions || []) {
          if (!question.multiSelect && Array.isArray(normalized[question.id])) normalized[question.id] = normalized[question.id].join('、');
        }
      }
      await runner.answer(chatId, requestId, { decision, ...answers ? { answers: normalized } : {} });
      return { answered: true };
    }
    throw Error('手机请求无效');
  };
}

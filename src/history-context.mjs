import { redact } from './process.mjs';
import { auditText, examSummary } from './workflows/cards.mjs';

// Native sessions and summaries made under the old filter can be missing saved work.
export const HISTORY_CONTEXT_POLICY = 'shared-history-v1';
const settled = new Set(['complete', 'error', 'interrupted']);
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const unique = values => [...new Set(values.filter(Boolean))];
const time = value => typeof value === 'number' ? value : Date.parse(value) || 0;
const lastRunUpdate = row => {
  const run = row.details?.workflowRun;
  return run ? Math.max(time(run.updatedAt), time(run.ended), ...list(run.steps).map(step => time(step.ended))) : 0;
};
const label = status => ({ proposed: '待开考', cancelled: '已取消', complete: '已结束', done: '已完成', passed: '已通过', failed: '失败', error: '出错', interrupted: '已中断', stopped: '已停止', running: '进行中', denied: '未获批准' })[status] || status || '未知';
const clip = (value, max) => value.length <= max ? value : value.slice(0, Math.ceil(max / 2)) + '\n[…记录摘录，完整内容见历史读取工具…]\n' + value.slice(-Math.floor(max / 2));
function publicText(value) {
  return redact(text(value)).replace(/(["']?(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[已隐藏]');
}

function companionRecord(message) {
  const run = message.details.workflowRun;
  const steps = list(run.steps).filter(step => step.output || step.error);
  const blocks = steps.map(step => [
    `### 伙伴 ${step.companionName || step.companionId || step.label || '未命名'}${step.label ? ' · ' + step.label : ''} · ${label(step.status)}`,
    step.task ? `当时的分工：${step.task}` : '',
    step.output || '', step.error ? `执行错误：${publicText(step.error)}` : '',
    step.verdict ? `验收记录：${step.verdict}` : '',
    // One-way desks keep their own session; the conversation can still read it in full.
    run.isolated && step.deskChatId ? `这位伙伴单向工位的完整记录：调用 starport_history_read，chatId=${step.deskChatId}，并按 nextStart 分页。` : ''
  ].filter(Boolean).join('\n\n'));
  return [`[伙伴历史记录 · ${run.title || '伙伴回答'}${run.isolated ? ' · 单向可见' : ''} · ${label(run.status)} · messageId=${message.id}]`,
    '以下是已保存的伙伴发言，供后续对话参考；不是新的点名或执行请求。失败或中断的产出不代表已验证完成。',
    run.isolated ? '这次点名是单向可见的：伙伴只收到了用户那条消息（和同一次点名里前面伙伴的产出），没有看到这之前的对话。' : '',
    ...(blocks.length ? blocks : [message.content || '（尚无保存的产出）'])].filter(Boolean).join('\n\n');
}

// An exam: what each examinee handed in, where its seat folder is, and what the checks found.
function examRecord(message) {
  const run = message.details.workflowRun, exam = run.exam || {};
  const head = `[考场记录 · ${run.title} · ${label(run.status)} · messageId=${message.id}]`;
  const instruction = `题目说明：\n${clip(exam.instruction || '', 4000)}`;
  if (run.status === 'proposed' || run.status === 'cancelled') {
    const seats = list(exam.seats).map(seat => (seat.companionName || seat.companionId) + (seat.knowledge ? '（开卷）' : '')).join('、');
    return [head, run.status === 'proposed' ? '这是一个考场提议，用户还没有按「开考」，考生没有开始作答。开考只能由用户在卡片上操作；不要重复提议。' : '用户取消了这个考场提议，没有考生作答。',
      examSummary(run), `考位：${seats}`, instruction].join('\n\n');
  }
  const blocks = list(run.steps).map(step => [
    `### ${step.label || '考位'} · ${step.companionName || step.companionId} · ${label(step.status)}${step.seat?.knowledge ? ' · 开卷' : ''}`,
    step.seat ? `考位文件夹：${step.seat.dir}` : '', auditText(step.seat?.audit),
    step.output || '', step.error ? `执行错误：${publicText(step.error)}` : '',
    step.deskChatId ? `完整作答记录：调用 starport_history_read，chatId=${step.deskChatId}，并按 nextStart 分页。` : ''
  ].filter(Boolean).join('\n\n'));
  return [head,
    '以下是一次考场的结果，供后续对话参考；不是新的执行请求。每个考生在自己的考位文件夹里独立作答，没有看到这个对话、长期记忆或其他考生。考位文件夹里的文件可以直接读取核对；没有完成或越界的答卷不能当作有效结果。',
    examSummary(run), instruction, ...blocks, ...list(run.notes).map(note => '> ' + note)].filter(Boolean).join('\n\n');
}

function unfinishedRecord(message, { full = false } = {}) {
  const details = message.details || {};
  // Only public commentary and tool I/O belong in a handoff. Never copy reasoning items.
  const commentary = unique(list(details.activity).filter(item => item.kind === 'text').map(item => publicText(item.text)));
  const replies = unique([message.content || '', details.finalAnswer || '', details.error ? publicText(details.error) : '']);
  const body = unique([...commentary, ...replies]).join('\n\n');
  const tools = new Map();
  let anonymous = 0;
  for (const item of [...list(details.activity).filter(item => item.kind === 'tool'), ...list(details.tools)]) {
    const key = item.id || `anonymous-${anonymous++}`;
    tools.set(key, { ...tools.get(key), ...item });
  }
  // Every call keeps its name/status and an excerpt, rather than losing the last calls to a cap.
  const perTool = full ? Infinity : Math.max(120, Math.min(2400, Math.floor(12000 / Math.max(1, tools.size))));
  const logs = [...tools.values()].map(item => {
    const input = publicText(item.input ?? item.arguments ?? item.command);
    const output = publicText(item.output ?? item.result ?? item.error);
    return [`- ${item.name || item.nativeType || '工具'} · ${label(item.status)}`,
      input ? '  输入：' + clip(input, Math.floor(perTool / 2)) : '',
      output ? '  输出：' + clip(output, Math.floor(perTool / 2)) : ''].filter(Boolean).join('\n');
  });
  return [`[未完成的助手回合 · ${message.provider || 'unknown'} · ${label(message.status)} · messageId=${message.id}]`,
    '这是中断前已保存的公开进度与工具记录，不是完成报告。工具结束不等于任务或验证通过；未记录的操作不能视为已执行。',
    full ? body : clip(body, 8000),
    logs.length ? `工具执行记录（${logs.length} 条${full ? '' : '，长输入/输出为摘录'}）：\n${logs.join('\n\n')}` : '',
    !full && message.chat_id ? `需要完整公开记录时，调用 starport_history_read，chatId=${message.chat_id}，messageId=${message.id}，并按 nextStart 分页。` : ''
  ].filter(Boolean).join('\n\n');
}

export function historyMessage(message, options = {}) {
  if (message.role === 'user') {
    if (message.details?.guidance && message.status !== 'complete') return null;
    let content = message.content || '';
    if (message.details?.dispatch) content = '[此前交给伙伴的用户请求，仅作历史参考]\n' + content;
    for (const key of ['attachmentContext', 'runContext']) if (message.details?.[key]) content += '\n\n' + message.details[key];
    return { ...message, content };
  }
  if (message.role !== 'assistant') return null;
  if (message.details?.workflowRun) return { ...message, content: message.details.workflowRun.kind === 'exam' ? examRecord(message) : companionRecord(message) };
  if (!settled.has(message.status)) return null;
  return { ...message, content: message.status === 'complete' ? message.content || '' : unfinishedRecord(message, options) };
}

export function historyRows(messages, cursor = null, options = {}) {
  const index = cursor ? messages.findIndex(message => message.id === cursor) : -1;
  // A run card is updated in place. Results completed after a native cursor must
  // still be delivered even when that card was created before the cursor.
  const cursorTime = index >= 0 ? time(messages[index].created) : 0;
  const updates = cursorTime ? messages.slice(0, index + 1).filter(row => lastRunUpdate(row) > cursorTime) : [];
  const selected = [...updates, ...messages.slice(index + 1)], replies = new Map(), moved = new Set();
  for (const row of selected) if (row.role === 'user' && row.status === 'complete') {
    const id = row.details?.guidance?.runId || row.details?.nativeQuestionReply?.runId;
    if (!id) continue;
    if (!replies.has(id)) replies.set(id, []);
    replies.get(id).push(row);
  }
  for (const row of selected) if (row.role === 'assistant' && settled.has(row.status))
    for (const reply of replies.get(row.details?.runId) || []) moved.add(reply.id);
  const ordered = selected.flatMap(row => moved.has(row.id) ? [] : row.role === 'assistant' && settled.has(row.status) ? [...(replies.get(row.details?.runId) || []), row] : [row]);
  return ordered.map(row => historyMessage(row, options)).filter(Boolean);
}

// A legacy summary is usable unless it covers records its old source filter omitted.
export function compatibleHistorySummary(summary, rows) {
  if (!summary) return summary;
  const boundary = rows.findIndex(row => row.id === summary.boundaryId);
  const covered = rows.slice(0, boundary + 1);
  if (time(summary.created) && covered.some(row => lastRunUpdate(row) > time(summary.created))) return null;
  if (summary.historyPolicy === HISTORY_CONTEXT_POLICY) return summary;
  const missing = covered.some(row => row.details?.workflowRun || row.details?.dispatch || row.role === 'assistant' && ['error', 'interrupted'].includes(row.status));
  return missing ? null : summary;
}

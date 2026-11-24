import { PROVIDERS } from './providers.mjs';
import { redact } from './process.mjs';
import { auditText, examSummary, planTable, runLabel } from './workflows/cards.mjs';

export const PROVIDER_INFO = {
  codex: { name: 'Codex', initials: 'CX', color: '#367a65' },
  claude: { name: 'Claude Code', initials: 'CL', color: '#b27354' },
  antigravity: { name: 'Antigravity', initials: 'AG', color: '#5078c9' },
  deepseek: { name: 'DeepSeek', initials: 'DS', color: '#5b68b5' },
  ollama: { name: 'Ollama', initials: 'OL', color: '#6f7378' }
};

const TEXT = {
  zh: {
    user: '用户',
    assistant: '助手',
    system: '系统',
    guidance: '补充引导',
    dispatchMain: '点名分工（主模型）',
    empty: '（暂无消息）',
    noOutput: '（无文字输出）',
    interrupted: '已中断',
    failed: '出错',
    errorPrefix: '错误：',
    attachments: '附件',
    examInstruction: '题目说明',
    examSeats: '考位',
    examOpenBook: '开卷',
    examSeatDir: '考位目录',
    companionSingleWay: '单向可见'
  },
  en: {
    user: 'User',
    assistant: 'Assistant',
    system: 'System',
    guidance: 'Guidance',
    dispatchMain: 'Assigned to main model',
    empty: '(No messages yet)',
    noOutput: '(No text output)',
    interrupted: 'Interrupted',
    failed: 'Error',
    errorPrefix: 'Error: ',
    attachments: 'Attachments',
    examInstruction: 'Instructions',
    examSeats: 'Seats',
    examOpenBook: 'open-book',
    examSeatDir: 'Seat folder',
    companionSingleWay: 'isolated'
  }
};

export function safeExportBasename(title) {
  return (
    String(title ?? '')
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
      .trim()
      .slice(0, 80) || 'conversation'
  );
}

export function markdownFilename(title) {
  return safeExportBasename(title) + '.md';
}

// Strips trailing ```starport-memory JSON blocks emitted by assistants, matching memory-protocol.js.
export function stripMemoryProtocol(value) {
  const text = String(value ?? '');
  const marker = /(?:^|\n)```starport-memory(?:\r?\n|$)/g;
  let match, last;
  while ((match = marker.exec(text))) last = match;
  if (!last) return text;
  const tail = text.slice(last.index + last[0].length);
  const end = tail.match(/\r?\n```[ \t]*(?=\r?\n|$)/);
  if (end && tail.slice(end.index + end[0].length).trim()) return text;
  return text.slice(0, last.index).trimEnd();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTimestamp(iso, { seconds = false } = {}) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso ?? '');
  const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? ':' + pad2(d.getSeconds()) : ''}`;
  return `${ymd} ${hm}`;
}

export function providerDisplayName(id, fallback = '助手') {
  if (!id) return fallback;
  return PROVIDER_INFO[id]?.name || PROVIDERS[id]?.name || id;
}

export function cleanLineBreaks(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

// Closes an unterminated fenced code block so an interrupted turn cannot swallow later turns.
export function closeUnclosedFence(text) {
  const lines = String(text ?? '').split('\n');
  let openChar = '', openLen = 0;
  for (const line of lines) {
    if (!openChar) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (m && (m[1][0] !== '`' || !m[2].includes('`'))) {
        openChar = m[1][0];
        openLen = m[1].length;
      }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1][0] === openChar && m[1].length >= openLen) {
        openChar = '';
        openLen = 0;
      }
    }
  }
  return openChar ? text + '\n' + openChar.repeat(openLen) : text;
}

// Places mid-run user guidance immediately before the settled assistant reply it belongs to.
export function orderMessages(messages) {
  const settled = row => row && ['complete', 'error', 'interrupted'].includes(row.status);
  const replies = new Map();
  const moved = new Set();
  for (const row of messages) {
    if (row.role !== 'user') continue;
    const runId = row.details?.guidance?.runId || row.details?.nativeQuestionReply?.runId;
    if (!runId) continue;
    if (!replies.has(runId)) replies.set(runId, []);
    replies.get(runId).push(row);
  }
  for (const row of messages) {
    if (row.role === 'assistant' && settled(row)) {
      for (const reply of replies.get(row.details?.runId) || []) moved.add(reply.id);
    }
  }
  return messages
    .flatMap(row =>
      moved.has(row.id)
        ? []
        : row.role === 'assistant' && settled(row)
          ? [...(replies.get(row.details?.runId) || []), row]
          : [row]
    )
    .filter(row => !(row.details?.nativeConflict?.delivery === 'not-delivered' && !row.content));
}

function formatPlainAttachments(attachments, tr) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const items = attachments
    .map(item => {
      if (!item?.name) return '';
      if (item.kind === 'web' && typeof item.path === 'string' && /^https?:\/\//i.test(item.path)) {
        return `[${String(item.name).replace(/[\[\]\r\n]/g, ' ').trim() || item.path}](${item.path})`;
      }
      return item.kind === 'folder' ? `${item.name.replace(/[/\\]+$/, '')}/` : item.name;
    })
    .filter(Boolean);
  return items.length ? `${tr.attachments}: ${items.join(', ')}` : '';
}

function formatPlainWorkflow(run, tr) {
  if (run.kind === 'exam') {
    const head = `${run.title || '考场'} (${runLabel(run.status)})`;
    const seats = ['proposed', 'cancelled'].includes(run.status)
      ? `${tr.examSeats}: ${(run.exam?.seats || []).map(s => (s.companionName || s.companionId) + (s.knowledge ? ` (${tr.examOpenBook})` : '')).join(', ')}`
      : '';
    const instruction = run.exam?.instruction ? `${tr.examInstruction}:\n${cleanLineBreaks(run.exam.instruction)}` : '';
    const steps = (run.steps || []).map(step => {
      const title = `### ${[step.companionName, step.label, step.seat?.knowledge ? tr.examOpenBook : ''].filter(Boolean).join(' · ')}`;
      const out = step.output
        ? closeUnclosedFence(cleanLineBreaks(stripMemoryProtocol(step.output)))
        : step.error
          ? `> ${tr.errorPrefix}${redact(step.error)}`
          : '';
      const meta = [
        step.seat?.dir ? `${tr.examSeatDir}: ${step.seat.dir}` : '',
        step.seat?.audit ? auditText(step.seat.audit) : ''
      ].filter(Boolean).join('\n');
      return [title, out, meta].filter(Boolean).join('\n\n');
    });
    const notes = (run.notes || []).map(note => `> ${cleanLineBreaks(note)}`);
    return [head, run.exam ? examSummary(run) : '', seats, instruction, ...steps, ...notes].filter(Boolean).join('\n\n');
  }
  const head = `${run.title || tr.assistant}${run.isolated ? ` (${tr.companionSingleWay})` : ''} · ${runLabel(run.status)}`;
  const table = run.plan?.rows?.length > 1 ? planTable(run.plan.rows) : '';
  const steps = (run.steps || []).map(step => {
    const suffix = [step.label, step.attempt ? `#${step.attempt + 1}` : ''].filter(Boolean).join(' · ');
    const title = `### ${step.companionName || step.companionId}${suffix ? ' · ' + suffix : ''}`;
    const out = step.output
      ? closeUnclosedFence(cleanLineBreaks(stripMemoryProtocol(step.output)))
      : step.error
        ? `> ${tr.errorPrefix}${redact(step.error)}`
        : '';
    return [title, out].filter(Boolean).join('\n\n');
  });
  const notes = (run.notes || []).map(note => `> ${cleanLineBreaks(note)}`);
  return [head, table, ...steps, ...notes].filter(Boolean).join('\n\n');
}

// Plain, unadorned Markdown meant for AI context consumption.
export function formatChatMarkdown(chat, messages, options = {}) {
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const tr = TEXT[lang];
  const title = cleanLineBreaks(chat.title) || 'Untitled';
  const ordered = orderMessages(Array.isArray(messages) ? messages : []);
  if (!ordered.length) return `# ${title}\n\n${tr.empty}\n`;

  const sections = ordered.map(msg => {
    const details = msg.details || {};
    const dispatchStep = msg.role === 'user' ? details.dispatchStep : null;
    const isGuidance = msg.role === 'user' && Boolean(details.guidance || details.nativeQuestionReply);
    const speaker = msg.role === 'user'
      ? dispatchStep
        ? tr.dispatchMain
        : isGuidance
          ? `${tr.user} (${tr.guidance})`
          : tr.user
      : msg.role === 'system'
        ? tr.system
        : details.workflowRun
          ? details.workflowRun.title || tr.assistant
          : providerDisplayName(msg.provider, tr.assistant);

    const stamp = formatTimestamp(msg.created);
    const status = msg.status === 'interrupted' ? ` · ${tr.interrupted}` : msg.status === 'error' && !details.error ? ` · ${tr.failed}` : '';
    const heading = `## ${speaker}${stamp ? ' · ' + stamp : ''}${status}`;

    let body = '';
    if (msg.role === 'user') {
      body = closeUnclosedFence(cleanLineBreaks(dispatchStep ? dispatchStep.task : msg.content));
    } else if (msg.role === 'system') {
      body = closeUnclosedFence(cleanLineBreaks(msg.content));
    } else if (details.workflowRun) {
      body = formatPlainWorkflow(details.workflowRun, tr);
    } else {
      let raw = stripMemoryProtocol(msg.content || '');
      if (!raw.trim() && typeof details.finalAnswer === 'string') raw = stripMemoryProtocol(details.finalAnswer);
      if (!raw.trim() && Array.isArray(details.activity)) {
        const notes = details.activity
          .filter(item => item?.kind === 'text' && typeof item.text === 'string' && item.text.trim())
          .map(item => stripMemoryProtocol(item.text.trim()));
        if (notes.length) raw = [...new Set(notes)].join('\n\n');
      }
      body = closeUnclosedFence(cleanLineBreaks(raw));
    }

    const attachments = formatPlainAttachments(details.attachments, tr);
    const err = details.error && !details.workflowRun ? `> ${tr.errorPrefix}${redact(String(details.error)).replace(/\r\n?/g, '\n')}` : '';
    const content = [body, attachments, err].filter(Boolean).join('\n\n') || (msg.status !== 'interrupted' ? tr.noOutput : '');
    return [heading, content].filter(Boolean).join('\n\n');
  });

  return `# ${title}\n\n${sections.join('\n\n')}\n`;
}

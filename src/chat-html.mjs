import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { redact } from './process.mjs';
import { auditText, examSummary, planTable, runLabel } from './workflows/cards.mjs';
import {
  PROVIDER_INFO,
  cleanLineBreaks,
  closeUnclosedFence,
  formatTimestamp,
  orderMessages,
  providerDisplayName,
  safeExportBasename,
  stripMemoryProtocol
} from './chat-markdown.mjs';

export const HTML_THEMES = ['sea', 'port', 'deep-space'];
export const DEFAULT_HTML_THEME = 'sea';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const THEME_META = {
  sea: { zh: '蔚蓝', en: 'Azure', color: '#0a1321' },
  port: { zh: '星港', en: 'Spaceport', color: '#05070c' },
  'deep-space': { zh: '深空', en: 'Deep Space', color: '#0c0f13' }
};

const ICONS = {
  sea: readFileSync(join(PUBLIC_DIR, 'icon.svg'), 'utf8').trim(),
  port: readFileSync(join(PUBLIC_DIR, 'assets', 'spaceport-icon.svg'), 'utf8').trim(),
  'deep-space': readFileSync(join(PUBLIC_DIR, 'assets', 'deep-space-icon.svg'), 'utf8').trim()
};

const TEXT = {
  zh: {
    you: '你',
    assistant: '助手',
    system: '系统',
    guidance: '补充引导',
    dispatchMain: '点名里交给主模型的部分',
    empty: '这段对话暂无消息。',
    noOutput: '（无文字输出）',
    interrupted: '已中断',
    failed: '出错',
    copy: '复制',
    copied: '已复制',
    copyFailed: '复制失败',
    themeLabel: '切换主题',
    messages: n => `${n} 条消息`,
    processSummary: (tools, subagents) => {
      const parts = [];
      if (tools) parts.push(`${tools} 步工具调用`);
      if (subagents) parts.push(`${subagents} 个子代理`);
      return `执行过程 · ${parts.join('，')}`;
    },
    subagent: '子代理',
    formulaError: '公式暂无法渲染，保留原文',
    formulaPending: '公式尚未完整',
    examInstruction: '题目说明',
    examSeats: '考位',
    examOpenBook: '开卷',
    examSeatDir: '考位文件夹',
    companionSingleWay: '单向可见',
    statusMap: {
      complete: '完成',
      done: '完成',
      passed: '通过',
      running: '进行中',
      pending: '等待中',
      interrupted: '已中断',
      stopped: '已停止',
      error: '出错',
      failed: '失败',
      denied: '未获批准'
    }
  },
  en: {
    you: 'You',
    assistant: 'Assistant',
    system: 'System',
    guidance: 'Guidance',
    dispatchMain: 'Part assigned to the main model',
    empty: 'No messages in this conversation yet.',
    noOutput: '(No text output)',
    interrupted: 'Interrupted',
    failed: 'Error',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Failed',
    themeLabel: 'Switch theme',
    messages: n => `${n} ${n === 1 ? 'message' : 'messages'}`,
    processSummary: (tools, subagents) => {
      const parts = [];
      if (tools) parts.push(`${tools} tool ${tools === 1 ? 'call' : 'calls'}`);
      if (subagents) parts.push(`${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`);
      return `Activity · ${parts.join(', ')}`;
    },
    subagent: 'Subagent',
    formulaError: 'Formula could not be rendered',
    formulaPending: 'Incomplete formula',
    examInstruction: 'Instructions',
    examSeats: 'Seats',
    examOpenBook: 'open-book',
    examSeatDir: 'Seat folder',
    companionSingleWay: 'isolated',
    statusMap: {
      complete: 'done',
      done: 'done',
      passed: 'passed',
      running: 'running',
      pending: 'pending',
      interrupted: 'interrupted',
      stopped: 'stopped',
      error: 'error',
      failed: 'failed',
      denied: 'denied'
    }
  }
};

export function resolveHtmlTheme(value) {
  if (value == null || value === '') return DEFAULT_HTML_THEME;
  if (typeof value === 'string' && HTML_THEMES.includes(value)) return value;
  throw Object.assign(new Error('导出主题无效'), { status: 400 });
}

export function htmlFilename(title) {
  return safeExportBasename(title) + '.html';
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

let markdownRuntime = null;
function getMarkdownRuntime() {
  if (markdownRuntime) return markdownRuntime;
  const ctx = { console };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.self = ctx;
  createContext(ctx);
  for (const rel of ['vendor/marked.min.js', 'vendor/katex.min.js', 'markdown.js']) {
    runInContext(readFileSync(join(PUBLIC_DIR, rel), 'utf8'), ctx, { filename: rel });
  }
  markdownRuntime = { marked: ctx.marked, katex: ctx.katex, protect: ctx.StarportMarkdown.protect };
  return markdownRuntime;
}

let inlinedKatexCss = null;
function getSelfContainedKatexCss() {
  if (inlinedKatexCss !== null) return inlinedKatexCss;
  const raw = readFileSync(join(PUBLIC_DIR, 'vendor', 'katex.min.css'), 'utf8');
  inlinedKatexCss = raw.replace(/url\(\/vendor\/katex-fonts\/([\w.-]+\.woff2)\)/g, (full, file) => {
    try {
      const b64 = readFileSync(join(PUBLIC_DIR, 'vendor', 'katex-fonts', file)).toString('base64');
      return `url("data:font/woff2;base64,${b64}")`;
    } catch {
      return full;
    }
  });
  return inlinedKatexCss;
}

const COPY_ICON = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

function safeHref(href) {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return null;
}

export function renderSafeMarkdown(source, tr) {
  const { marked, katex, protect } = getMarkdownRuntime();
  const protectedText = protect(closeUnclosedFence(String(source ?? '')));
  const { math, prefix, suffix } = protectedText;
  const pattern = new RegExp(prefix + '(\\d+)' + suffix, 'g');
  const restoreRaw = text => text.replace(pattern, (_, index) => escapeHtml(math[Number(index)]?.raw || ''));

  const renderMath = token => {
    const entry = math[token.index];
    if (!entry) return '';
    if (!entry.pending) {
      try {
        return katex.renderToString(entry.tex, {
          displayMode: entry.display,
          throwOnError: true,
          trust: false,
          strict: 'ignore',
          maxExpand: 1000,
          maxSize: 50
        });
      } catch {}
    }
    const cls = 'math-source ' + (entry.display ? 'math-block ' : '') + (entry.pending ? 'math-pending' : 'math-error');
    const title = entry.pending ? tr.formulaPending : tr.formulaError;
    return `<code class="${cls}" title="${escapeHtml(title)}">${escapeHtml(entry.raw)}</code>`;
  };

  const renderer = new marked.Renderer();
  renderer.html = token => escapeHtml(token.raw ?? token.text ?? '');
  renderer.image = token => escapeHtml(token.raw ?? token.text ?? '');
  renderer.link = function (token) {
    const label = this.parser.parseInline(token.tokens);
    const url = safeHref(token.href);
    if (!url) return `<span class="local-file-link">${label}</span>`;
    const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">${label}</a>`;
  };
  renderer.code = function (token) {
    const langClass = token.lang ? ` class="language-${escapeHtml(token.lang.split(/\s+/)[0])}"` : '';
    const code = restoreRaw(escapeHtml(token.text || ''));
    return `<div class="code-box"><pre><code${langClass}>${code}</code></pre><button type="button" class="code-copy" data-copy-code>${COPY_ICON}<span>${escapeHtml(tr.copy)}</span></button></div>\n`;
  };

  const parser = new marked.Marked({
    renderer,
    extensions: [
      {
        name: 'protectedMath',
        level: 'inline',
        start: src => src.indexOf(prefix),
        tokenizer(src) {
          if (!src.startsWith(prefix)) return;
          const end = src.indexOf(suffix, prefix.length);
          const index = Number(src.slice(prefix.length, end));
          if (end < 0 || !Number.isInteger(index) || !math[index]) return;
          return { type: 'protectedMath', raw: src.slice(0, end + suffix.length), index };
        },
        renderer: renderMath
      }
    ]
  });

  return restoreRaw(parser.parse(protectedText.text));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function datePart(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function shortTime(iso, baseDate) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return baseDate && ymd === baseDate ? hm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

function clipText(value, max = 280) {
  const clean = redact(String(value ?? '')).trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function renderAttachmentsHtml(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const chips = attachments
    .map(item => {
      if (!item?.name) return '';
      const label = item.kind === 'folder' ? `${item.name.replace(/[/\\]+$/, '')}/` : item.name;
      const url = item.kind === 'web' ? safeHref(item.path) : null;
      if (url) {
        return `<a class="attachment-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${FILE_ICON}<span>${escapeHtml(label)}</span></a>`;
      }
      return `<span class="attachment-chip">${FILE_ICON}<span>${escapeHtml(label)}</span></span>`;
    })
    .filter(Boolean);
  return chips.length ? `<div class="attachment-list">${chips.join('')}</div>` : '';
}

function renderToolsDetailsHtml(msg, tr) {
  const details = msg.details || {};
  if (details.workflowRun) return '';
  const toolMap = new Map();
  let anon = 0;
  for (const item of [
    ...(Array.isArray(details.activity) ? details.activity.filter(a => a?.kind === 'tool') : []),
    ...(Array.isArray(details.tools) ? details.tools : [])
  ]) {
    if (!item || typeof item !== 'object') continue;
    const key = item.id || `tool-${anon++}`;
    toolMap.set(key, { ...toolMap.get(key), ...item });
  }
  const subagents = Array.isArray(details.subagents) ? details.subagents.filter(s => s && typeof s === 'object') : [];
  if (!toolMap.size && !subagents.length) return '';

  const rows = [];
  for (const item of toolMap.values()) {
    const name = item.title || item.name || item.nativeType || 'Tool';
    const status = tr.statusMap[item.status] || item.status || '';
    const rawInput = item.input ?? item.command ?? item.arguments ?? '';
    const inputText = typeof rawInput === 'string' ? clipText(rawInput, 360) : rawInput ? clipText(JSON.stringify(rawInput), 360) : '';
    rows.push(
      `<div class="tool-row"><div class="tool-head"><span class="tool-glyph">›</span><span class="tool-name">${escapeHtml(name)}</span>${status ? `<span class="tool-status">${escapeHtml(status)}</span>` : ''}</div>${inputText ? `<pre>${escapeHtml(inputText)}</pre>` : ''}</div>`
    );
  }
  for (const sub of subagents) {
    const role = sub.role || sub.title || sub.name || sub.id || 'agent';
    const status = tr.statusMap[sub.status] || sub.status || '';
    rows.push(
      `<div class="tool-row"><div class="tool-head"><span class="tool-glyph">◈</span><span class="tool-name">${escapeHtml(tr.subagent + ' · ' + role)}</span>${status ? `<span class="tool-status">${escapeHtml(status)}</span>` : ''}</div></div>`
    );
  }
  return `<details class="message-tools"><summary>${escapeHtml(tr.processSummary(toolMap.size, subagents.length))}</summary>${rows.join('')}</details>`;
}

function renderWorkflowCardHtml(run, timeText, tr) {
  const status = runLabel(run.status);
  const subtitleParts = [run.isolated ? tr.companionSingleWay : '', status].filter(Boolean);
  const blocks = [];

  if (run.kind === 'exam') {
    if (run.exam) {
      blocks.push(`<div class="wf-meta-box">${escapeHtml(examSummary(run))}</div>`);
    }
    if (['proposed', 'cancelled'].includes(run.status) && run.exam?.seats?.length) {
      const seats = run.exam.seats
        .map(s => (s.companionName || s.companionId) + (s.knowledge ? `（${tr.examOpenBook}）` : ''))
        .join('、');
      blocks.push(`<p class="wf-note">${escapeHtml(`${tr.examSeats}：${seats}`)}</p>`);
    }
    if (run.exam?.instruction) {
      blocks.push(
        `<div class="wf-section"><div class="wf-section-label">${escapeHtml(tr.examInstruction)}</div><div class="message-body">${renderSafeMarkdown(run.exam.instruction, tr)}</div></div>`
      );
    }
    for (const step of run.steps || []) {
      const stepMeta = [step.label, step.seat?.knowledge ? tr.examOpenBook : ''].filter(Boolean).join(' · ');
      const outHtml = step.output
        ? `<div class="message-body wf-step-output">${renderSafeMarkdown(stripMemoryProtocol(step.output), tr)}</div>`
        : step.error
          ? `<p class="error-note">${escapeHtml(redact(step.error))}</p>`
          : '';
      const audit = [
        step.seat?.dir ? `${tr.examSeatDir}：${step.seat.dir}` : '',
        step.seat?.audit ? auditText(step.seat.audit) : ''
      ].filter(Boolean).join('\n');
      blocks.push(
        `<section class="wf-step"><header class="wf-step-head">${step.avatar ? `<span class="wf-avatar">${escapeHtml(step.avatar)}</span>` : ''}<strong>${escapeHtml(step.companionName || step.companionId || '')}</strong>${stepMeta ? `<span class="wf-step-meta">${escapeHtml(stepMeta)}</span>` : ''}</header>${outHtml}${audit ? `<pre class="wf-audit">${escapeHtml(audit)}</pre>` : ''}</section>`
      );
    }
  } else {
    if (run.plan?.rows?.length > 1) {
      blocks.push(`<div class="message-body">${renderSafeMarkdown(planTable(run.plan.rows), tr)}</div>`);
    }
    for (const step of run.steps || []) {
      const stepMeta = [step.label, step.attempt ? `#${step.attempt + 1}` : ''].filter(Boolean).join(' · ');
      const outHtml = step.output
        ? `<div class="message-body wf-step-output">${renderSafeMarkdown(stripMemoryProtocol(step.output), tr)}</div>`
        : step.error
          ? `<p class="error-note">${escapeHtml(redact(step.error))}</p>`
          : '';
      blocks.push(
        `<section class="wf-step"><header class="wf-step-head">${step.avatar ? `<span class="wf-avatar">${escapeHtml(step.avatar)}</span>` : ''}<strong>${escapeHtml(step.companionName || step.companionId || '')}</strong>${stepMeta ? `<span class="wf-step-meta">${escapeHtml(stepMeta)}</span>` : ''}</header>${outHtml}</section>`
      );
    }
  }

  for (const note of run.notes || []) {
    blocks.push(`<p class="notice">${escapeHtml(note)}</p>`);
  }

  return `<article class="message assistant workflow-run"><div class="wf-card"><header class="wf-card-head"><span class="provider-mark wf-mark">◈</span><strong>${escapeHtml(run.title || tr.assistant)}</strong><span class="wf-status">${escapeHtml(subtitleParts.join(' · '))}</span>${timeText ? `<time>${escapeHtml(timeText)}</time>` : ''}</header>${blocks.join('')}</div></article>`;
}

function renderMessageHtml(msg, { baseDate, tr }) {
  const details = msg.details || {};
  const timeText = shortTime(msg.created, baseDate);
  const fullStamp = formatTimestamp(msg.created, { seconds: true });
  const timeHtml = timeText ? `<time title="${escapeHtml(fullStamp)}">${escapeHtml(timeText)}</time>` : '';

  if (details.workflowRun) {
    return renderWorkflowCardHtml(details.workflowRun, timeText, tr);
  }

  if (msg.role === 'user') {
    const dispatchStep = details.dispatchStep;
    const isGuidance = Boolean(details.guidance || details.nativeQuestionReply);
    const markText = dispatchStep ? '@' : tr.you;
    const speaker = dispatchStep ? tr.dispatchMain : isGuidance ? `${tr.you} · ${tr.guidance}` : tr.you;
    const text = cleanLineBreaks(dispatchStep ? dispatchStep.task : msg.content);
    const attachments = renderAttachmentsHtml(details.attachments);
    return `<article class="message user"><div class="message-header"><span class="provider-mark user-mark">${escapeHtml(markText)}</span><strong>${escapeHtml(speaker)}</strong>${timeHtml}</div>${text ? `<div class="message-body">${escapeHtml(text)}</div>` : ''}${attachments}</article>`;
  }

  const pInfo = PROVIDER_INFO[msg.provider] || {
    name: providerDisplayName(msg.provider, msg.role === 'system' ? tr.system : tr.assistant),
    initials: msg.role === 'system' ? 'SYS' : 'AI',
    color: '#315d50'
  };
  const statusBadge = msg.status === 'interrupted'
    ? `<span class="msg-badge">${escapeHtml(tr.interrupted)}</span>`
    : msg.status === 'error' && !details.error
      ? `<span class="msg-badge error">${escapeHtml(tr.failed)}</span>`
      : '';
  const modelNote = typeof details.model === 'string' && details.model.trim()
    ? `<span class="msg-model">${escapeHtml(details.model.trim())}</span>`
    : '';

  let raw = stripMemoryProtocol(msg.content || '');
  if (!raw.trim() && typeof details.finalAnswer === 'string') raw = stripMemoryProtocol(details.finalAnswer);
  if (!raw.trim() && Array.isArray(details.activity)) {
    const notes = details.activity
      .filter(item => item?.kind === 'text' && typeof item.text === 'string' && item.text.trim())
      .map(item => stripMemoryProtocol(item.text.trim()));
    if (notes.length) raw = [...new Set(notes)].join('\n\n');
  }

  const toolsHtml = renderToolsDetailsHtml(msg, tr);
  const bodyHtml = raw.trim()
    ? `<div class="message-body">${renderSafeMarkdown(raw, tr)}</div>`
    : !details.error && msg.status !== 'interrupted'
      ? `<div class="message-body muted-empty">${escapeHtml(tr.noOutput)}</div>`
      : '';
  const errorHtml = details.error ? `<p class="error-note">${escapeHtml(redact(String(details.error)))}</p>` : '';
  const attachments = renderAttachmentsHtml(details.attachments);

  return `<article class="message assistant"><div class="message-header"><span class="provider-mark" style="--provider-color:${escapeHtml(pInfo.color)}">${escapeHtml(pInfo.initials)}</span><strong>${escapeHtml(pInfo.name)}</strong>${modelNote}${statusBadge}${timeHtml}</div>${toolsHtml}${bodyHtml}${errorHtml}${attachments}</article>`;
}

const EXPORT_STYLES = `
*, *::before, *::after { box-sizing: border-box; }
:root, html[data-theme="sea"] {
  color-scheme: dark;
  --bg: #080f1b;
  --canvas: radial-gradient(ellipse 90% 50% at 50% -12%, #19385866, transparent 70%),
            radial-gradient(ellipse 65% 42% at 88% 100%, #112b464d, transparent 65%), #091322;
  --topbar-bg: #091322d6;
  --panel: #0b1422;
  --paper: #101e30;
  --field: #0e1c2d;
  --hover: #172b40;
  --ink: #e6eef8;
  --body-ink: #dde7f5;
  --heading-ink: #edf4fc;
  --muted: #9caec5;
  --time-ink: #95aac4;
  --line: #26384c;
  --accent: #a0d4f3;
  --user-bg: #152940ed;
  --user-border: #2b435e;
  --user-radius: 12px;
  --user-shadow: none;
  --pre-bg: #091522;
  --pre-border: #30465e;
  --pre-ink: #d3e8fc;
  --pre-radius: 8px;
  --code-bg: #20364c;
  --code-ink: #d0e9fc;
  --th-bg: #15283e;
  --quote-border: #729fbf;
  --quote-ink: #b3c9df;
  --mark-bg: #234057;
  --mark-ink: #caeaff;
  --mark-border: #c0e6ff1f;
  --mark-radius: 6px;
  --tools-bg: #0d1c2c66;
  --tools-border: #263e54;
  --tools-radius: 10px;
  --tools-summary: #9fc4df;
  --notice-bg: #342b1d;
  --notice-ink: #edcea0;
  --error-bg: #382326;
  --error-ink: #f2b5b1;
  --sans: Archivo, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --mono: 'Cascadia Mono', 'Cascadia Code', Consolas, ui-monospace, monospace;
  --body-size: 14.5px;
  --body-lh: 1.9;
}

html[data-theme="port"] {
  color-scheme: dark;
  --bg: #05070c;
  --canvas: linear-gradient(90deg, #5fd8ff09 1px, transparent 1px) 0 0 / 56px 56px,
            linear-gradient(#5fd8ff09 1px, transparent 1px) 0 0 / 56px 56px, #03050a;
  --topbar-bg: #060910e6;
  --panel: #080c12;
  --paper: #0b1018;
  --field: #070b11;
  --hover: #0f1620;
  --ink: #e3ecf2;
  --body-ink: #dbe5ec;
  --heading-ink: #eff8fc;
  --muted: #8a9bab;
  --time-ink: #647a8c;
  --line: #1c2632;
  --accent: #5fd8ff;
  --user-bg: #0a1018eb;
  --user-border: #1f2b38;
  --user-radius: 3px;
  --user-shadow: inset 2px 0 #5fd8ff99;
  --pre-bg: #04070bf0;
  --pre-border: #1a2430;
  --pre-ink: #cfe6f2;
  --pre-radius: 3px;
  --code-bg: #5fd8ff14;
  --code-ink: #bfeeff;
  --th-bg: #0d141d;
  --quote-border: #5fd8ff80;
  --quote-ink: #a9bccb;
  --mark-bg: #0e222d;
  --mark-ink: #bfe9f7;
  --mark-border: #5fd8ff45;
  --mark-radius: 3px;
  --tools-bg: #05080dc0;
  --tools-border: #1a2430;
  --tools-radius: 3px;
  --tools-summary: #7fd0ea;
  --notice-bg: #ffb34714;
  --notice-ink: #ffd59a;
  --error-bg: #ff6b5a14;
  --error-ink: #ffb1a8;
  --hud:
    linear-gradient(#5fd8ff66, #5fd8ff66) left top / 9px 1px no-repeat,
    linear-gradient(#5fd8ff66, #5fd8ff66) left top / 1px 9px no-repeat,
    linear-gradient(#5fd8ff66, #5fd8ff66) right top / 9px 1px no-repeat,
    linear-gradient(#5fd8ff66, #5fd8ff66) right top / 1px 9px no-repeat,
    linear-gradient(#5fd8ff66, #5fd8ff66) left bottom / 9px 1px no-repeat,
    linear-gradient(#5fd8ff66, #5fd8ff66) left bottom / 1px 9px no-repeat,
    linear-gradient(#5fd8ff66, #5fd8ff66) right bottom / 9px 1px no-repeat,
    linear-gradient(#5fd8ff66, #5fd8ff66) right bottom / 1px 9px no-repeat;
}

html[data-theme="deep-space"] {
  color-scheme: dark;
  --bg: #0c0f13;
  --canvas: radial-gradient(ellipse 85% 48% at 64% -8%, #2e251a40, transparent 70%), #0c0f13;
  --topbar-bg: #0e1217e0;
  --panel: #12161b;
  --paper: #171c22;
  --field: #101419;
  --hover: #1f252d;
  --ink: #eeeee9;
  --body-ink: #e1e4e8;
  --heading-ink: #f0eee8;
  --muted: #a1a8b1;
  --time-ink: #9aa6b6;
  --line: #2b3139;
  --accent: #dfb87d;
  --user-bg: #1c232ced;
  --user-border: #323e4d;
  --user-radius: 10px;
  --user-shadow: none;
  --pre-bg: #10161e;
  --pre-border: #303d4d;
  --pre-ink: #dce3ed;
  --pre-radius: 8px;
  --code-bg: #2b2c2d;
  --code-ink: #e4d7bf;
  --th-bg: #1c2632;
  --quote-border: #9a815d;
  --quote-ink: #b3becc;
  --mark-bg: #202730;
  --mark-ink: #d2d8df;
  --mark-border: #59647142;
  --mark-radius: 7px;
  --tools-bg: #141b24;
  --tools-border: #313c4a;
  --tools-radius: 8px;
  --tools-summary: #dfc8a7;
  --notice-bg: #342b1f;
  --notice-ink: #eed3a9;
  --error-bg: #342428;
  --error-ink: #efb9b1;
  --body-size: 15px;
  --body-lh: 1.95;
}

* { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--muted) 35%, transparent) transparent; }
body {
  margin: 0;
  min-height: 100dvh;
  background: var(--canvas);
  background-attachment: fixed;
  color: var(--ink);
  font-family: var(--sans);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-underline-offset: 3px; }
html[data-theme="deep-space"] .message-body a { color: #e5c596; }
button { font: inherit; color: inherit; background: transparent; border: 0; cursor: pointer; }
button:focus-visible, a:focus-visible, summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.export-topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--topbar-bg);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.export-topbar-inner {
  max-width: 880px;
  margin: 0 auto;
  padding: 14px clamp(18px, 4vw, 30px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.export-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.theme-emblem {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
}
.theme-emblem svg { width: 100%; height: 100%; display: none; }
html[data-theme="sea"] .theme-emblem svg[data-emblem="sea"],
html[data-theme="port"] .theme-emblem svg[data-emblem="port"],
html[data-theme="deep-space"] .theme-emblem svg[data-emblem="deep-space"] { display: block; }

.export-titles { min-width: 0; }
.export-titles h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--heading-ink);
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.export-meta {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.4;
}
html[data-theme="port"] .export-meta { font-family: var(--mono); font-size: 11px; }

.theme-switcher {
  flex: none;
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--field);
}
html[data-theme="port"] .theme-switcher { border-radius: 3px; }
.theme-switcher button {
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--muted);
  transition: color .15s, background-color .15s;
}
html[data-theme="port"] .theme-switcher button { border-radius: 2px; }
.theme-switcher button:hover { color: var(--ink); }
.theme-switcher button[aria-pressed="true"] {
  color: var(--ink);
  background: color-mix(in srgb, var(--accent) 16%, var(--paper));
  font-weight: 500;
}

.conversation {
  max-width: 880px;
  margin: 0 auto;
  padding: 34px clamp(18px, 4vw, 30px) 72px;
}
.message {
  max-width: 820px;
  margin: 0 auto 30px;
}
.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 11px;
  color: var(--muted);
  font-size: 11px;
}
.provider-mark {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-grid;
  place-items: center;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: .3px;
  background: color-mix(in srgb, var(--provider-color, var(--accent)) 22%, var(--mark-bg));
  color: var(--mark-ink);
  border: 1px solid color-mix(in srgb, var(--provider-color, var(--accent)) 36%, var(--mark-border));
  border-radius: var(--mark-radius);
}
.provider-mark.user-mark {
  background: var(--mark-bg);
  border-color: var(--mark-border);
}
html[data-theme="port"] .provider-mark { font-family: var(--mono); }
.message-header strong {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink);
}
html[data-theme="port"] .message-header strong { color: #bfe9f7; }
.msg-model {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
  opacity: .82;
}
.msg-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--line);
  color: var(--muted);
}
.msg-badge.error { color: var(--error-ink); border-color: color-mix(in srgb, var(--error-ink) 40%, var(--line)); }
.message-header time {
  margin-left: auto;
  font-size: 11px;
  color: var(--time-ink);
}
html[data-theme="port"] .message-header time { font-family: var(--mono); font-size: 10.5px; }

.message-body {
  color: var(--body-ink);
  font-size: var(--body-size);
  line-height: var(--body-lh);
  overflow-wrap: anywhere;
}
.message.user .message-body {
  background: var(--user-bg);
  border: 1px solid var(--user-border);
  border-radius: var(--user-radius);
  box-shadow: var(--user-shadow);
  padding: 14px 18px;
  white-space: pre-wrap;
  line-height: 1.82;
}
.message-body.muted-empty { color: var(--muted); font-style: italic; }
.message-body p { margin: 0 0 14px; }
.message-body p:last-child { margin-bottom: 0; }
.message-body h1, .message-body h2, .message-body h3, .message-body h4 {
  color: var(--heading-ink);
  font-family: var(--sans);
  line-height: 1.5;
  margin: 22px 0 10px;
}
.message-body > :first-child { margin-top: 0; }
.message-body h1 { font-size: 20px; }
.message-body h2 { font-size: 18px; }
.message-body h3 { font-size: 15.5px; }
.message-body h4 { font-size: 14.5px; }
.message-body ul, .message-body ol { padding-left: 24px; margin: 0 0 14px; }
.message-body li + li { margin-top: 4px; }
.message-body hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
.message-body blockquote {
  margin: 0 0 14px;
  padding: 2px 0 2px 15px;
  border-left: 2px solid var(--quote-border);
  color: var(--quote-ink);
}
.message-body pre {
  margin: 0;
  overflow: auto;
  background: var(--pre-bg);
  border: 1px solid var(--pre-border);
  border-radius: var(--pre-radius);
  color: var(--pre-ink);
  padding: 14px 16px;
  line-height: 1.62;
  font-size: 12.5px;
}
.message-body code {
  font-family: var(--mono);
  font-size: 0.88em;
  background: var(--code-bg);
  color: var(--code-ink);
  padding: 2px 5px;
  border-radius: 3px;
}
.message-body pre code {
  padding: 0;
  background: none;
  color: inherit;
  font-size: inherit;
}
.code-box {
  position: relative;
  margin: 0 0 14px;
}
.code-box:last-child { margin-bottom: 0; }
.code-copy {
  position: absolute;
  top: 7px;
  right: 7px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--paper);
  color: var(--muted);
  font-size: 11px;
  line-height: 18px;
  opacity: 0;
  transition: opacity .15s, color .15s;
}
.code-box:hover .code-copy,
.code-copy:focus-visible,
.code-copy[data-state="done"] { opacity: 1; }
.code-copy:hover, .code-copy[data-state="done"] { color: var(--accent); }
@media (hover: none) { .code-copy { opacity: 1; } }

.message-body table {
  border-collapse: collapse;
  display: block;
  overflow: auto;
  max-width: 100%;
  margin: 0 0 14px;
  font-size: 13px;
}
.message-body th, .message-body td {
  border: 1px solid var(--line);
  padding: 8px 12px;
  text-align: left;
}
.message-body th { background: var(--th-bg); color: var(--heading-ink); font-weight: 500; }
.message-body .local-file-link {
  color: var(--accent);
  border-bottom: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
}
.message-body .katex-display {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 2px;
}
.message-body .katex-display > .katex {
  display: block;
  width: max-content;
  min-width: 100%;
  text-align: center;
}
.message-body .math-source {
  color: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.message-body .math-source.math-block {
  display: block;
  padding: 12px;
  margin: 12px 0;
}

.message-tools {
  margin: 0 0 12px;
  padding: 7px 12px;
  border: 1px solid var(--tools-border);
  border-radius: var(--tools-radius);
  background: var(--tools-bg);
  color: var(--muted);
  font-size: 12px;
}
.message-tools summary {
  cursor: pointer;
  color: var(--tools-summary);
  user-select: none;
}
.tool-row {
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.tool-glyph { color: var(--accent); font-family: var(--mono); }
.tool-name { font-weight: 600; color: var(--ink); font-family: var(--mono); font-size: 11.5px; }
.tool-status { color: var(--muted); font-size: 11px; }
.tool-row pre {
  margin: 6px 0 0 16px;
  padding: 6px 9px;
  background: var(--pre-bg);
  border: 1px solid var(--pre-border);
  border-radius: 5px;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--paper);
  color: var(--ink);
  font-size: 11.5px;
  text-decoration: none;
}
html[data-theme="port"] .attachment-chip { border-radius: 3px; }
a.attachment-chip:hover { border-color: var(--accent); color: var(--accent); }

.wf-card {
  border: 1px solid var(--line);
  border-radius: var(--user-radius);
  background: color-mix(in srgb, var(--paper) 78%, transparent);
  padding: 14px 18px;
}
html[data-theme="port"] .wf-card { background: var(--hud), #080d14e6; }
.wf-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.wf-card-head strong { font-size: 13px; color: var(--heading-ink); }
.wf-status { font-size: 11.5px; color: var(--muted); }
.wf-card-head time { margin-left: auto; font-size: 11px; color: var(--time-ink); }
.wf-meta-box, .wf-audit {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--field);
  color: var(--muted);
  font-size: 12px;
  white-space: pre-wrap;
  font-family: var(--sans);
}
.wf-step {
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid var(--line);
}
.wf-step:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.wf-step-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
  font-size: 12.5px;
}
.wf-avatar { font-size: 14px; }
.wf-step-meta { color: var(--muted); font-size: 11.5px; }
.wf-section { margin-bottom: 12px; }
.wf-section-label { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }

.notice, .error-note {
  margin: 10px 0 0;
  padding: 9px 12px;
  border-radius: 6px;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.notice { background: var(--notice-bg); color: var(--notice-ink); }
.error-note { background: var(--error-bg); color: var(--error-ink); }

@media (max-width: 620px) {
  .export-topbar-inner { flex-wrap: wrap; }
  .theme-switcher { margin-left: auto; }
}

@media print {
  :root, html[data-theme] {
    color-scheme: light;
    --canvas: #fff;
    --ink: #161b22;
    --body-ink: #1f2328;
    --heading-ink: #0d1117;
    --muted: #57606a;
    --time-ink: #6e7781;
    --line: #d0d7de;
    --accent: #0969da;
    --user-bg: #f6f8fa;
    --user-border: #d0d7de;
    --user-shadow: none;
    --pre-bg: #f6f8fa;
    --pre-border: #d0d7de;
    --pre-ink: #1f2328;
    --code-bg: #eff1f3;
    --code-ink: #1f2328;
    --th-bg: #f6f8fa;
    --quote-border: #8c959f;
    --quote-ink: #57606a;
    --paper: #f6f8fa;
    --field: #f6f8fa;
    --tools-bg: #f6f8fa;
    --tools-border: #d0d7de;
    --tools-summary: #24292f;
  }
  .export-topbar { position: static; background: none; backdrop-filter: none; }
  .theme-switcher, .code-copy { display: none !important; }
  .conversation { padding-top: 18px; }
}
`;

export function formatChatHtml(chat, messages, options = {}) {
  const theme = resolveHtmlTheme(options.theme);
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const tr = TEXT[lang];
  const title = cleanLineBreaks(chat.title) || 'Untitled';
  const ordered = orderMessages(Array.isArray(messages) ? messages : []);
  const baseDate = datePart(ordered[0]?.created || chat.created);

  const distinctProviders = [
    ...new Set(
      ordered
        .filter(m => m.role === 'assistant' && !m.details?.workflowRun && m.provider)
        .map(m => providerDisplayName(m.provider, tr.assistant))
    )
  ];
  const toolLabel = distinctProviders.length ? distinctProviders.join(' / ') : providerDisplayName(chat.provider, tr.assistant);
  const metaParts = [
    toolLabel,
    options.groupName ? cleanLineBreaks(options.groupName) : '',
    baseDate,
    ordered.length ? tr.messages(ordered.length) : ''
  ].filter(Boolean);

  const messagesHtml = ordered.length
    ? ordered.map(msg => renderMessageHtml(msg, { baseDate, tr })).join('\n')
    : `<p class="message-body muted-empty">${escapeHtml(tr.empty)}</p>`;

  const hasMath = messagesHtml.includes('class="katex');
  const katexCssTag = hasMath ? `<style id="katex-styles">${getSelfContainedKatexCss()}</style>` : '';

  const iconDataUrls = Object.fromEntries(
    HTML_THEMES.map(id => [id, 'data:image/svg+xml;utf8,' + encodeURIComponent(ICONS[id])])
  );

  const switcherButtons = HTML_THEMES.map(
    id =>
      `<button type="button" data-set-theme="${id}" aria-pressed="${String(id === theme)}">${escapeHtml(THEME_META[id][lang])}</button>`
  ).join('');

  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}" data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="${THEME_META[theme].color}">
  <meta name="darkreader-lock">
  <title>${escapeHtml(title)} — Starport</title>
  <link rel="icon" type="image/svg+xml" href="${iconDataUrls[theme]}">
  ${katexCssTag}
  <style>${EXPORT_STYLES}</style>
</head>
<body>
  <header class="export-topbar">
    <div class="export-topbar-inner">
      <div class="export-heading">
        <span class="theme-emblem" aria-hidden="true">
          ${ICONS.sea.replace('<svg ', '<svg data-emblem="sea" ')}
          ${ICONS.port.replace('<svg ', '<svg data-emblem="port" ')}
          ${ICONS['deep-space'].replace('<svg ', '<svg data-emblem="deep-space" ')}
        </span>
        <div class="export-titles">
          <h1>${escapeHtml(title)}</h1>
          <div class="export-meta">${escapeHtml(metaParts.join(' · '))}</div>
        </div>
      </div>
      <div class="theme-switcher" role="group" aria-label="${escapeHtml(tr.themeLabel)}">${switcherButtons}</div>
    </div>
  </header>
  <main class="conversation">
${messagesHtml}
  </main>
  <script>
  (() => {
    const colors = { sea: '#0a1321', port: '#05070c', 'deep-space': '#0c0f13' };
    const icons = ${JSON.stringify(iconDataUrls)};
    const copyLabels = ${JSON.stringify({ copy: tr.copy, copied: tr.copied, failed: tr.copyFailed })};
    const buttons = [...document.querySelectorAll('[data-set-theme]')];
    function applyTheme(next) {
      if (!colors[next]) return;
      document.documentElement.dataset.theme = next;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors[next]);
      document.querySelector('link[rel="icon"]')?.setAttribute('href', icons[next]);
      for (const btn of buttons) btn.setAttribute('aria-pressed', String(btn.dataset.setTheme === next));
    }
    for (const btn of buttons) btn.addEventListener('click', () => applyTheme(btn.dataset.setTheme));
    for (const btn of document.querySelectorAll('[data-copy-code]')) {
      btn.addEventListener('click', async () => {
        const code = btn.parentElement?.querySelector('pre code')?.textContent ?? '';
        const label = btn.querySelector('span');
        try {
          await navigator.clipboard.writeText(code);
          btn.dataset.state = 'done';
          if (label) label.textContent = copyLabels.copied;
        } catch {
          if (label) label.textContent = copyLabels.failed;
        }
        setTimeout(() => {
          delete btn.dataset.state;
          if (label) label.textContent = copyLabels.copy;
        }, 1600);
      });
    }
  })();
  </script>
</body>
</html>
`;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatChatMarkdown,
  markdownFilename,
  closeUnclosedFence,
  stripMemoryProtocol
} from '../src/chat-markdown.mjs';
import {
  HTML_THEMES,
  formatChatHtml,
  htmlFilename
} from '../src/chat-html.mjs';
import { createHub } from '../src/server.mjs';

function sampleChat() {
  return {
    id: 'chat-1',
    title: 'Haah duality critical GSD',
    provider: 'claude',
    workspace: 'C:/work/physics',
    created: '2026-11-21T15:00:00.000Z',
    updated: '2026-11-21T15:10:00.000Z',
    options: { claude: { model: 'claude-opus-4-6', effort: 'high' } }
  };
}

function sampleMessages() {
  return [
    {
      id: 'm1',
      role: 'user',
      provider: 'claude',
      content: '推导一维开边界 cluster state 的边界自由度代数。\n<script>alert(1)</script>',
      status: 'complete',
      created: '2026-11-21T15:01:00.000Z',
      details: {
        attachments: [
          { id: 'a1', name: 'notes.md', kind: 'file' },
          { id: 'a2', name: 'Cluster Paper', kind: 'web', path: 'https://example.com/cluster' }
        ]
      }
    },
    {
      id: 'm2',
      role: 'assistant',
      provider: 'claude',
      content:
        '## 对易关系\n\n考虑开链端点的对称性生成元：\n\n$$[\\sigma_L^x, \\sigma_L^z] = 2i\\sigma_L^y$$\n\n```python\nH = -sum(Z[i-1] * X[i] * Z[i+1])\n```\n\n<img src=x onerror=alert(1)> and [bad](javascript:alert(1))\n\n```starport-memory\n[{"kind":"goal","title":"hidden","content":"should not appear","evidence":"cluster state"}]\n```',
      status: 'complete',
      created: '2026-11-21T15:02:15.000Z',
      details: {
        runId: 'run-1',
        model: 'claude-opus-4-6',
        activity: [
          { id: 't1', kind: 'tool', title: 'Read', status: 'complete', input: 'notes.md' },
          { id: 't2', kind: 'tool', title: 'Bash', status: 'complete', command: 'python check_algebra.py' }
        ],
        subagents: [{ id: 's1', role: 'Algebra Checker', status: 'complete' }]
      }
    },
    {
      id: 'm3',
      role: 'assistant',
      provider: 'codex',
      content: '热力学极限下简并劈裂指数衰减：\n\n```python\ndelta_E = exp(-L / xi)',
      status: 'interrupted',
      created: '2026-11-21T15:06:10.000Z',
      details: { error: '连接中断' }
    }
  ];
}

test('plain Markdown export stays unadorned for AI, strips memory blocks and closes broken fences', () => {
  const chat = sampleChat();
  const messages = sampleMessages();
  const md = formatChatMarkdown(chat, messages);

  assert.ok(md.startsWith('# Haah duality critical GSD\n\n## 用户 · '));
  assert.match(md, /## Claude Code · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(md, /## Codex · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 已中断/);
  assert.doesNotMatch(md, /^---/m);
  assert.ok(!md.includes('starport-memory'));
  assert.ok(!md.includes('should not appear'));
  assert.ok(!md.includes('2026-11-21T15:01:00.000Z'));
  const fences = [...md.matchAll(/^ {0,3}```/gm)];
  assert.equal(fences.length % 2, 0);

  assert.equal(markdownFilename('A/B:C*D?'), 'A_B_C_D_.md');
  assert.equal(htmlFilename('A/B:C*D?'), 'A_B_C_D_.html');
  assert.equal(stripMemoryProtocol('Answer\n```starport-memory\n[]\n```'), 'Answer');
  assert.equal(closeUnclosedFence('```js\nconst x = 1;'), '```js\nconst x = 1;\n```');
});

test('themed HTML export renders KaTeX offline, supports all Starport themes and neutralizes XSS', () => {
  const chat = sampleChat();
  const messages = sampleMessages();

  for (const theme of HTML_THEMES) {
    const html = formatChatHtml(chat, messages, { theme, groupName: '拓扑序房间' });
    assert.match(html, new RegExp(`<html lang="zh-CN" data-theme="${theme}">`));
    assert.match(html, new RegExp(`<button type="button" data-set-theme="${theme}" aria-pressed="true">`));
    // KaTeX math is pre-rendered with self-contained woff2 data URLs.
    assert.match(html, /class="katex-display"/);
    assert.match(html, /data:font\/woff2;base64,/);
    // Code blocks get hover copy wrappers; tool logs stay inside collapsed <details>.
    assert.match(html, /class="code-box"/);
    assert.match(html, /<details class="message-tools"><summary>执行过程 · 2 步工具调用，1 个子代理<\/summary>/);
    // Hidden memory blocks and dangerous HTML/URLs never execute.
    assert.ok(!html.includes('starport-memory'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('href="javascript:'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }

  // Conversations without math omit the 340KB KaTeX font stylesheet.
  const plainHtml = formatChatHtml(chat, [
    { id: 'p1', role: 'user', provider: 'claude', content: '你好', status: 'complete', created: '2026-11-21T15:00:00Z', details: {} },
    { id: 'p2', role: 'assistant', provider: 'claude', content: '你好，这是一段普通文字回复。', status: 'complete', created: '2026-11-21T15:00:05Z', details: {} }
  ], { theme: 'port', lang: 'en' });
  assert.doesNotMatch(plainHtml, /data:font\/woff2;base64,/);
  assert.match(plainHtml, /data-theme="port"/);
  assert.match(plainHtml, /Azure/);
  assert.match(plainHtml, /Spaceport/);
  assert.match(plainHtml, /Deep Space/);
});

test('workflow cards, HTTP HTML/Markdown export and room export endpoints work end-to-end', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'starport-export-http-'));
  const exportRoot = await mkdtemp(join(tmpdir(), 'starport-room-export-'));
  const hub = createHub({ port: 0, dataDir: dir, registry: {} });
  const port = await hub.listen();
  const base = 'http://127.0.0.1:' + port;
  t.after(async () => {
    await hub.close();
    await rm(dir, { recursive: true, force: true });
    await rm(exportRoot, { recursive: true, force: true });
  });

  const group = hub.store.group('拓扑序房间');
  const chat = hub.store.newChat({ title: 'Toric Code 导出测试', workspace: dir, provider: 'claude', group_id: group.id });
  hub.store.message(chat.id, 'user', 'claude', '写出星算符与格点算符。');
  hub.store.message(chat.id, 'assistant', 'claude', '', 'complete', {
    workflowRun: {
      title: '点名 · 推导者',
      status: 'done',
      steps: [{ companionName: '推导者', avatar: '🧭', label: '核对', output: '定义 $A_s = \\prod_{i \\in s} X_i$。\n```starport-memory\n[]\n```' }]
    }
  });

  const headers = { 'X-Hub-Token': hub.token, 'Content-Type': 'application/json' };
  const resHtml = await fetch(`${base}/api/chats/${chat.id}/export?format=html&theme=deep-space`, { headers });
  assert.equal(resHtml.status, 200);
  assert.match(resHtml.headers.get('content-type'), /text\/html/);
  assert.match(resHtml.headers.get('content-disposition'), /filename\*=UTF-8''Toric%20Code%20.*\.html/);
  const htmlText = await resHtml.text();
  assert.match(htmlText, /data-theme="deep-space"/);
  assert.match(htmlText, /class="wf-card"/);
  assert.match(htmlText, /class="katex"/);
  assert.ok(!htmlText.includes('starport-memory'));

  const resMd = await fetch(`${base}/api/chats/${chat.id}/export`, { headers });
  assert.equal(resMd.status, 200);
  const mdText = await resMd.text();
  assert.ok(mdText.startsWith('# Toric Code 导出测试\n\n## 用户 · '));
  assert.match(mdText, /### 推导者 · 核对/);

  const resBad = await fetch(`${base}/api/chats/${chat.id}/export?format=html&theme=unknown`, { headers });
  assert.equal(resBad.status, 400);

  const roomDel = await fetch(`${base}/api/groups/${group.id}/delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'export', exportDir: exportRoot, theme: 'port' })
  });
  assert.equal(roomDel.status, 200);
  const delResult = await roomDel.json();
  assert.equal(delResult.exportedCount, 1);
  const files = await readdir(delResult.exportedPath);
  assert.equal(files.filter(f => f.endsWith('.html')).length, 1);
  assert.equal(files.filter(f => f.endsWith('.md')).length, 1);
  const roomHtml = await readFile(join(delResult.exportedPath, files.find(f => f.endsWith('.html'))), 'utf8');
  assert.match(roomHtml, /data-theme="port"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import { createHub } from '../src/server.mjs';
import { detectEngine, expandedSource, readText, usesExternalize, writeText, resolveInside, listFiles, mainCandidates } from '../src/latex/project.mjs';
import { LatexBuilds, parseLog, synctexRecords, findTex, buildFolder, synctexView, synctexEdit } from '../src/latex/build.mjs';
import { LatexEditor } from '../src/plugins/latex.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-latexmk.mjs', import.meta.url));
const read = file => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
function project(files) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'starport-latex-')));
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); }
  return dir;
}
const PAPER = {
  'paper/main.tex': '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nHello.\n\\input{sections/a}\n\\end{document}\n',
  'paper/sections/a.tex': '\\subsection{Part A}\nSome text.\n',
  'paper/refs.bib': '@book{k, title={T}}\n',
  'notes/draft.tex': 'no class here\n',
  'other.tex': '% \\documentclass{article} only in a comment\n'
};
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); } };

test('the engine follows a magic comment, then the packages, then defaults to pdfLaTeX', () => {
  assert.deepEqual(detectEngine('% !TEX program = xelatex\n\\documentclass{article}'), { engine: 'xelatex', reason: 'magic' });
  assert.equal(detectEngine('%!TeX TS-program = LuaLaTeX\n').engine, 'lualatex');
  assert.equal(detectEngine('\\documentclass[UTF8]{ctexart}\n').engine, 'xelatex');
  assert.equal(detectEngine('\\documentclass{article}\n\\usepackage[a4paper]{geometry,fontspec}\n').engine, 'xelatex');
  assert.equal(detectEngine('\\documentclass{article}\n\\usepackage{luatexja}\n').engine, 'lualatex');
  assert.equal(detectEngine('\\documentclass{revtex4-2}\n% \\usepackage{fontspec}\n\\begin{document}\\usepackage{xeCJK}').engine, 'pdflatex', 'comments and the body do not count');
});

test('Feynman diagrams with automatic layout ask for LuaLaTeX; a preamble in another file counts', async () => {
  const feyn = '\\documentclass{article}\n\\usepackage{tikz-feynman}\n\\begin{document}\n';
  assert.deepEqual(detectEngine(feyn + '\\feynmandiagram [horizontal=a to b] { a -- b };\n'), { engine: 'lualatex', reason: 'feynman' });
  assert.equal(detectEngine(feyn + '\\diagram [horizontal=a to b] { a -- b };\n').engine, 'lualatex');
  assert.equal(detectEngine(feyn + '\\diagram* { (a) -- (b) };\n').engine, 'pdflatex', 'placed by hand, no layout to run');
  assert.equal(detectEngine(feyn + '% \\feynmandiagram {};\n').engine, 'pdflatex');
  assert.equal(detectEngine('\\documentclass{article}\n\\usepackage{tikz}\n\\begin{document}\n\\feynmandiagram\n').engine, 'pdflatex');
  assert.equal(usesExternalize('\\tikzexternalize\n'), true);
  assert.equal(usesExternalize('% \\tikzexternalize\n'), false);
  const dir = project({
    'paper/main.tex': '\\documentclass{article}\n\\input{setup/preamble}\n% \\input{unused}\n\\input{../outside}\n\\begin{document}\n\\input{body}\n\\end{document}\n',
    'paper/setup/preamble.tex': '\\usepackage{tikz,mymacros}\n',
    'paper/mymacros.sty': '\\RequirePackage{tikz-feynman}\n',
    'paper/body.tex': '\\feynmandiagram {};\n',
    'paper/unused.tex': 'UNUSEDTEXT\n',
    'outside.tex': 'OUTSIDETEXT\n'
  });
  const text = await expandedSource(join(dir, 'paper', 'main.tex'));
  assert.match(text, /\\RequirePackage\{tikz-feynman\}/);
  assert.doesNotMatch(text, /UNUSEDTEXT|OUTSIDETEXT/, 'comments and files above the main file are not followed');
  assert.equal(detectEngine(text).engine, 'lualatex');
});

test('LuaLaTeX runs only after the user allows it, and \\tikzexternalize is switched off for the build', { timeout: 20000 }, async () => {
  const dir = project(PAPER), root = join(dir, 'paper', 'main.tex');
  const builds = new LatexBuilds({ tools: async () => ({ latexmk: process.execPath, prefix: [FAKE], synctex: null }) });
  const base = { workspace: dir, root, rootRel: 'paper/main.tex', outDir: buildFolder(dir, 'paper/main.tex') };
  const calls = () => readFileSync(join(base.outDir, 'calls.txt'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const idle = () => builds.status(base).state === 'idle';
  try {
    process.env.STARPORT_FAKE_LATEX = 'ok';
    const waiting = builds.request({ ...base, engine: 'lualatex' });
    assert.equal(waiting.needsLua, true); assert.equal(waiting.state, 'idle');
    assert.throws(() => readFileSync(join(base.outDir, 'calls.txt')), 'nothing was started');
    builds.request({ ...base, engine: 'lualatex', luaAllowed: true }); await until(idle);
    assert.equal(calls()[0].args[0], '-lualatex');
    assert.equal(calls()[0].openin, 'r');
    builds.request({ ...base, engine: 'pdflatex', luaAllowed: true, externalize: true }); await until(idle);
    assert.equal(calls()[1].openin, 'p', 'the permission lifts the read rule for LuaLaTeX only');
    assert.ok(calls()[1].args.some(arg => arg.startsWith('-usepretex=') && arg.includes('tikzexternaldisable')));
  } finally { delete process.env.STARPORT_FAKE_LATEX; await builds.close(); }
  const store = new Store(':memory:'), quiet = new LatexBuilds({ tools: async () => null });
  const editor = new LatexEditor(store, { builds: quiet, tools: async () => null });
  try {
    const work = project({ 'main.tex': '% !TEX program = lualatex\n\\documentclass{article}\n' }), chat = store.newChat({ workspace: work });
    await editor.handle('/api/latex/link', 'POST', async () => ({ chatId: chat.id, root: 'main.tex' }));
    const url = new URL('http://x/?chatId=' + chat.id);
    assert.equal((await editor.handle('/api/latex/project', 'GET', null, { url })).data.build.needsLua, true);
    assert.equal((await editor.handle('/api/latex/lua', 'POST', async () => ({ chatId: chat.id, allowed: 'yes' }))).status, 400);
    assert.equal((await editor.handle('/api/latex/lua', 'POST', async () => ({ chatId: chat.id, allowed: true }))).data.allowed, true);
    assert.equal((await editor.handle('/api/latex/project', 'GET', null, { url })).data.luaAllowed, true);
    assert.equal((await editor.handle('/api/latex/lua', 'POST', async () => ({ chatId: chat.id, allowed: false }))).data.build.needsLua, true);
  } finally { await quiet.close(); store.close(); }
});

test('files are found under the working folder, and nothing outside it can be opened', async () => {
  const dir = project(PAPER), outside = project({ 'secret.tex': 'x' });
  assert.deepEqual(await mainCandidates(dir), ['paper/main.tex']);
  // The whole working folder is listed (a main file in a dated subfolder must not hide its siblings),
  // the main file's folder first, so the file limit never cuts the project itself off.
  assert.deepEqual(await listFiles(dir, join(dir, 'paper')), ['paper/main.tex', 'paper/refs.bib', 'paper/sections/a.tex', 'other.tex', 'notes/draft.tex']);
  assert.deepEqual(await listFiles(dir), ['other.tex', 'notes/draft.tex', 'paper/main.tex', 'paper/refs.bib', 'paper/sections/a.tex']);
  for (const bad of ['../x.tex', join(outside, 'secret.tex'), '', 'a\0b'])
    await assert.rejects(resolveInside(dir, bad), error => error.status === 400 || error.status === 403, bad);
  await assert.rejects(resolveInside(dir, 'paper/missing.tex'), { status: 404 });
  let linked = true;
  try { symlinkSync(outside, join(dir, 'link'), 'junction'); } catch { linked = false; }
  if (linked) await assert.rejects(resolveInside(dir, 'link/secret.tex'), { status: 403 }, 'a link out of the folder is refused');
});

test('text is read strictly as UTF-8, keeps CRLF, and saves only over the version last seen', async () => {
  const dir = project({ 'a.tex': 'one\r\ntwo\r\n', 'b.tex': '', 'c.png': 'x' });
  writeFileSync(join(dir, 'b.tex'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  const first = await readText(dir, 'a.tex');
  assert.equal(first.eol, 'crlf');
  await assert.rejects(readText(dir, 'b.tex'), { status: 415 }, 'GBK text is refused, not mangled on save');
  await assert.rejects(readText(dir, 'c.png'), { status: 400 });
  const saved = await writeText(dir, 'a.tex', 'one\r\ntwo\r\nthree\r\n', first.hash);
  assert.notEqual(saved.hash, first.hash);
  await assert.rejects(writeText(dir, 'a.tex', 'stale', first.hash), error => error.status === 409 && error.data.hash === saved.hash);
  assert.equal(readFileSync(join(dir, 'a.tex'), 'utf8'), 'one\r\ntwo\r\nthree\r\n');
  await writeText(dir, 'a.tex', 'mine', first.hash, { force: true });
  assert.equal(readFileSync(join(dir, 'a.tex'), 'utf8'), 'mine');
});

test('the log gives errors with their file and line, warnings with the file they came from', () => {
  const workspace = join(tmpdir(), 'w'), rootDir = join(workspace, 'paper'), sty = join(tmpdir(), 'texlive', 'amsmath.sty').split('\\').join('/');
  const log = [
    '(./main.tex (c:/texlive/2025/texmf-dist/tex/latex/base/article.cls (c:/texlive/2025/texmf-dist/tex/latex/base/size10.clo))',
    '(./sections/a.tex',
    './sections/a.tex:3: Undefined control sequence.',
    'l.3 \\undefinedmacro',
    'LaTeX Warning: Reference `eq:x\' on page 1 undefined on input line 2.',
    'Overfull \\hbox (3.0pt too wide) in paragraph at lines 4--5',
    ')',
    'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
    '(hyperref)                removing `math shift\' on input line 7.',
    '! Missing $ inserted.',
    '<inserted text>',
    'l.9 x^',
    sty + ':12: LaTeX Error: Something.',
    './sections/a.tex:3: Undefined control sequence.'
  ].join('\n');
  const { errors, warnings, badboxes } = parseLog(log, { rootDir, workspace });
  assert.deepEqual(errors.map(e => [e.file, e.line, e.message]), [
    ['paper/sections/a.tex', 3, 'Undefined control sequence.'],
    ['paper/main.tex', 9, 'Missing $ inserted.'],
    [null, 12, 'LaTeX Error: Something.']
  ], 'repeats are dropped; a "!" error takes the open file and its l. line');
  assert.equal(errors[2].external, true);
  assert.deepEqual(warnings.map(w => [w.file, w.line, w.source]), [['paper/sections/a.tex', 2, 'LaTeX'], ['paper/main.tex', 7, 'hyperref']]);
  assert.match(warnings[1].message, /removing `math shift' on input line 7/);
  assert.equal(badboxes, 1);
});

test('the file tree nests folders under the main file\'s folder, at any depth', async () => {
  const { buildTree, ancestors } = await import('../public/latex/tree.js');
  const tree = buildTree(['paper/main.tex', 'paper/refs.bib', 'paper/sections/b.tex', 'paper/sections/a.tex', 'paper/sections/part2/deep/x.tex', 'paper/appendix/c10.tex', 'paper/appendix/c9.tex', 'notes/elsewhere.tex'], 'paper');
  assert.equal(tree.name, 'paper');
  assert.deepEqual(tree.files.map(f => f.name), ['main.tex', 'refs.bib', 'notes/elsewhere.tex'], 'a file outside the folder keeps its full path at the top');
  assert.deepEqual([...tree.dirs.keys()], ['sections', 'appendix']);
  const sections = tree.dirs.get('sections');
  assert.deepEqual(sections.files.map(f => f.path), ['paper/sections/b.tex', 'paper/sections/a.tex']);
  assert.equal(sections.dirs.get('part2').dirs.get('deep').files[0].path, 'paper/sections/part2/deep/x.tex');
  assert.equal(sections.dirs.get('part2').dirs.get('deep').path, 'paper/sections/part2/deep');
  assert.deepEqual(ancestors('paper/sections/part2/deep/x.tex'), ['paper', 'paper/sections', 'paper/sections/part2', 'paper/sections/part2/deep']);
  assert.deepEqual(buildTree(['main.tex', 'ch/1.tex'], '').dirs.get('ch').files[0].path, 'ch/1.tex', 'a main file at the top of the working folder');
  const dir = project({ ...PAPER, 'paper/a/b/c/d/e/f/g/deep.tex': '', 'paper/figures/plot.png': '' });
  const files = await listFiles(dir, join(dir, 'paper'));
  assert.ok(files.includes('paper/a/b/c/d/e/f/g/deep.tex'), 'folders nested eight deep are listed');
  assert.ok(!files.some(f => f.startsWith('paper/figures')), 'a folder with nothing the editor opens is left out');
  const page = readFileSync(new URL('../public/latex/index.html', import.meta.url), 'utf8');
  assert.match(page, /id="tree-toggle"[^>]*aria-controls="tree-pane"/);
  assert.doesNotMatch(page, /<select id="file-select"/, 'no flat list of every file any more');
});

test('lines changed on disk are found line by line, so edits far apart light only themselves', async () => {
  const { changedLines } = await import('../public/latex/diff.js');
  assert.deepEqual(changedLines('a\nb\nc\nd', 'a\nB\nc\nd\ne'), [2, 5]);
  assert.deepEqual(changedLines('a\nb\nc', 'a\nc'), [2], 'a deletion marks where it was');
  assert.deepEqual(changedLines('a\nb', 'x\na\nb'), [1]);
});

test('SyncTeX answers are read with their case: h is across, H is a height', () => {
  const out = 'This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\nOutput:C:\\p\\main.pdf\nPage:1\nx:160.3\ny:202.8\nh:133.7\nv:204.8\nW:343.7\nH:8.7\nbefore:\noffset:-1\nOutput:C:\\p\\main.pdf\nPage:2\nx:1\ny:2\nh:3\nv:40\nW:5\nH:6\nSyncTeX result end\n';
  assert.deepEqual(synctexRecords(out).map(r => [r.Page, r.h, r.H]), [['1', '133.7', '8.7'], ['2', '3', '6']]);
  const edit = 'SyncTeX result begin\nOutput:C:\\p\\main.pdf\nInput:D:/w/paper/./sections/a.tex\nLine:2\nColumn:-1\nSyncTeX result end\n';
  assert.equal(synctexRecords(edit)[0].Input, 'D:/w/paper/./sections/a.tex');
});

test('a build runs latexmk narrowly, keeps the PDF, queues one more run and notices edited inputs', { timeout: 30000 }, async () => {
  const dir = project(PAPER), root = join(dir, 'paper', 'main.tex');
  const builds = new LatexBuilds({ tools: async () => ({ latexmk: process.execPath, prefix: [FAKE], synctex: null }) });
  const proj = { workspace: dir, root, rootRel: 'paper/main.tex', engine: 'xelatex', outDir: buildFolder(dir, 'paper/main.tex') };
  const idle = () => builds.status(proj).state === 'idle';
  try {
    process.env.STARPORT_FAKE_LATEX = 'ok';
    assert.equal(builds.request(proj).state, 'running');
    await until(idle);
    let status = builds.status(proj);
    assert.equal(status.ok, true); assert.equal(status.pdf, true); assert.equal(status.pdfId, status.buildId);
    assert.match(builds.pdf(proj).toString(), /^%PDF/);
    const call = JSON.parse(readFileSync(join(proj.outDir, 'calls.txt'), 'utf8').trim().split('\n')[0]);
    assert.deepEqual(call.args, ['-xelatex', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-f', '-norc', '-jobname=main', '-usepretex=\\InputIfFileExists{starport-hooks}{}{}', '-outdir=' + proj.outDir, 'main.tex'], 'no latexmkrc, nonstop, the engine chosen');
    assert.equal(realpathSync.native(call.cwd), join(dir, 'paper'));
    assert.equal(call.openin, 'p', 'TeX may read only below the main file');
    assert.equal(call.width, '1000');
    assert.equal(await builds.changedSince(proj), false);
    utimesSync(join(dir, 'paper', 'sections', 'a.tex'), new Date(), new Date(Date.now() + 5000));
    assert.equal(await builds.changedSince(proj), true, 'an included file edited after the build');

    process.env.STARPORT_FAKE_LATEX = 'slow';
    builds.request(proj);
    assert.equal(builds.request(proj).state, 'queued');
    await until(idle);
    assert.equal(readFileSync(join(proj.outDir, 'calls.txt'), 'utf8').trim().split('\n').length, 3, 'asked twice while running: one more run');

    process.env.STARPORT_FAKE_LATEX = 'error';
    builds.request(proj); await until(idle);
    status = builds.status(proj);
    assert.equal(status.ok, false); assert.equal(status.code, 12);
    assert.deepEqual(status.errors.map(e => [e.file, e.line]), [['paper/sections/a.tex', 3]]);
    assert.equal(status.warnings.length, 2); assert.equal(status.badboxes, 1);
    assert.equal(status.log, '.starport/latex/' + proj.outDir.split(/[\\/]/).pop() + '/main.log');

    const kept = status.pdfId;
    process.env.STARPORT_FAKE_LATEX = 'fatal';
    builds.request(proj); await until(idle);
    status = builds.status(proj);
    assert.equal(status.ok, false); assert.equal(status.pdfId, kept, 'without a new PDF the last one stays on show');
  } finally { delete process.env.STARPORT_FAKE_LATEX; await builds.close(); }
});

test('with no TeX on the computer a build says so instead of failing obscurely', async () => {
  const dir = project(PAPER), builds = new LatexBuilds({ tools: async () => null });
  const proj = { workspace: dir, root: join(dir, 'paper', 'main.tex'), rootRel: 'paper/main.tex', engine: 'pdflatex', outDir: buildFolder(dir, 'paper/main.tex') };
  builds.request(proj);
  await until(() => builds.status(proj).state === 'idle');
  assert.equal(builds.status(proj).missing, true);
});

test('the model hears where the user is and how the build went, again only when it changes', async () => {
  const store = new Store(':memory:');
  const builds = { status: () => ({ at: Date.now(), ok: false, errors: [{ file: 'paper/sections/a.tex', line: 3, message: 'Undefined control sequence.' }], warnings: [], log: '.starport/latex/x/main.log' }), close() {} };
  const editor = new LatexEditor(store, { builds, tools: async () => ({ latexmk: 'x', synctex: 'y' }) });
  try {
    const dir = project(PAPER), chat = store.newChat({ workspace: dir });
    assert.equal(await editor.prompt({ chat, resumed: false }), '', 'nothing while no editor is open');
    await editor.handle('/api/latex/link', 'POST', async () => ({ chatId: chat.id, root: 'paper/main.tex' }));
    assert.equal(store.setting('latex.links')[chat.id].root, 'paper/main.tex');
    await editor.handle('/api/latex/presence', 'POST', async () => ({ chatId: chat.id, path: 'paper/sections/a.tex', line: 2, outline: '\\section{Intro} › \\subsection{Part A}' }));
    const first = await editor.prompt({ chat, resumed: true });
    assert.match(first, /主文件：paper\/main\.tex（pdflatex）/);
    assert.match(first, /用户正在看：paper\/sections\/a\.tex 第 2 行（\\section\{Intro\} › \\subsection\{Part A\}）/);
    assert.match(first, /失败，1 个错误：paper\/sections\/a\.tex:3 Undefined control sequence\./);
    assert.match(first, /完整日志：\.starport\/latex\/x\/main\.log/);
    assert.equal(await editor.prompt({ chat, resumed: true }), '', 'a resumed session already has it');
    assert.equal(await editor.prompt({ chat, resumed: false }), first, 'a fresh session hears it again');
    assert.equal(await editor.prompt({ chat, resumed: false, desk: true }), '', 'companion desks are left out');
    await editor.handle('/api/latex/presence', 'POST', async () => ({ chatId: chat.id, open: false }));
    assert.equal(await editor.prompt({ chat, resumed: false }), '', 'a closed editor says nothing');
    const desk = store.newChat({ workspace: dir, options: { codex: {}, desk: { parentChatId: chat.id } } });
    assert.equal((await editor.handle('/api/latex/project', 'GET', null, { url: new URL('http://x/?chatId=' + desk.id) })).status, 400);
  } finally { store.close(); }
});

test('the runner adds plugin context to a turn and tells the part whether the session resumes', { timeout: 15000 }, async () => {
  const store = new Store(':memory:'), calls = [], seen = [];
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}), record() {} };
  const runner = new Runner(store, registry, () => {}, { codex: async args => { calls.push(args); args.emit({ type: 'session', id: 'native-1' }); args.emit({ type: 'replace', text: 'ok' }); args.emit({ type: 'final-answer', text: 'ok' }); } });
  runner.prompts.add(async info => { seen.push(info.resumed); return info.resumed ? '' : '插件上下文：主文件 main.tex\n'; });
  runner.prompts.add(() => { throw new Error('a broken part is left out'); });
  try {
    const chat = store.newChat({ workspace: project({}) });
    const turn = async text => { await runner.start(chat.id, text); await runner.active.get(chat.id)?.done; return calls.at(-1); };
    assert.match((await turn('one')).prompt, /插件上下文：主文件 main\.tex/);
    assert.doesNotMatch((await turn('two')).prompt, /插件上下文/);
    assert.deepEqual(seen, [false, true]);
  } finally { await runner.close(); store.close(); }
});

test('HTTP: the editor page carries the token and may be framed by Starport only; its libraries are served', { timeout: 20000 }, async t => {
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}), list: async () => [], record: () => {} };
  const hub = createHub({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'starport-latex-hub-')), registry });
  const port = await hub.listen(); t.after(() => hub.close());
  const base = 'http://127.0.0.1:' + port, headers = { 'X-Hub-Token': hub.token, 'Content-Type': 'application/json' };
  const page = await fetch(base + '/latex/?chat=x');
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`name="hub-token" content="${hub.token}"`));
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /frame-ancestors 'none'/, 'Starport itself still cannot be framed');
  for (const path of ['/vendor/codemirror.mjs', '/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs', '/vendor/pdfjs/pdf_viewer.min.mjs', '/latex/main.js']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path); assert.match(res.headers.get('content-type'), /javascript/, path);
  }
  assert.equal((await fetch(base + '/vendor/pdfjs/..%2F..%2Fserver.mjs')).status, 404);

  const dir = project(PAPER), chat = hub.store.newChat({ workspace: dir, title: 'LaTeX 论文' });
  const get = (path, query = '') => fetch(base + '/api/latex/' + path + '?chatId=' + chat.id + query, { headers });
  const send = (path, method, data) => fetch(base + '/api/latex/' + path, { method, headers, body: JSON.stringify({ chatId: chat.id, ...data }) });
  assert.equal((await fetch(base + '/api/latex/project?chatId=' + chat.id)).status, 401, 'the API still needs the token');
  let data = await (await get('project')).json();
  assert.equal(data.chatTitle, 'LaTeX 论文');
  assert.equal(data.root, null); assert.deepEqual(data.candidates, ['paper/main.tex']);
  data = await (await send('link', 'POST', { root: 'paper/main.tex' })).json();
  assert.equal(data.chatTitle, 'LaTeX 论文');
  assert.equal(data.root, 'paper/main.tex'); assert.ok(data.files.includes('paper/sections/a.tex'));
  assert.equal((await send('link', 'POST', { root: 'paper/refs.bib' })).status, 400);
  const file = await (await get('file', '&path=paper/sections/a.tex')).json();
  const saved = await send('file', 'PUT', { path: 'paper/sections/a.tex', text: file.text + 'More.\n', baseHash: file.hash });
  assert.equal(saved.status, 200);
  const conflict = await send('file', 'PUT', { path: 'paper/sections/a.tex', text: 'x', baseHash: file.hash });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).conflict, true);
  assert.equal((await get('file', '&path=../outside.tex')).status, 403);
  assert.equal((await get('pdf')).status, 404);
  hub.store.updateChat(chat.id, { title: '改名后的论文' });
  const watch = await (await get('watch', '&path=paper/sections/a.tex')).json();
  assert.equal(watch.chatTitle, '改名后的论文');
  assert.equal(watch.file.path, 'paper/sections/a.tex'); assert.equal(watch.build.state, 'idle');
  assert.equal((await send('presence', 'POST', { path: 'paper/main.tex', line: 4 })).status, 200);
  assert.match(await hub.runner.prompts.text({ chat, resumed: false }), /星港 LaTeX 编辑器/);
});

test('Starport docks the editor beside the conversation and quotes a selection in front of the message', () => {
  const html = read('index.html');
  assert.match(html, /<div id="workarea" class="workarea">\s*<main id="main" class="main">[\s\S]*<\/main>\s*<aside id="latex-dock"[^>]*hidden>[\s\S]*<iframe id="latex-frame"[\s\S]*<\/aside>\s*<\/div>/);
  assert.match(html, /id="latex-toggle"[^>]*hidden/);
  assert.ok(html.indexOf('id="composer-quote"') < html.indexOf('id="composer-attachments"'));
  assert.match(html, /<script defer src="\/latex-dock\.js\?v=[\d.]+"><\/script>/);
  const listeners = [], posted = [];
  const context = {
    BroadcastChannel: class { addEventListener(type, fn) { listeners.push(fn); } postMessage(message) { posted.push(message); } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {} },
    state: { chat: { id: 'c1' } }, $: () => null, el: () => ({}), toast() {}, openChat: async () => {},
    t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, k) => values[k])
  };
  context.globalThis = context;
  runInNewContext(read('latex-dock.js'), context);
  const dock = context.StarportLatexDock;
  assert.equal(dock.withQuote('c1', 'hi'), 'hi');
  listeners[0]({ data: { type: 'selection', chatId: 'c1', path: 'paper/sections/a.tex', fromLine: 3, toLine: 5, text: 'a ``` b\n\n' } });
  assert.equal(dock.has('c1'), true); assert.equal(dock.has('c2'), false);
  assert.equal(dock.withQuote('c1', '这里为什么报错？'), '> 引用 `paper/sections/a.tex` 第 3–5 行\n\n````latex\na ``` b\n````\n\n这里为什么报错？');
  assert.match(dock.withQuote('c1', '  '), /````\n\n请看这段源码。$/, 'a quote can go out on its own');
  dock.sent('c1');
  assert.equal(dock.has('c1'), false);
  listeners[0]({ data: { type: 'selection', chatId: 'c1', path: 'a.tex', fromLine: 7, toLine: 7, text: 'x' } });
  assert.match(dock.withQuote('c1', 'q'), /^> 引用 `a\.tex` 第 7 行\n\n```latex\nx\n```\n\nq$/);
});

test('a quote follows the selection unless it is kept; kept ones gather, survive a reload and go out together', () => {
  const stored = new Map(), keys = [], toasts = [];
  const load = () => {
    const listeners = [];
    const context = {
      BroadcastChannel: class { addEventListener(type, fn) { listeners.push(fn); } postMessage() {} },
      localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
      document: { addEventListener: (type, fn) => { if (type === 'keydown') keys.push(fn); } },
      state: { chat: { id: 'c1' } }, $: () => null, el: () => ({}), toast: text => toasts.push(text), openChat: async () => {},
      t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, k) => values[k])
    };
    context.globalThis = context;
    runInNewContext(read('latex-dock.js'), context);
    return { dock: context.StarportLatexDock, send: data => listeners[0]({ data: { chatId: 'c1', ...data } }) };
  };
  const a = { path: 'a.tex', fromLine: 1, toLine: 2, text: 'alpha' }, b = { path: 'b.tex', fromLine: 5, toLine: 5, text: 'beta' }, c = { path: 'a.tex', fromLine: 9, toLine: 9, text: 'gamma' };
  const press = () => { const event = { key: 'l', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; keys.at(-1)(event); return event.defaultPrevented; };
  let { dock, send } = load();
  send({ type: 'selection', ...a });
  assert.equal(dock.has('c1'), true);
  send({ type: 'selection-clear' });
  assert.equal(dock.has('c1'), false, 'no longer selected, no longer quoted');
  assert.equal(dock.withQuote('c1', 'q'), 'q');
  assert.equal(press(), false, 'with nothing selected Ctrl L is left alone');

  send({ type: 'selection', ...a });
  send({ type: 'selection', ...b });
  assert.doesNotMatch(dock.withQuote('c1', 'q'), /alpha/, 'a new selection replaces a live quote');
  assert.equal(press(), true, 'Ctrl L from the input box keeps what is selected');
  send({ type: 'selection-clear' });
  assert.match(dock.withQuote('c1', 'q'), /beta/, 'a kept quote stays when the selection goes');
  send({ type: 'keep', ...a });
  send({ type: 'keep', ...a });
  send({ type: 'selection', ...a });
  assert.equal(dock.withQuote('c1', 'q').match(/alpha/g).length, 1, 'the same passage is never quoted twice');
  send({ type: 'selection', ...c });
  const text = dock.withQuote('c1', '比较这三段');
  assert.ok(text.indexOf('beta') < text.indexOf('alpha') && text.indexOf('alpha') < text.indexOf('gamma') && text.endsWith('比较这三段'), 'kept ones first, then the selection, then the words');

  ({ dock, send } = load());
  assert.match(dock.withQuote('c1', 'q'), /beta[\s\S]*alpha/, 'kept quotes survive a reload');
  assert.doesNotMatch(dock.withQuote('c1', 'q'), /gamma/, 'a selection does not');
  dock.sent('c1');
  assert.equal(dock.has('c1'), false);
  assert.equal(stored.has('starport-latex-kept:c1'), false, 'sending clears them');
  for (let i = 0; i < 14; i++) send({ type: 'keep', path: 'n.tex', fromLine: i + 1, toLine: i + 1, text: 'x' + i });
  assert.equal(dock.withQuote('c1', 'q').match(/n\.tex/g).length, 12);
  assert.ok(toasts.some(text => text.includes('最多保留')));
});

test('the senders put the quote in front of the text they send and clear it after', () => {
  const send = read('app-send.js'), flows = read('workflows.js');
  assert.match(send, /text: metadata\.replyTo \? text : globalThis\.StarportLatexDock\?\.withQuote\(chatId, text\) \?\? text/);
  assert.equal(send.match(/StarportLatexDock\?\.sent\(chatId\)/g).length, 2);
  assert.match(flows, /const sent = globalThis\.StarportLatexDock\?\.withQuote\(chat\.id, text\) \?\? text;/);
  assert.match(read('app-layout.js'), /globalThis\.StarportLatexDock\?\.sync\(\);/);
});

// With TeX installed and runnable, build a real project: bibliography, an included file, SyncTeX both
// ways, an error located in its file, and a file outside the main file's folder refused.
const runnable = await new Promise(async done => {
  const tools = await findTex().catch(() => null);
  if (!tools?.synctex) return done(null);
  execFile(tools.latexmk, ['-v'], { timeout: 20000, windowsHide: true }, error => done(error ? null : tools));
});
test('a real TeX build: bibliography, SyncTeX both ways, located errors, nothing read from outside', { skip: runnable ? false : 'TeX (latexmk) is not runnable here', timeout: 180000 }, async () => {
  const dir = project({
    'secret.tex': 'TOPSECRET\n',
    'paper/main.tex': '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nAs shown by \\cite{knuth}.\n\\input{sections/a}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
    'paper/sections/a.tex': '\\subsection{Part A}\nSome text in part A that is long enough to find.\n',
    'paper/refs.bib': '@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}\n'
  });
  const builds = new LatexBuilds({ tools: async () => runnable });
  const proj = { workspace: dir, root: join(dir, 'paper', 'main.tex'), rootRel: 'paper/main.tex', engine: 'pdflatex', outDir: buildFolder(dir, 'paper/main.tex') };
  const build = async () => { builds.request(proj); await until(() => builds.status(proj).state === 'idle', 170000); return builds.status(proj); };
  try {
    let status = await build();
    assert.equal(status.ok, true, JSON.stringify(status.errors) + status.tail);
    assert.deepEqual(status.warnings.filter(w => /Citation/.test(w.message)), [], 'the bibliography was run');
    const pdf = join(proj.outDir, 'main.pdf');
    const boxes = await synctexView({ synctex: runnable.synctex, pdf, file: join(dir, 'paper', 'sections', 'a.tex'), line: 2 });
    assert.ok(boxes.length && boxes[0].page === 1);
    const back = await synctexEdit({ synctex: runnable.synctex, pdf, page: 1, x: boxes[0].left + 20, y: boxes[0].top + boxes[0].height / 2 });
    assert.equal(back.file, join(dir, 'paper', 'sections', 'a.tex')); assert.equal(back.line, 2);

    writeFileSync(join(dir, 'paper', 'sections', 'a.tex'), '\\subsection{Part A}\nSome text.\n\\undefinedmacro\n');
    status = await build();
    assert.equal(status.ok, false);
    assert.deepEqual(status.errors.map(e => [e.file, e.line]).slice(0, 1), [['paper/sections/a.tex', 3]]);
    assert.equal(status.pdf, true, 'nonstop builds still make a PDF');

    writeFileSync(join(dir, 'paper', 'sections', 'a.tex'), '\\input{../secret}\n');
    status = await build();
    assert.ok(status.errors.some(e => /not found/i.test(e.message)), JSON.stringify(status.errors));
    assert.doesNotMatch(readFileSync(join(proj.outDir, 'main.log'), 'utf8'), /TOPSECRET/);
  } finally { await builds.close(); }
});
test('real builds: an allowed Feynman diagram under LuaLaTeX, and a document using \\tikzexternalize', { skip: runnable ? false : 'TeX (latexmk) is not runnable here', timeout: 180000 }, async () => {
  const builds = new LatexBuilds({ tools: async () => runnable });
  const build = async proj => { builds.request(proj); await until(() => builds.status(proj).state === 'idle', 170000); return builds.status(proj); };
  try {
    const feynman = '\\documentclass{article}\n\\usepackage[compat=1.1.0]{tikz-feynman}\n\\begin{document}\n\\feynmandiagram [horizontal=a to b] {\n  i1 -- [fermion] a -- [fermion] i2,\n  a -- [photon] b,\n  f1 -- [fermion] b -- [fermion] f2,\n};\n\\end{document}\n';
    let dir = project({ 'main.tex': feynman });
    const lua = { workspace: dir, root: join(dir, 'main.tex'), rootRel: 'main.tex', engine: detectEngine(feynman).engine, luaAllowed: true, outDir: buildFolder(dir, 'main.tex') };
    assert.equal(lua.engine, 'lualatex');
    let status = await build(lua);
    assert.equal(status.ok, true, JSON.stringify(status.errors) + status.tail);
    assert.doesNotMatch(readFileSync(join(lua.outDir, 'main.log'), 'utf8'), /LuaTeX is required/);
    const external = '\\documentclass{article}\n\\usepackage{tikz}\n\\usetikzlibrary{external}\n\\tikzexternalize\n\\begin{document}\n\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}\n\\end{document}\n';
    dir = project({ 'main.tex': external });
    const ext = { workspace: dir, root: join(dir, 'main.tex'), rootRel: 'main.tex', engine: 'pdflatex', externalize: usesExternalize(external), outDir: buildFolder(dir, 'main.tex') };
    status = await build(ext);
    assert.equal(status.ok, true, JSON.stringify(status.errors) + status.tail);
  } finally { await builds.close(); }
});

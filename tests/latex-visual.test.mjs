import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseVisual } from '../public/latex/visual-parse.js';
import { assignNumbers, collectMacros, documentMacros, mathSource, numberedRows, renderMath } from '../public/latex/visual-math.js';
import { LatexFigures, figureSource, findGraphic, graphicPaths, parseAux, readLabels } from '../src/latex/figures.mjs';
import { LatexBuilds, buildFolder, findTex, synctexEdit } from '../src/latex/build.mjs';
import { execFile } from 'node:child_process';
import { createHub } from '../src/server.mjs';

const context = {};
context.globalThis = context;
runInNewContext(readFileSync(new URL('../public/vendor/katex.min.js', import.meta.url), 'utf8'), context);
const katex = context.katex;
const kinds = text => parseVisual(text).map(item => item.kind);
const slice = (text, item) => text.slice(item.from, item.to);

test('formulas are found in every form, and escapes, comments and verbatim text are not formulas', () => {
  const text = String.raw`\begin{document}
Cost \$5 and $a+b$, \(c\), $$d$$ and \[e\].
% $not math$
\verb|$no$| and \begin{verbatim}$no$\end{verbatim}
\begin{align}
  x &= 1 \label{eq:x} \\
  y &= 2
\end{align}
\end{document}`;
  const items = parseVisual(text);
  assert.deepEqual(items.map(i => [i.kind, i.display]).slice(0, 5), [['math', false], ['math', false], ['math', true], ['math', true], ['math', true]]);
  assert.deepEqual(items.slice(0, 4).map(i => i.tex), ['a+b', 'c', 'd', 'e']);
  assert.equal(items[4].env, 'align');
  assert.equal(items.length, 5, 'a \\label inside a formula belongs to the formula');
});

test('a stray dollar cannot swallow the next paragraph, and the preamble is not drawn', () => {
  assert.deepEqual(kinds('\\begin{document}\nFive $ dollars.\n\nNext $x$ here.\n\\end{document}').length, 1);
  assert.equal(parseVisual('\\begin{document}\nFive $ dollars.\n\nNext $x$ here.')[0].tex, 'x');
  assert.deepEqual(kinds('\\documentclass{a}\n\\newcommand{\\x}{$y$}\n\\begin{document}\nz\n\\end{document}'), []);
  assert.deepEqual(kinds('An included file with $x$.'), ['math'], 'a file without \\begin{document} is all body');
  assert.deepEqual(kinds('\\begin{equation} unclosed'), []);
});

test('pictures are whole, nested ones included, and Feynman diagrams end at their semicolon', () => {
  const text = String.raw`\begin{tikzpicture}
  \node {\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}};
  \node {$x$};
\end{tikzpicture}
\feynmandiagram [horizontal=a to b] { a -- [photon] b };
\tikz \draw (0,0) -- (1,0);
after`;
  const items = parseVisual(text);
  assert.deepEqual(items.map(i => i.kind), ['picture', 'picture', 'picture']);
  assert.ok(items[0].code.endsWith('\\end{tikzpicture}') && items[0].code.includes('$x$'));
  assert.equal(items[1].code, '\\feynmandiagram [horizontal=a to b] { a -- [photon] b };');
  assert.equal(items[2].code, '\\tikz \\draw (0,0) -- (1,0);');
});

test('headings, styles, references, citations, labels and graphics carry their parts', () => {
  const text = String.raw`\section*{Intro to $x$}\label{sec:a}
\textbf{bold \emph{both}} see \eqref{eq:z}, \cite[p.~2]{knuth, dirac}.
\includegraphics[width=.5\linewidth]{figs/plot}`;
  const items = parseVisual(text);
  assert.deepEqual(items.map(i => i.kind), ['heading', 'math', 'label', 'style', 'style', 'ref', 'cite', 'graphic']);
  assert.equal(items[0].level, 2);
  assert.equal(text.slice(items[0].innerFrom, items[0].innerTo), 'Intro to $x$');
  assert.equal(items[3].style, 'bold'); assert.equal(items[4].style, 'italic');
  assert.equal(text.slice(items[4].innerFrom, items[4].innerTo), 'both');
  assert.deepEqual(items[5].keys, ['eq:z']); assert.equal(items[5].command, 'eqref');
  assert.deepEqual(items[6].keys, ['knuth', 'dirac']);
  assert.equal(items[7].file, 'figs/plot');
  assert.equal(slice(text, items[7]), '\\includegraphics[width=.5\\linewidth]{figs/plot}');
});

test('the document\'s own macros are read, with arguments, operators and paired delimiters', () => {
  const macros = collectMacros(String.raw`\newcommand{\Hil}{\mathcal{H}}
\newcommand*\pair[2]{\langle #1, #2\rangle}
\renewcommand{\vec}[1]{\mathbf{#1}}
\newcommand{\unused}[2]{#2}
\newcommand{\opt}[2][a]{#1#2}
\def\R{\mathbb{R}}
\def\twice#1{#1#1}
\DeclareMathOperator{\sgn}{sgn}
\DeclareMathOperator*{\argmax}{arg\,max}
\DeclarePairedDelimiter{\abs}{\lvert}{\rvert}
% \newcommand{\gone}{x}`);
  assert.equal(macros['\\Hil'], '\\mathcal{H}');
  assert.equal(macros['\\sgn'], '\\operatorname{sgn}');
  assert.equal(macros['\\argmax'], '\\operatorname*{arg\\,max}');
  assert.equal(macros['\\gone'], undefined);
  assert.equal(macros['\\opt'], undefined, 'an optional argument KaTeX cannot take');
  const draw = tex => renderMath(katex, { tex, display: false, env: null }, { macros });
  for (const tex of ['\\Hil', '\\pair{a}{b}', '\\vec{v}', '\\R', '\\twice{x}', '\\sgn x', '\\argmax_x f', '\\abs{x}']) assert.ok(draw(tex), tex);
  assert.ok(draw('\\unused{hidden}{shown}').includes('shown'.at(0)));
  assert.ok(!draw('\\unused{Q}{P}').includes('>Q<'), 'an unused argument is consumed, not drawn');
});

test('physics notation draws when the package is loaded', () => {
  const macros = documentMacros('\\usepackage{physics}\n\\usepackage{slashed}');
  for (const tex of ['\\abs{x}', '\\norm{v}', '\\dv{f}{x}', '\\dv{x}', '\\dv[2]{f}{x}', '\\pdv{f}{x}', '\\expval{A}', '\\expval{A}{\\psi}', '\\mel{a}{H}{b}', '\\braket{a}{b}', '\\braket{a}',
    '\\comm{A}{B}', '\\acomm{A}{B}', '\\qty(\\frac{a}{b})', '\\qty[x]', '\\qty{x}', '\\qty|x|', '\\dd{x}', '\\tr A', '\\vb{r}', '\\grad f', '\\order{x^2}', '\\slashed{p}', '\\bm{x}'])
    assert.ok(renderMath(katex, { tex, display: true, env: null }, { macros }), tex);
  assert.equal(documentMacros('\\usepackage{amsmath}')['\\dv'], undefined, 'not defined for documents without it');
  assert.equal(documentMacros('\\usepackage{physics}\n\\newcommand{\\dv}{mine}')['\\dv'], 'mine', 'the document\'s own definition wins');
});

test('environments become KaTeX\'s, and a label becomes the real equation number', () => {
  assert.equal(mathSource({ tex: 'a\\label{x}', env: 'equation' }, { x: '3' }).tagged, 'a\\tag{3}');
  assert.equal(mathSource({ tex: 'a\\label{x}', env: 'equation' }, {}).tagged, 'a', 'not built yet: no number');
  assert.equal(mathSource({ tex: 'a\\label{x}', env: 'equation*' }, { x: '3' }).tagged, 'a');
  assert.equal(mathSource({ tex: 'a&=b\\nonumber', env: 'align' }).plain, '\\begin{align*}a&=b\\end{align*}');
  for (const env of ['equation', 'equation*', 'align', 'align*', 'flalign', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'displaymath'])
    assert.ok(renderMath(katex, { tex: env === 'eqnarray' ? 'a&=&b\\\\c&=&d' : env.startsWith('equation') || env === 'displaymath' ? 'a=b' : 'a&=b\\\\c&=d'.replaceAll(env.startsWith('gather') || env.startsWith('multline') ? '&' : '\0', ''), display: true, env }), env);
  assert.ok(renderMath(katex, { tex: '{2}a&=b&c&=d', display: true, env: 'alignat' }));
  const row = renderMath(katex, { tex: 'a&=b\\label{p}\\\\c&=d\\label{q}', display: true, env: 'align' }, { labels: { p: '4', q: '5' } });
  assert.ok(row.includes('4') && row.includes('5'), 'each row keeps its own number');
  assert.ok(renderMath(katex, { tex: '\\begin{split}a\\label{s}\\\\b\\end{split}', display: true, env: 'equation' }, { labels: { s: '6' } }), 'a number that cannot sit there is dropped, the formula stays');
  assert.equal(renderMath(katex, { tex: '\\notacommand{x}', display: false, env: null }), null);
  assert.doesNotMatch(renderMath(katex, { tex: '\\href{javascript:x}{y}', display: false, env: null }) ?? '', /<a\s/, 'links in formulas are not trusted');
});

const FAKE_TEX = fileURLToPath(new URL('./fixtures/fake-tex.mjs', import.meta.url));
function project(files) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'starport-visual-')));
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); }
  return dir;
}

test('the last build\'s numbers are read for labels and citations', () => {
  const { labels, cites } = parseAux(String.raw`\newlabel{eq:z}{{1}{1}{Intro}{equation.1.1}{}}
\newlabel{eq:z@cref}{{[equation][1][]1}{[1][1][]1}}
\newlabel{sec:a}{{2.1}{3}}
\newlabel{app}{{\relax A}{9}}
\bibcite{knuth}{1}
\bibcite{dirac}{{2}{1930}{{Dirac}}{{}}}`);
  assert.deepEqual(labels, { 'eq:z': '1', 'sec:a': '2.1', app: 'A' });
  assert.deepEqual(cites, { knuth: '1', dirac: '2' });
});

test('graphics are found as TeX would, and only below the main file\'s folder', async () => {
  const dir = project({ 'paper/main.tex': '', 'paper/figs/plot.png': 'x', 'paper/a.pdf': 'x', 'paper/note.txt': 'x', 'secret.png': 'x' });
  const root = join(dir, 'paper'), preamble = '\\graphicspath{{figs/}{other/}}\n% \\graphicspath{{no/}}\n';
  assert.deepEqual(graphicPaths(preamble), ['figs/', 'other/']);
  assert.equal((await findGraphic(root, 'plot', preamble)).type, 'image/png');
  assert.equal((await findGraphic(root, 'a', '')).type, 'application/pdf');
  for (const bad of ['../secret.png', '../secret', join(dir, 'secret.png')]) await assert.rejects(findGraphic(root, bad, ''), error => error.status === 400 || error.status === 404, bad);
  await assert.rejects(findGraphic(root, 'note.txt', ''), { status: 404 });
});

test('a picture compiles alone with the real preamble, once, under the same limits as a build', { timeout: 20000 }, async () => {
  const dir = project({ 'paper/main.tex': '' }), root = join(dir, 'paper', 'main.tex');
  const figures = new LatexFigures({ tools: async () => ({ engine: process.execPath, prefix: [FAKE_TEX] }) });
  const base = { workspace: dir, root, rootRel: 'paper/main.tex', engine: 'pdflatex', outDir: join(dir, '.starport', 'latex', 'x') };
  const options = { rawPreamble: '\\documentclass{article}\n', fullPreamble: '\\documentclass{article}\n' };
  const code = '\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}', runs = () => readFileSync(join(base.outDir, 'figures', 'runs.txt'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  try {
    const [first, second] = await Promise.all([figures.render(base, code, options), figures.render(base, code, options)]);
    assert.match(first.toString(), /^%PDF/); assert.equal(second.toString(), first.toString());
    assert.equal(runs().length, 1, 'asked twice at once: one run');
    assert.equal(runs()[0].openin, 'p'); assert.equal(runs()[0].preview, true);
    assert.equal(realpathSync.native(runs()[0].cwd), join(dir, 'paper'), 'relative \\input lines still work');
    await figures.render(base, code, options);
    assert.equal(runs().length, 1, 'kept for next time');
    await figures.render(base, code, { ...options, fullPreamble: options.fullPreamble + '% an edited macro file' });
    assert.equal(runs().length, 2, 'a changed macro file draws it again');
    await assert.rejects(figures.render(base, '\\begin{tikzpicture}BROKEN\\end{tikzpicture}', options), error => error.status === 422 && /Undefined control sequence/.test(error.message));
    await assert.rejects(figures.render(base, '\\input{other}', options), { status: 400 }, 'only pictures');
    await assert.rejects(figures.render({ ...base, engine: 'lualatex' }, code, options), error => error.status === 409 && error.data.needsLua);
    await figures.render({ ...base, engine: 'lualatex', luaAllowed: true }, code, options);
    assert.equal(runs().at(-1).openin, 'r');
    await assert.rejects(figures.render(base, code + ' ', { rawPreamble: null, fullPreamble: '' }), { status: 400 });
    assert.ok(figureSource('\\documentclass{a}', 'X').includes('\\usepackage[active,tightpage]{preview}'));
  } finally { await figures.close(); }
});

test('HTTP: the visual mode gets macros, numbers, pictures\' refusals and graphics through the token', { timeout: 20000 }, async t => {
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}), list: async () => [], record: () => {} };
  const hub = createHub({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'starport-visual-hub-')), registry });
  const port = await hub.listen(); t.after(() => hub.close());
  const base = 'http://127.0.0.1:' + port + '/api/latex/', headers = { 'X-Hub-Token': hub.token, 'Content-Type': 'application/json' };
  const dir = project({ 'main.tex': '\\documentclass{article}\n\\input{defs}\n\\begin{document}\nx\n\\end{document}\n', 'defs.tex': '\\newcommand{\\Hil}{\\mathcal{H}}\n', 'plot.png': 'PNGDATA', });
  const chat = hub.store.newChat({ workspace: dir });
  const post = (path, data) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ chatId: chat.id, ...data }) });
  assert.equal((await post('link', { root: 'main.tex' })).status, 200);
  assert.equal((await fetch(base + 'context?chatId=' + chat.id)).status, 401);
  const context = await (await fetch(base + 'context?chatId=' + chat.id, { headers })).json();
  assert.match(context.preamble, /\\newcommand\{\\Hil\}/, 'a macro kept in another file');
  assert.deepEqual(context.labels, {});
  const image = await fetch(base + 'graphic?name=plot&chatId=' + chat.id, { headers });
  assert.equal(image.headers.get('content-type'), 'image/png'); assert.equal(await image.text(), 'PNGDATA');
  assert.equal((await fetch(base + 'graphic?name=../x&chatId=' + chat.id, { headers })).status, 404);
  assert.equal((await post('figure', { code: 'not a picture' })).status, 400);
});

test('the editor page loads the visual mode and offers its switch', () => {
  const page = readFileSync(new URL('../public/latex/index.html', import.meta.url), 'utf8');
  assert.match(page, /id="visual-mode"/);
  assert.match(page, /src="\/vendor\/katex\.min\.js"/);
  const english = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
  for (const text of ['可视', '正在渲染图…', '允许这个主文件用 LuaLaTeX']) assert.ok(english.includes(`"${text}":`), text);
});

test('formulas without a label take the number the build gave them, row by row', () => {
  const text = String.raw`\begin{document}
\begin{equation}
  a = 1
\end{equation}
\begin{align}
  b &= \begin{cases} 1 \\ 2 \end{cases} \\
  c &= 3 \nonumber \\
  d &= 4 \label{eq:d}
\end{align}
\begin{equation*} e \end{equation*}
\begin{gather}
  f \tag{*} \\
  g \\
\end{gather}
\begin{multline}
  h \\ i
\end{multline}
\end{document}`;
  const items = parseVisual(text), lineOf = position => text.slice(0, position).split('\n').length;
  assert.deepEqual(items.map(numberedRows), [1, 2, 0, 1, 1], 'inner cases, \\nonumber, \\tag and a trailing \\\\ take no number');
  const records = [{ line: 4, numbers: ['1.1'] }, { line: 9, numbers: ['1.2', '1.3'] }, { line: 14, numbers: ['1.4'] }, { line: 17, numbers: ['1.5'] }];
  assignNumbers(items, records, lineOf);
  assert.deepEqual(items.map(item => item.numbers), [['1.1'], ['1.2', '1.3'], undefined, ['1.4'], ['1.5']]);
  const align = renderMath(katex, items[1]);
  assert.ok(align.includes('1.2') && align.includes('1.3'));
  assert.equal(mathSource(items[1]).tagged.match(/\\tag\{/g).length, 2);
  assert.match(mathSource(items[1]).tagged, /\\end\{cases\} \\tag\{1\.2\}/, 'the number goes on its own row');
  assert.match(mathSource(items[1]).tagged, /c &= 3\s*\\\\\s*d &= 4\s*\\tag\{1\.3\}/, 'the \\nonumber row gets none');
  assert.match(mathSource(items[3]).tagged, /f \\tag\{\*\}\s*\\\\\s*g\s*\\tag\{1\.4\}/, 'the document\'s own \\tag stays');
  assert.ok(renderMath(katex, items[4]).includes('1.5'));
  const eqn = { tex: 'l &=& 13 \\\\ m &=& 14', env: 'eqnarray', display: true, numbers: ['3.4', '3.5'] };
  assert.match(mathSource(eqn).tagged, /^\\begin\{align\*\}l &= 13 \\tag\{3\.4\}\\\\ m &= 14\\tag\{3\.5\}\\end\{align\*\}$/);
  assert.ok(renderMath(katex, eqn).includes('3.5'));

  const shifted = parseVisual('line above\n' + text);
  assignNumbers(shifted, records, position => ('line above\n' + text).slice(0, position).split('\n').length);
  assert.deepEqual(shifted[1].numbers, ['1.2', '1.3'], 'typing above the formulas keeps their numbers');
  const added = parseVisual(text.replace('\\end{document}', '\\begin{equation} new \\end{equation}\n\\end{document}'));
  assignNumbers(added, records, position => text.slice(0, position).split('\n').length);
  assert.equal(added.at(-1).numbers, undefined, 'a formula the build has not seen shows no number yet');
  const stale = parseVisual(text);
  assignNumbers(stale, [{ line: 4, numbers: ['1.1'] }, { line: 9, numbers: ['1.2'] }], lineOf);
  assert.deepEqual(stale[0].numbers, ['1.1']);
  assert.equal(stale[1].numbers, undefined, 'a row count that disagrees gets no number rather than a wrong one');
  const labelled = { tex: 'a\\label{x}', env: 'equation', display: true };
  assert.equal(mathSource(labelled, { x: '7' }).tagged, 'a\\tag{7}', 'before the first build with numbers, a label still works');
});

test('the build\'s equation notes are read back per source file', async () => {
  const dir = project({ 'paper/main.tex': '' }), out = join(dir, '.starport', 'latex', 'x');
  mkdirSync(join(out, 'parts'), { recursive: true });
  writeFileSync(join(out, 'main.aux'), '\\relax\n%starport-eq||main.tex|8|;1.1\n%starport-eq|parts|two.tex|4|;2.1;2.2\n\\newlabel{a}{{1.1}{1}}\n');
  writeFileSync(join(out, 'parts', 'ch.aux'), '%starport-eq|parts/|ch.tex|2|;3.1\n%starport-eq|../..|up.tex|1|;9\n');
  const { equations, labels } = await readLabels(out, { rootDir: join(dir, 'paper'), workspace: dir });
  assert.equal(labels.a, '1.1');
  assert.deepEqual(equations['paper/main.tex'], [{ line: 8, numbers: ['1.1'] }]);
  assert.deepEqual(equations['paper/parts/two.tex'], [{ line: 4, numbers: ['2.1', '2.2'] }]);
  assert.deepEqual(equations['paper/parts/ch.tex'], [{ line: 2, numbers: ['3.1'] }]);
  assert.equal(Object.keys(equations).length, 3, 'a path outside the working folder is dropped');
});

const texTools = await findTex().catch(() => null);
const texRuns = texTools && await new Promise(done => execFile(texTools.latexmk, ['-v'], { timeout: 20000, windowsHide: true }, error => done(!error)));
test('real builds record every number, change nothing in the PDF, and cope with a name with spaces', { skip: texRuns ? false : 'TeX (latexmk) is not runnable here', timeout: 170000 }, async () => {
  const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\numberwithin{equation}{section}
\begin{document}
\section{One}
\begin{equation}
  a = 1
\end{equation}
\begin{subequations}
\begin{align}
  f &= 6 \\
  g &= 7
\end{align}
\end{subequations}
\input{parts/two}
\end{document}
`;
  for (const name of ['main.tex', 'my paper 论文.tex']) {
    const dir = project({ [name]: source, 'parts/two.tex': '\\section{Two}\n\\begin{equation}\n  z = 0\n\\end{equation}\n' });
    const builds = new LatexBuilds({ tools: async () => texTools });
    const proj = { workspace: dir, root: join(dir, name), rootRel: name, engine: 'pdflatex', outDir: buildFolder(dir, name) };
    try {
      builds.request(proj);
      const end = Date.now() + 80000;
      while (builds.status(proj).state !== 'idle' && Date.now() < end) await new Promise(r => setTimeout(r, 100));
      const status = builds.status(proj);
      assert.equal(status.ok, true, name + JSON.stringify(status.errors) + status.tail);
      const { equations } = await readLabels(proj.outDir, { rootDir: dir, workspace: dir });
      assert.deepEqual(equations[name].map(r => r.numbers), [['1.1'], ['1.2a', '1.2b']], name);
      assert.deepEqual(equations['parts/two.tex'].map(r => r.numbers), [['2.1']], name);
      const pdf = join(proj.outDir, name.replace(/\.tex$/, '') + '.pdf');
      const back = await synctexEdit({ synctex: texTools.synctex, pdf, page: 1, x: 300, y: 165 });
      assert.ok(back?.file.endsWith('.tex'), 'SyncTeX still answers');
    } finally { await builds.close(); }
  }
});

test('reading a long paper stays quick', () => {
  const block = String.raw`\section{S} Text with $a^2+b^2$ and \textbf{bold} and \cite{k}.
\begin{equation}\int_0^1 x\,dx\label{e}\end{equation}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
`;
  const text = block.repeat(3000), start = performance.now(), items = parseVisual(text);
  assert.equal(items.length, 3000 * 6);
  assert.ok(performance.now() - start < 400, `${Math.round(performance.now() - start)} ms for ${text.length} characters`);
});

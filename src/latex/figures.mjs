// What the visual mode needs from the computer's TeX and the last build: one picture compiled alone
// with the document's real preamble, the numbers the build gave labels and citations, and the
// graphics a document includes. Pictures run under the same limits as whole builds (build.mjs).
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { startProcess, stopProcess } from '../process.mjs';
import { needsLuaConsent, texEnvironment } from './build.mjs';
import { inside, toPosix } from './project.mjs';

const fail = (message, status = 400, data) => Object.assign(new Error(message), { status, ...(data ? { data } : {}) });
const exe = name => (process.platform === 'win32' ? name + '.exe' : name);
const PICTURE = /^\\(?:begin\s*\{(?:tikzpicture|tikzcd|circuitikz|pgfpicture)\}|feynmandiagram(?![a-zA-Z])|tikz(?![a-zA-Z]))/;
const MAX_CODE = 200000, KEEP = 400;

export const preambleOf = source => {
  const at = String(source || '').search(/\\begin\s*\{document\}/);
  return at < 0 ? null : source.slice(0, at);
};
// The picture as its own tight page. Pictures that \tikzexternalize would farm out are drawn directly.
export const figureSource = (preamble, code) => `${preamble}
\\usepackage[active,tightpage]{preview}
\\setlength\\PreviewBorder{2pt}
\\AtBeginDocument{\\ifdefined\\tikzexternaldisable\\tikzexternaldisable\\fi}
\\begin{document}
\\begin{preview}
${code}
\\end{preview}
\\end{document}
`;

export class LatexFigures {
  constructor({ tools, timeoutMs = 45000, limit = 2 }) {
    this.tools = tools; this.timeoutMs = timeoutMs; this.limit = limit;
    this.pending = new Map(); this.waiting = []; this.running = 0; this.children = new Set(); this.closed = false;
  }
  async slot() {
    if (this.running < this.limit) { this.running++; return; }
    await new Promise(resolve => this.waiting.push(resolve));
  }
  release() { const next = this.waiting.shift(); if (next) next(); else this.running--; }
  // rawPreamble compiles, with its \input lines; fullPreamble has those files written in, so that
  // editing a macro file gives a new picture rather than the saved one.
  async render(project, code, { rawPreamble, fullPreamble }) {
    if (typeof code !== 'string' || !code.trim() || code.length > MAX_CODE || !PICTURE.test(code.trim())) throw fail('这段内容不是图');
    if (rawPreamble === null) throw fail('主文件里没有 \\begin{document}');
    if (needsLuaConsent(project)) throw fail('这篇文档要先允许 LuaLaTeX', 409, { needsLua: true });
    const tools = await this.tools();
    if (!tools) throw fail('本机没有找到 TeX（latexmk），还不能编译。', 501);
    const hash = createHash('sha256').update([project.engine, fullPreamble, code.trim()].join('\0')).digest('hex').slice(0, 32);
    const folder = join(project.outDir, 'figures'), pdf = join(folder, hash + '.pdf');
    try { return await readFile(pdf); } catch {}
    if (!this.pending.has(pdf)) {
      const work = this.compile(project, tools, { folder, hash, pdf, source: figureSource(rawPreamble, code.trim()) }).finally(() => this.pending.delete(pdf));
      this.pending.set(pdf, work);
    }
    return this.pending.get(pdf);
  }
  async compile(project, tools, { folder, hash, pdf, source }) {
    await this.slot();
    try {
      if (this.closed) throw fail('星港正在关闭', 503);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, hash + '.tex'), source);
      const command = tools.engine || join(tools.dir, exe(project.engine));
      const args = [...(tools.prefix || []), '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-output-directory=' + folder, hash + '.tex'];
      const child = startProcess(command, args, { cwd: dirname(project.root), env: texEnvironment(project) });
      this.children.add(child);
      child.stdin.end(); child.stdout.resume(); child.stderr.resume();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; stopProcess(child).catch(() => {}); }, this.timeoutMs);
      const code = await new Promise(done => { child.once('error', () => done(-1)); child.once('close', done); });
      clearTimeout(timer); this.children.delete(child);
      const log = await readFile(join(folder, hash + '.log'), 'utf8').catch(() => '');
      await Promise.all(['.tex', '.aux', '.log', '.out', '.toc', '.xdv'].map(ext => rm(join(folder, hash + ext), { force: true }).catch(() => {})));
      if (timedOut) throw fail('这张图编译超时', 422);
      if (code !== 0) { await rm(pdf, { force: true }).catch(() => {}); throw fail(firstError(log) || '这张图没能编译', 422); }
      const bytes = await readFile(pdf).catch(() => null);
      if (!bytes) throw fail('这张图没能编译', 422);
      this.prune(folder);
      return bytes;
    } finally { this.release(); }
  }
  async prune(folder) {
    try {
      const names = (await readdir(folder)).filter(name => name.endsWith('.pdf'));
      if (names.length <= KEEP) return;
      const dated = await Promise.all(names.map(async name => ({ name, at: (await stat(join(folder, name))).mtimeMs })));
      dated.sort((a, b) => a.at - b.at);
      await Promise.all(dated.slice(0, names.length - KEEP).map(({ name }) => rm(join(folder, name), { force: true })));
    } catch {}
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.children].map(child => stopProcess(child).catch(() => {})));
    for (const next of this.waiting.splice(0)) next();
  }
}
function firstError(log) {
  for (const line of String(log).split(/\r?\n/)) {
    const match = /^(?:.*?\.tex:\d+: |! )(.+)$/.exec(line);
    if (match) return match[1].trim().slice(0, 200);
  }
  return '';
}

// --- labels and citations from the last build -----------------------------------------------
function group(text, at) {
  if (text[at] !== '{') return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return { value: text.slice(at + 1, i), end: i + 1 };
  }
  return null;
}
const number = value => value.replace(/\\[a-zA-Z@]+\s*/g, '').replace(/[{}]/g, '').trim();
export function parseAux(text, into = { labels: {}, cites: {}, equations: [] }) {
  // The numbers each formula environment used (EQUATION_HOOKS in build.mjs).
  for (const match of String(text).matchAll(/^%starport-eq\|([^|\r\n]*)\|([^|\r\n]+)\|(\d+)\|([^\r\n]*)$/gm)) {
    const numbers = match[4].split(';').map(value => value.trim()).filter(Boolean);
    if (numbers.length) (into.equations ??= []).push({ folder: match[1].trim(), file: match[2].trim(), line: Number(match[3]), numbers });
  }
  for (const match of String(text).matchAll(/\\newlabel\{([^{}]+)\}/g)) {
    if (match[1].endsWith('@cref')) continue;
    const whole = group(text, match.index + match[0].length), first = whole && group(whole.value, 0);
    if (first) into.labels[match[1]] = number(first.value);
  }
  for (const match of String(text).matchAll(/\\bibcite\{([^{}]+)\}/g)) {
    const whole = group(text, match.index + match[0].length);
    if (!whole) continue;
    const first = group(whole.value, 0);
    into.cites[match[1]] = number(first ? first.value : whole.value);
  }
  return into;
}
// equations comes back per source file, as working-folder paths, in the order the build met them.
export async function readLabels(outDir, { rootDir = null, workspace = null } = {}) {
  const out = { labels: {}, cites: {}, equations: [] }, byFile = {};
  let names = [];
  try { names = await readdir(outDir, { recursive: true }); } catch {}
  let budget = 8 * 1024 * 1024;
  for (const name of names.filter(file => file.endsWith('.aux') && !/^figures[\\/]/.test(file)).slice(0, 200)) {
    const text = await readFile(join(outDir, name), 'utf8').catch(() => '');
    budget -= text.length;
    if (budget < 0) break;
    parseAux(text, out);
  }
  if (rootDir && workspace) for (const { folder, file, line, numbers } of out.equations) {
    const full = resolve(rootDir, folder, file);
    if (inside(workspace, full)) (byFile[toPosix(relative(workspace, full))] ??= []).push({ line, numbers });
  }
  return { labels: out.labels, cites: out.cites, equations: byFile };
}

// --- graphics ---------------------------------------------------------------------------------
const IMAGE = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const MAX_IMAGE = 40 * 1024 * 1024;
export function graphicPaths(preamble) {
  const match = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/.exec(String(preamble || '').replace(/(^|[^\\])%.*$/gm, '$1'));
  return match ? [...match[1].matchAll(/\{([^{}]*)\}/g)].map(entry => entry[1].trim()).filter(Boolean) : [];
}
// The file \includegraphics means, looked for as TeX would and only below the main file's folder.
export async function findGraphic(rootDir, name, preamble) {
  const clean = String(name || '').trim();
  if (!clean || clean.length > 500 || clean.includes('\0') || isAbsolute(clean)) throw fail('文件路径无效');
  const real = await realpath(rootDir), ext = extname(clean).toLowerCase();
  const stems = ['', ...graphicPaths(preamble)].map(dir => resolve(real, dir, clean));
  const candidates = IMAGE[ext] ? stems : stems.flatMap(stem => Object.keys(IMAGE).map(suffix => stem + suffix));
  for (const candidate of candidates) {
    if (!inside(real, candidate)) continue;
    try {
      const file = await realpath(candidate);
      if (!inside(real, file)) continue;
      const info = await stat(file);
      if (info.isFile() && info.size <= MAX_IMAGE && IMAGE[extname(file).toLowerCase()]) return { file, type: IMAGE[extname(file).toLowerCase()] };
    } catch {}
  }
  throw fail('没有找到这张图', 404);
}

// Builds a LaTeX project with the computer's own TeX installation (latexmk), reads the log into
// errors and warnings, and answers SyncTeX questions. Builds run on the host, outside any model's
// sandbox, so they stay narrow: no project latexmkrc (it is Perl), only the three PDF engines, the
// installation's restricted shell escape, and TeX may read only files under the main file's folder.
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startProcess, stopProcess } from '../process.mjs';
import { inside, toPosix } from './project.mjs';

const WIN = process.platform === 'win32';
const exe = name => (WIN ? name + '.exe' : name);
const ENGINE_FLAG = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

// TeX programs: STARPORT_TEX_BIN, then PATH, then where TeX Live, MiKTeX and MacTeX usually install.
async function texDirs(env) {
  const dirs = [env.STARPORT_TEX_BIN, ...(env.PATH || env.Path || '').split(delimiter)].filter(Boolean);
  const years = async base => {
    try { return (await readdir(base)).filter(name => /^\d{4}$/.test(name)).sort().reverse().map(year => join(base, year)); } catch { return []; }
  };
  if (WIN) {
    for (const root of await years('C:\\texlive')) dirs.push(join(root, 'bin', 'windows'), join(root, 'bin', 'win64'), join(root, 'bin', 'win32'));
    for (const base of [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'MiKTeX'), env.ProgramFiles && join(env.ProgramFiles, 'MiKTeX')].filter(Boolean))
      dirs.push(join(base, 'miktex', 'bin', 'x64'));
  } else {
    dirs.push('/Library/TeX/texbin');
    for (const root of await years('/usr/local/texlive')) for (const arch of ['x86_64-linux', 'aarch64-linux', 'universal-darwin']) dirs.push(join(root, 'bin', arch));
    dirs.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin');
  }
  return [...new Set(dirs)];
}
let found = null;
export async function findTex({ env = process.env, fresh = false } = {}) {
  if (!fresh && found && Date.now() - found.at < 60000) return found.tools;
  let tools = null;
  for (const dir of await texDirs(env)) {
    const latexmk = join(dir, exe('latexmk'));
    try { await access(latexmk, constants.X_OK); } catch { continue; }
    const synctex = join(dir, exe('synctex'));
    tools = { dir, latexmk, synctex: await access(synctex, constants.X_OK).then(() => synctex, () => null) };
    break;
  }
  found = { at: Date.now(), tools };
  return tools;
}

// Build output lives in the working folder's .starport folder, where models can read the log too.
export function buildFolder(workspace, rootRel) {
  const stem = rootRel.replace(/\.[^./]+$/, '').replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'main';
  return join(workspace, '.starport', 'latex', stem + '-' + createHash('sha1').update(rootRel.toLowerCase()).digest('hex').slice(0, 6));
}

// --- the log -------------------------------------------------------------------------------------
const FILE_LINE = /^(.*?\.(?:tex|sty|cls|bbl|aux|toc|ltx|dtx|def|cfg|clo|fd|bib|ins)):(\d+): (.*)$/i;
const OPENED = /^\(((?:[A-Za-z]:)?[^\s()"{}]*[\\/][^\s()"{}]*\.[A-Za-z0-9]{1,8})(?=[\s()]|$)/;
// TeX prints "(file" when it opens a file and ")" when it closes it; the open file at a warning
// is where the warning came from. Parentheses that are not file names still pair up.
function trackFiles(line, stack) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '(') {
      const match = OPENED.exec(line.slice(i));
      stack.push(match ? match[1] : null);
      if (match) i += match[1].length;
    } else if (line[i] === ')' && stack.length) stack.pop();
  }
}
export function parseLog(log, { rootDir = null, workspace = null } = {}) {
  const lines = String(log || '').split(/\r?\n/), errors = [], warnings = [], stack = [], seen = new Set();
  let badboxes = 0;
  const where = file => {
    if (!file) return null;
    const full = rootDir ? resolve(rootDir, file) : file;
    return workspace && inside(workspace, full) ? toPosix(relative(workspace, full)) : null;
  };
  const current = () => stack.findLast(Boolean) || null;
  const add = (list, item) => {
    const key = [list === errors, item.file, item.line, item.message].join('\0');
    if (seen.has(key) || list.length >= 60) return;
    seen.add(key); list.push(item);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = FILE_LINE.exec(line);
    if (match) {
      const path = where(match[1]);
      add(errors, { file: path, external: !path, name: basename(match[1]), line: Number(match[2]), message: match[3].trim() });
      continue;
    }
    if (line.startsWith('! ')) {
      let at = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) { const l = /^l\.(\d+)/.exec(lines[j]); if (l) { at = Number(l[1]); break; } }
      const path = where(current());
      add(errors, { file: path, external: !path && !!current(), name: current() ? basename(current()) : null, line: at, message: line.slice(2).trim() });
      continue;
    }
    match = /^(?:LaTeX|Package ([\w@.-]+)|Class ([\w@.-]+)|LaTeX Font) Warning: (.*)$/.exec(line);
    if (match) {
      let text = match[3];
      while (i + 1 < lines.length && /^\([\w@.-]+\)\s+\S/.test(lines[i + 1])) text += ' ' + lines[++i].replace(/^\([\w@.-]+\)\s+/, '');
      const at = / on input line (\d+)\.?\s*$/.exec(text), path = where(current());
      add(warnings, { file: path, external: !path && !!current(), name: current() ? basename(current()) : null, line: at ? Number(at[1]) : null, source: match[1] || match[2] || 'LaTeX', message: text.replace(/\s+/g, ' ').trim() });
      trackFiles(line, stack);
      continue;
    }
    if (/^(?:Overfull|Underfull) \\[hv]box/.test(line)) badboxes++;
    trackFiles(line, stack);
  }
  return { errors, warnings, badboxes };
}

// Inputs recorded by -recorder (the .fls file): the project's own files the last build read.
async function recordedInputs(fls, workspace, outDir) {
  let text;
  try { text = await readFile(fls, 'utf8'); } catch { return []; }
  let pwd = null;
  const files = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('PWD ')) pwd = line.slice(4).trim();
    else if (line.startsWith('INPUT ') && pwd) {
      const full = resolve(pwd, line.slice(6).trim());
      if (inside(workspace, full) && !inside(outDir, full)) files.add(full);
    }
  }
  return [...files].slice(0, 400);
}

// --- builds ----------------------------------------------------------------------------------
// LuaLaTeX's font loader opens TeX's own files by absolute path, so it cannot run under the rule that
// keeps TeX below the main file's folder. A source file, which a model may have written, must not lift
// that rule by naming LuaLaTeX: it runs only for a main file the user has allowed in the editor.
export const needsLuaConsent = project => project.engine === 'lualatex' && !project.luaAllowed;
export const texEnvironment = project => ({
  openin_any: project.engine === 'lualatex' && project.luaAllowed ? 'r' : 'p',
  max_print_line: '1000', error_line: '254', half_error_line: '238'
});
const NO_EXTERNALIZE = '\\AddToHook{begindocument/end}{\\ifdefined\\tikzexternaldisable\\tikzexternaldisable\\fi}';
// Every numbered formula's real number, for the visual mode: around each environment the build notes
// which numbers it used, as a comment in the .aux file. Nothing is typeset, and a LaTeX too old for
// these hooks just skips them.
const HOOKS_FILE = 'starport-hooks', LOAD_HOOKS = `\\InputIfFileExists{${HOOKS_FILE}}{}{}`;
export const EQUATION_HOOKS = String.raw`\makeatletter
\ifdefined\AddToHook\ifdefined\CurrentFile
\def\starport@eqbefore{\@ifundefined{c@equation}{}{\xdef\starport@eqfrom{\the\c@equation}}}
\def\starport@eqafter{\@ifundefined{c@equation}{}{\if@filesw\ifnum\c@equation>\starport@eqfrom\relax
  \begingroup
    \edef\starport@to{\the\c@equation}\count@=\starport@eqfrom\relax\let\starport@list\@empty
    \loop\ifnum\count@<\starport@to\relax
      \advance\count@\@ne\c@equation=\count@
      \protected@edef\starport@list{\starport@list;\theequation}%
    \repeat
    \immediate\write\@auxout{\@percentchar starport-eq|\CurrentFilePath|\CurrentFile|\the\inputlineno|\detokenize\expandafter{\starport@list}}%
  \endgroup
\fi\fi}}
\def\starport@tmp#1{\AddToHook{env/#1/before}{\starport@eqbefore}\AddToHook{env/#1/after}{\starport@eqafter}}
\starport@tmp{equation}\starport@tmp{align}\starport@tmp{gather}\starport@tmp{flalign}\starport@tmp{alignat}\starport@tmp{multline}\starport@tmp{eqnarray}
\fi\fi
\makeatother
`;
// One build at a time per main file; asking again while it runs builds once more right after.
export class LatexBuilds {
  constructor({ timeoutMs = 180000, tools = findTex } = {}) {
    this.timeoutMs = timeoutMs; this.tools = tools; this.entries = new Map(); this.closed = false;
  }
  key(project) { return WIN ? project.root.toLowerCase() : project.root; }
  entry(project) {
    const key = this.key(project);
    if (!this.entries.has(key)) this.entries.set(key, { id: 0, running: null, again: false, result: null, pdf: null, pdfId: 0, inputs: [], startedAt: 0 });
    return this.entries.get(key);
  }
  status(project) {
    const entry = this.entries.get(this.key(project)), needsLua = needsLuaConsent(project);
    if (!entry) return { id: 0, state: 'idle', pdf: false, ...(needsLua ? { needsLua } : {}) };
    return { id: entry.id, state: entry.running ? (entry.again ? 'queued' : 'running') : 'idle', pdf: !!entry.pdf, pdfId: entry.pdfId, ...entry.result, ...(needsLua ? { needsLua } : {}) };
  }
  pdf(project) { return this.entries.get(this.key(project))?.pdf || null; }
  request(project) {
    if (this.closed) throw Object.assign(new Error('星港正在关闭'), { status: 503 });
    if (needsLuaConsent(project)) return this.status(project);
    const entry = this.entry(project);
    if (entry.running) { entry.again = true; entry.next = project; return this.status(project); }
    entry.running = this.loop(entry, project).catch(() => {}).finally(() => { entry.running = null; });
    return this.status(project);
  }
  // The project's files read by the last build, any of them changed since it started.
  async changedSince(project) {
    const entry = this.entries.get(this.key(project));
    if (!entry?.startedAt || entry.running || !entry.inputs.length) return false;
    for (const file of entry.inputs) {
      try { if ((await stat(file)).mtimeMs > entry.startedAt) return true; } catch { return true; }
    }
    return false;
  }
  async loop(entry, project) {
    do {
      entry.again = false; if (entry.next) { project = entry.next; entry.next = null; }
      await this.run(entry, project);
    } while (entry.again && !this.closed);
  }
  async run(entry, project) {
    const id = ++entry.id, started = Date.now();
    entry.startedAt = started;
    const tools = await this.tools();
    if (!tools) { entry.result = { at: started, ok: false, missing: true, engine: project.engine, errors: [], warnings: [], badboxes: 0, ms: 0, buildId: id }; return; }
    const rootDir = dirname(project.root), base = basename(project.root, extname(project.root)), outDir = project.outDir;
    await mkdir(outDir, { recursive: true });
    const pdfFile = join(outDir, base + '.pdf'), pdfBefore = await stat(pdfFile).then(info => info.mtimeMs, () => 0);
    const hooks = join(outDir, HOOKS_FILE + '.tex');
    if ((await readFile(hooks, 'utf8').catch(() => '')) !== EQUATION_HOOKS) await writeFile(hooks, EQUATION_HOOKS);
    // TeX would name the job after the first file it reads, which is now the hooks.
    const args = [ENGINE_FLAG[project.engine] || '-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-f', '-norc', '-jobname=' + base, '-usepretex=' + (project.externalize ? NO_EXTERNALIZE : '') + LOAD_HOOKS, '-outdir=' + outDir, basename(project.root)];
    let output = '', code = null, timedOut = false;
    // Long log lines stay whole, so file names and line numbers can be read back from them.
    const child = startProcess(tools.latexmk, [...(tools.prefix || []), ...args], { cwd: rootDir, env: texEnvironment(project) });
    entry.child = child;
    child.stdin.end();
    const take = chunk => { output = (output + chunk.toString('utf8')).slice(-20000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; stopProcess(child).catch(() => {}); }, this.timeoutMs);
    code = await new Promise(done => { child.once('error', error => { output += '\n' + error.message; done(-1); }); child.once('close', value => done(value)); });
    clearTimeout(timer); entry.child = null;
    let log = '';
    try { log = await readFile(join(outDir, base + '.log'), 'utf8'); } catch {}
    const parsed = parseLog(log, { rootDir, workspace: project.workspace });
    // A build with nothing to do leaves the PDF as it was; the first one after a restart still reads it.
    // A build that failed before writing a PDF keeps showing the last good one.
    try {
      const info = await stat(pdfFile);
      if (info.mtimeMs !== pdfBefore || !entry.pdf) { entry.pdf = await readFile(pdfFile); entry.pdfId = id; }
    } catch {}
    entry.inputs = await recordedInputs(join(outDir, base + '.fls'), project.workspace, outDir);
    const ok = code === 0 && !!entry.pdf && !parsed.errors.length;
    entry.result = {
      buildId: id, at: started, ms: Date.now() - started, ok, timedOut, engine: project.engine, code, ...parsed,
      log: toPosix(relative(project.workspace, join(outDir, base + '.log'))),
      tail: ok || parsed.errors.length ? '' : output.split(/\r?\n/).filter(line => line.trim()).slice(-25).join('\n')
    };
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.entries.values()].map(entry => (entry.child ? stopProcess(entry.child).catch(() => {}) : null)));
  }
}

// --- SyncTeX ---------------------------------------------------------------------------------
const run = (file, args, cwd) => new Promise((ok, fail) =>
  execFile(file, args, { cwd, timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => (error && !stdout ? fail(error) : ok(stdout))));
// Each result starts with "Output:"; keys are case sensitive (h is across, H is a height).
export function synctexRecords(stdout) {
  const out = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const match = /^(Output|Input|Page|Line|Column|x|y|h|v|W|H):(.*)$/.exec(raw.trim());
    if (!match) continue;
    if (match[1] === 'Output') out.push({});
    else if (out.length) out.at(-1)[match[1]] = match[2].trim();
  }
  return out;
}
// Where a source line ends up in the PDF: boxes in PDF points, measured from each page's top left.
export async function synctexView({ synctex, pdf, file, line, column = 0 }) {
  const stdout = await run(synctex, ['view', '-i', `${line}:${column}:${file}`, '-o', pdf], dirname(pdf));
  // One line gives a record per box it set, often the same box several times.
  const seen = new Set();
  return synctexRecords(stdout).filter(r => r.Page).map(r => {
    const height = Math.max(Number(r.H) || 0, 8);
    return { page: Number(r.Page), left: Number(r.h) || 0, top: Math.max(0, (Number(r.v) || 0) - height), width: Math.max(Number(r.W) || 0, 8), height };
  }).filter(box => { const key = [box.page, box.left, box.top, box.width, box.height].map(v => Math.round(v)).join(); return !seen.has(key) && seen.add(key); }).slice(0, 20);
}
// Which source line made a point on a PDF page.
export async function synctexEdit({ synctex, pdf, page, x, y }) {
  const stdout = await run(synctex, ['edit', '-o', `${page}:${x}:${y}:${pdf}`], dirname(pdf));
  const hit = synctexRecords(stdout).find(r => r.Input);
  return hit ? { file: resolve(hit.Input), line: Math.max(1, Number(hit.Line) || 1) } : null;
}

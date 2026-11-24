// The LaTeX project a conversation's editor works on (public/latex): its files under the conversation's
// working folder, which file is the main one, and which engine builds it. Every path stays inside the
// working folder, links included, and only UTF-8 text files are opened for editing.
import { readdir, readFile, realpath, stat, writeFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const EDITABLE = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.dtx', '.ins', '.def', '.cfg', '.ltx', '.txt', '.md']);
export const MAX_EDIT = 2 * 1024 * 1024;
const MAX_FILES = 5000, MAX_DEPTH = 10, MAX_DIRS = 2000, MAX_CANDIDATES = 300;
const SKIP = new Set(['node_modules', '__pycache__']);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const utf8 = new TextDecoder('utf-8', { fatal: true });

export const hashText = value => createHash('sha1').update(value).digest('hex');
export const toPosix = value => value.split(sep).join('/');
export function inside(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

// A path the browser sent, relative to the working folder. It must stay inside, also after links resolve.
export async function resolveInside(workspace, rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 600 || rel.includes('\0') || isAbsolute(rel)) throw fail('文件路径无效');
  const root = await realpath(workspace), file = resolve(root, rel);
  if (!inside(root, file)) throw fail('文件不在工作目录里', 403);
  let real;
  try { real = await realpath(file); } catch (error) { if (error.code === 'ENOENT') throw fail('文件不存在', 404); throw error; }
  if (!inside(root, real)) throw fail('文件不在工作目录里', 403);
  return { root, file: real, rel: toPosix(relative(root, real)) };
}

// Folders are walked breadth first and depth limited, so a large working folder stays quick.
async function walk(base, visit) {
  let queue = [{ dir: base, depth: 0 }], dirs = 0;
  while (queue.length && dirs < MAX_DIRS) {
    const next = [];
    for (const { dir, depth } of queue) {
      if (++dirs > MAX_DIRS) break;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (depth < MAX_DEPTH && !SKIP.has(entry.name)) next.push({ dir: path, depth: depth + 1 }); }
        else if (entry.isFile() && (await visit(path, depth)) === false) return;
      }
    }
    queue = next;
  }
}

// The editable files of the whole working folder, as working-folder paths. The main file's folder
// is walked first, so in a crowded working folder the project itself is never cut off by the limit.
export async function listFiles(workspace, base = workspace) {
  const root = await realpath(workspace), files = new Set();
  const visit = async path => {
    if (!EDITABLE.has(extname(path).toLowerCase())) return;
    files.add(toPosix(relative(root, path)));
    return files.size < MAX_FILES;
  };
  await walk(base, visit);
  if (files.size < MAX_FILES) await walk(root, visit);
  return [...files];
}

const DOCUMENTCLASS = /^[^%\n]*\\documentclass\b/m;
async function head(path, bytes = 16384) {
  const handle = await open(path, 'r');
  try { const buffer = Buffer.alloc(bytes); const { bytesRead } = await handle.read(buffer, 0, bytes, 0); return buffer.subarray(0, bytesRead).toString('utf8'); }
  finally { await handle.close(); }
}
// Files that could be a main file: .tex files with a \documentclass, shallow ones first.
export async function mainCandidates(workspace) {
  const root = await realpath(workspace), found = [];
  let read = 0;
  await walk(root, async path => {
    if (extname(path).toLowerCase() !== '.tex') return;
    if (++read > MAX_CANDIDATES) return false;
    try { if (DOCUMENTCLASS.test(await head(path))) found.push(toPosix(relative(root, path))); } catch {}
  });
  return found;
}

// The main file with the project's own \input, \include and local packages written in place, so a
// preamble kept in another file counts. Only files below the main file's folder are followed, which
// is all TeX itself may read there. Unchanged files are not read again.
const INCLUDE = /\\(?:input|include|subfile)\s*\{([^{}]+)\}|\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;
const MAX_EXPANDED = 3 * 1024 * 1024, MAX_INCLUDED = 80;
const sources = new Map();
async function readCached(file) {
  const info = await stat(file), hit = sources.get(file);
  if (hit?.mtime === info.mtimeMs && hit.size === info.size) return hit.text;
  const text = await readFile(file, 'utf8');
  if (sources.size > 500) sources.clear();
  sources.set(file, { mtime: info.mtimeMs, size: info.size, text });
  return text;
}
const commented = (text, index) => /(^|[^\\])%/.test(text.slice(text.lastIndexOf('\n', index - 1) + 1, index));
export async function expandedSource(rootFile) {
  const rootDir = dirname(rootFile), seen = new Set([rootFile]);
  let room = MAX_EXPANDED;
  const local = async name => {
    const clean = name.trim();
    if (!clean || isAbsolute(clean) || clean.split(/[\\/]/).includes('..')) return null;
    for (const candidate of [clean, clean + '.tex']) {
      const file = resolve(rootDir, candidate);
      if (seen.has(file) || !inside(rootDir, file) || !extname(file)) continue;
      try { const real = await realpath(file); if (inside(rootDir, real) && (await stat(real)).isFile()) return real; } catch {}
    }
    return null;
  };
  const load = async (file, depth) => {
    const text = await readCached(file).catch(() => '');
    room -= text.length;
    if (room < 0 || depth >= 6) return text;
    let out = '', at = 0;
    for (const match of text.matchAll(INCLUDE)) {
      if (commented(text, match.index) || seen.size >= MAX_INCLUDED) continue;
      const names = match[1] ? [match[1]] : match[2].split(',').map(name => name.trim() + '.sty'), parts = [];
      for (const name of names) {
        const found = await local(name);
        if (found) { seen.add(found); parts.push(await load(found, depth + 1)); }
      }
      if (!parts.length) continue;
      const end = match.index + match[0].length;
      out += text.slice(at, end) + '\n' + parts.join('\n') + '\n';
      at = end;
    }
    return out + text.slice(at);
  };
  return load(rootFile, 0);
}

const uncommented = text => text.replace(/(^|[^\\])%.*$/gm, '$1');
// `% !TEX program = xelatex` wins; Chinese or system-font packages need XeLaTeX; TikZ-Feynman's
// automatic layout (\feynmandiagram, or \diagram without a star) needs LuaLaTeX; otherwise pdfLaTeX.
export const ENGINES = ['pdflatex', 'xelatex', 'lualatex'];
export function detectEngine(source) {
  const text = String(source || '');
  const magic = /^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([a-z]+)/im.exec(text.slice(0, 8000));
  if (magic) {
    const name = magic[1].toLowerCase();
    return { engine: name.startsWith('xe') ? 'xelatex' : name.startsWith('lua') ? 'lualatex' : 'pdflatex', reason: 'magic' };
  }
  const code = uncommented(text), preamble = code.split(/\\begin\s*\{document\}/)[0];
  const uses = names => new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*(?<![\\w-])(?:${names})(?![\\w-])`).test(preamble);
  if (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*ctex(?:art|rep|book|beamer)\s*\}/.test(preamble) || uses('fontspec|xeCJK|ctex|unicode-math|polyglossia'))
    return { engine: 'xelatex', reason: 'packages' };
  if (uses('luatexja|luacode|luaotfload')) return { engine: 'lualatex', reason: 'packages' };
  if (uses('tikz-feynman') && /\\feynmandiagram(?![a-zA-Z])|\\diagram(?![a-zA-Z*])/.test(code)) return { engine: 'lualatex', reason: 'feynman' };
  return { engine: 'pdflatex', reason: 'default' };
}
// \tikzexternalize needs full shell escape, which builds here do not have; such a build draws its
// pictures into the PDF directly instead (build.mjs).
export const usesExternalize = source => /\\tikzexternalize(?![a-zA-Z])/.test(uncommented(String(source || '')));

async function editable(workspace, rel) {
  const target = await resolveInside(workspace, rel);
  if (!EDITABLE.has(extname(target.file).toLowerCase())) throw fail('这类文件不能在编辑器里打开');
  const info = await stat(target.file);
  if (!info.isFile()) throw fail('文件不存在', 404);
  if (info.size > MAX_EDIT) throw fail(`文件超过 ${MAX_EDIT / 1024 / 1024} MB，不能在编辑器里打开`, 413);
  return { ...target, info };
}

// Text is decoded strictly: a file in another encoding is refused rather than rewritten with
// replacement characters on the next save.
export async function readText(workspace, rel) {
  const { file, rel: path, info } = await editable(workspace, rel);
  const bytes = await readFile(file);
  let text;
  try { text = utf8.decode(bytes); } catch { throw fail('这个文件不是 UTF-8 编码，编辑器暂不支持', 415); }
  return { path, text, hash: hashText(bytes), mtime: info.mtimeMs, size: info.size, eol: text.includes('\r\n') ? 'crlf' : 'lf' };
}

// Saves only over the version the editor last saw; anything else is a conflict for the user to settle.
export async function writeText(workspace, rel, text, baseHash, { force = false } = {}) {
  if (typeof text !== 'string') throw fail('文件内容无效');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_EDIT) throw fail(`文件超过 ${MAX_EDIT / 1024 / 1024} MB`, 413);
  const { file, rel: path } = await editable(workspace, rel);
  const current = hashText(await readFile(file));
  if (!force && current !== baseHash) {
    const info = await stat(file);
    throw Object.assign(fail('文件在别处被修改了', 409), { data: { conflict: true, hash: current, mtime: info.mtimeMs } });
  }
  await writeFile(file, bytes);
  const info = await stat(file);
  return { path, hash: hashText(bytes), mtime: info.mtimeMs, size: info.size };
}

export async function fileStamp(workspace, rel) {
  try { const { file, rel: path } = await resolveInside(workspace, rel); const info = await stat(file); return { path, mtime: info.mtimeMs, size: info.size }; }
  catch { return null; }
}

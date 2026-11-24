// LaTeX 编辑器: a conversation linked to a main .tex file in its working folder. The editor page
// (public/latex) reads and saves the project's files, builds it with the computer's TeX and shows the
// PDF; the conversation's model hears, each turn, which file and section the user is in and how the
// last build went. Files stay on disk as the single source, so models edit them like any other file.
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { detectEngine, expandedSource, fileStamp, inside, listFiles, mainCandidates, readText, resolveInside, toPosix, usesExternalize, writeText } from '../latex/project.mjs';
import { LatexBuilds, buildFolder, findTex, synctexEdit, synctexView } from '../latex/build.mjs';
import { LatexFigures, findGraphic, preambleOf, readLabels } from '../latex/figures.mjs';

const LINKS = 'latex.links', LUA = 'latex.luaAllowed', ACTIVE_MS = 5 * 60 * 1000;
const luaKey = file => (process.platform === 'win32' ? file.toLowerCase() : file);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const chatIdOf = value => {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw fail('对话无效');
  return value;
};
const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export class LatexEditor {
  constructor(store, { builds = new LatexBuilds(), tools = findTex } = {}) {
    this.store = store; this.builds = builds; this.tools = tools; this.figures = new LatexFigures({ tools });
    this.presence = new Map(); this.told = new Map();
  }
  links() { return this.store.setting(LINKS, {}) || {}; }
  setLink(id, root) {
    const all = this.links();
    if (root) all[id] = { root }; else delete all[id];
    for (const key of Object.keys(all)) if (!this.store.chat(key)) delete all[key];
    this.store.setSetting(LINKS, all);
  }
  async chat(id) {
    const chat = this.store.chat(chatIdOf(id));
    if (!chat) throw fail('对话不存在', 404);
    if (chat.options?.desk) throw fail('伙伴工位没有 LaTeX 编辑器');
    try { if (!(await stat(chat.workspace)).isDirectory()) throw 0; } catch { throw fail('这个对话的工作目录不存在，请先设置工作目录'); }
    return chat;
  }
  // The linked main file with its engine and build folder; { missing } when the file is gone.
  async project(chat) {
    const link = this.links()[chat.id];
    if (!link) return null;
    let target;
    try { target = await resolveInside(chat.workspace, link.root); } catch { return { missing: link.root }; }
    const source = await expandedSource(target.file).catch(() => '');
    const { engine, reason } = detectEngine(source);
    return {
      workspace: target.root, root: target.file, rootRel: target.rel, engine, engineReason: reason, outDir: buildFolder(target.root, target.rel),
      externalize: usesExternalize(source), luaAllowed: !!this.store.setting(LUA, {})?.[luaKey(target.file)]
    };
  }
  // The user's own choice, from the editor page; a source file cannot make it.
  setLuaAllowed(project, allowed) {
    const all = this.store.setting(LUA, {}) || {}, key = luaKey(project.root);
    if (allowed) all[key] = true; else delete all[key];
    this.store.setSetting(LUA, all);
  }
  async linked(chat) {
    const project = await this.project(chat);
    if (!project || project.missing) throw fail('这个对话还没有选择主文件', 409);
    return project;
  }
  // choose: list the possible main files even though one is linked, to pick another.
  async overview(chat, { choose = false } = {}) {
    const project = await this.project(chat), tex = !!(await this.tools());
    const chatTitle = chat.title;
    if (!project || project.missing) return { chatTitle, workspace: chat.workspace, root: null, missing: project?.missing || null, candidates: await mainCandidates(chat.workspace), tex };
    return {
      chatTitle, workspace: chat.workspace, root: project.rootRel, engine: project.engine, engineReason: project.engineReason, tex,
      luaAllowed: project.luaAllowed, files: await listFiles(project.workspace, dirname(project.root)), build: this.builds.status(project),
      ...(choose ? { candidates: await mainCandidates(chat.workspace) } : {})
    };
  }

  async handle(path, method, read, request = {}) {
    const query = request.url?.searchParams || new URLSearchParams();
    try { return { status: 200, ...(await this.route(path, method, read, query)) }; }
    catch (error) {
      if (!error.status) throw error;
      return { status: error.status, data: { error: error.message, ...error.data } };
    }
  }
  async route(path, method, read, query) {
    const input = method === 'GET' ? Object.fromEntries(query) : await read();
    const chat = await this.chat(input.chatId);
    if (path === '/api/latex/project' && method === 'GET') return { data: await this.overview(chat, { choose: input.choose === '1' }) };
    if (path === '/api/latex/link' && method === 'POST') {
      if (input.root === null) { this.setLink(chat.id, null); return { data: await this.overview(chat) }; }
      const target = await resolveInside(chat.workspace, input.root);
      if (extname(target.file).toLowerCase() !== '.tex') throw fail('主文件应是 .tex 文件');
      this.setLink(chat.id, target.rel);
      return { data: await this.overview(chat) };
    }
    if (path === '/api/latex/file' && method === 'GET') return { data: await readText(chat.workspace, input.path) };
    if (path === '/api/latex/file' && method === 'PUT') return { data: await writeText(chat.workspace, input.path, input.text, input.baseHash, { force: input.force === true }) };
    if (path === '/api/latex/watch' && method === 'GET') {
      const project = await this.project(chat), live = project && !project.missing ? project : null;
      this.touch(chat.id);
      if (live && input.auto === '1' && (await this.builds.changedSince(live))) this.builds.request(live);
      return { data: { chatTitle: chat.title, file: input.path ? await fileStamp(chat.workspace, input.path) : null, build: live ? this.builds.status(live) : null } };
    }
    if (path === '/api/latex/compile' && method === 'POST') return { data: this.builds.request(await this.linked(chat)) };
    if (path === '/api/latex/lua' && method === 'POST') {
      if (typeof input.allowed !== 'boolean') throw fail('选项无效');
      const project = await this.linked(chat);
      this.setLuaAllowed(project, input.allowed);
      const updated = await this.linked(chat);
      return { data: { allowed: input.allowed, build: input.allowed ? this.builds.request(updated) : this.builds.status(updated) } };
    }
    if (path === '/api/latex/build' && method === 'GET') { const project = await this.project(chat); return { data: project && !project.missing ? this.builds.status(project) : null }; }
    if (path === '/api/latex/pdf' && method === 'GET') {
      const pdf = this.builds.pdf(await this.linked(chat));
      if (!pdf) throw fail('还没有编译出 PDF', 404);
      return { body: pdf, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' } };
    }
    if (path === '/api/latex/synctex' && method === 'POST') return { data: await this.synctex(chat, input) };
    // For the visual mode: the macros and numbers a formula needs, a picture, a graphic.
    if (path === '/api/latex/context' && method === 'GET') {
      const project = await this.linked(chat), full = preambleOf(await expandedSource(project.root).catch(() => '')) || '';
      return { data: { preamble: full.slice(0, 600000), ...(await readLabels(project.outDir, { rootDir: dirname(project.root), workspace: project.workspace })) } };
    }
    if (path === '/api/latex/figure' && method === 'POST') {
      const project = await this.linked(chat);
      const raw = await readFile(project.root, 'utf8'), full = await expandedSource(project.root);
      const pdf = await this.figures.render(project, input.code, { rawPreamble: preambleOf(raw), fullPreamble: preambleOf(full) ?? '' });
      return { body: pdf, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' } };
    }
    if (path === '/api/latex/graphic' && method === 'GET') {
      const project = await this.linked(chat), full = preambleOf(await expandedSource(project.root).catch(() => '')) || '';
      const { file, type } = await findGraphic(dirname(project.root), input.name, full);
      return { body: await readFile(file), headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } };
    }
    if (path === '/api/latex/presence' && method === 'POST') {
      if (input.open === false) this.presence.delete(chat.id);
      else this.presence.set(chat.id, { path: clip(input.path, 300), line: Math.max(1, Number(input.line) || 1), outline: clip(input.outline, 300), at: Date.now() });
      return { data: { ok: true } };
    }
    throw fail('请求方法无效', 405);
  }
  touch(id) { const seen = this.presence.get(id); if (seen) seen.at = Date.now(); }

  async synctex(chat, input) {
    const project = await this.linked(chat), tools = await this.tools();
    if (!tools?.synctex) throw fail('本机 TeX 里没有 synctex，无法在源码和 PDF 之间跳转', 501);
    const pdf = join(project.outDir, basename(project.root, extname(project.root)) + '.pdf');
    try { await stat(pdf); } catch { throw fail('还没有编译出 PDF', 404); }
    if (input.to === 'pdf') {
      const { file } = await resolveInside(chat.workspace, input.path);
      return { boxes: await synctexView({ synctex: tools.synctex, pdf, file, line: Math.max(1, Number(input.line) || 1), column: Math.max(0, Number(input.column) || 0) }) };
    }
    const page = Number(input.page), x = Number(input.x), y = Number(input.y);
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) throw fail('PDF 位置无效');
    const hit = await synctexEdit({ synctex: tools.synctex, pdf, page, x: x.toFixed(2), y: y.toFixed(2) });
    if (!hit || !inside(project.workspace, hit.file)) return { source: null };
    return { source: { path: toPosix(relative(project.workspace, hit.file)), line: hit.line } };
  }

  // What the model hears while the editor is open: where the user is and how the last build went.
  // A resumed session hears it again only when it changed.
  async describe(chat) {
    const seen = this.presence.get(chat.id);
    if (!seen || Date.now() - seen.at > ACTIVE_MS) return '';
    const project = await this.project(chat);
    if (!project || project.missing) return '';
    const status = this.builds.status(project), lines = [`- 主文件：${project.rootRel}（${project.engine}）`];
    if (seen.path) lines.push(`- 用户正在看：${seen.path} 第 ${seen.line} 行${seen.outline ? `（${seen.outline}）` : ''}`);
    if (status.needsLua) lines.push('- 这篇文档要用 LuaLaTeX，等用户在编辑器里允许后才会编译');
    if (status.missing) lines.push('- 本机没有找到 TeX（latexmk），编辑器还不能编译');
    else if (status.at) {
      const errors = status.errors || [], warnings = status.warnings || [];
      lines.push(status.ok
        ? `- 最近一次编译：成功${warnings.length ? `，${warnings.length} 个警告` : ''}`
        : `- 最近一次编译：失败${errors.length ? `，${errors.length} 个错误：` + errors.slice(0, 3).map(e => `${e.file || e.name || ''}${e.line ? ':' + e.line : ''} ${clip(e.message, 160)}`).join('；') : status.timedOut ? '（超时）' : ''}。完整日志：${status.log}`);
    }
    return `星港 LaTeX 编辑器：用户在星港的 LaTeX 编辑器里打开了这个对话关联的项目，编辑会自动保存到磁盘，以磁盘上的文件为准。\n${lines.join('\n')}\n需要时自己读这些文件；要改源码就直接改磁盘上的文件，编辑器会自动载入并重新编译。用户消息里的「引用 … 第 N 行」是他在编辑器里选中的源码。\n`;
  }
  async prompt({ chat, resumed, desk }) {
    if (desk || !chat) return '';
    const text = await this.describe(chat).catch(() => '');
    if (!text) { this.told.delete(chat.id); return ''; }
    if (resumed && this.told.get(chat.id) === text) return '';
    this.told.set(chat.id, text);
    return text;
  }
  close() { return Promise.all([this.builds.close(), this.figures.close()]); }
}

export const ROUTES = ['/api/latex/project', '/api/latex/link', '/api/latex/file', '/api/latex/watch', '/api/latex/compile', '/api/latex/build', '/api/latex/pdf', '/api/latex/synctex', '/api/latex/presence', '/api/latex/lua', '/api/latex/context', '/api/latex/figure', '/api/latex/graphic'];
export const name = 'latex';
export const inject = ['store', 'routes', 'prompts'];
export function apply(ctx) {
  const editor = new LatexEditor(ctx.store);
  for (const path of ROUTES) ctx.effect(() => ctx.routes.add(path, (method, read, request) => editor.handle(path, method, read, request)), 'route ' + path);
  ctx.effect(() => ctx.prompts.add(info => editor.prompt(info)), 'latex prompt');
  ctx.effect(() => () => editor.close(), 'latex builds');
}

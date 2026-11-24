// LaTeX editor page, for one conversation (?chat=<id>). Starport shows it docked beside the
// conversation (in a frame, ?embed=1&place=left|right) or in its own window. Files are saved to disk
// as you type and built with the computer's TeX; a selection goes to the conversation's composer as a
// quote card, over a BroadcastChannel shared with Starport's page (public/latex-dock.js).
import { createSource } from './source.js';
import { createPdf, pdfToImage } from './pdf-view.js';
import { createSnip } from './pdf-snip.js';
import { createVisual } from './visual.js';
import { buildTree, byName, createTree } from './tree.js?v=1';

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const chatId = params.get('chat') || '';
const embedded = params.get('embed') === '1' && window.parent !== window;
let place = embedded ? (params.get('place') === 'left' ? 'left' : 'right') : 'window';
let token = document.querySelector('meta[name="hub-token"]')?.content || '';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('starport-latex') : null;
const fill = (text, values = {}) => String(text).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const t = (text, values) => globalThis.StarportI18n?.t(text, values) ?? fill(text, values);
document.documentElement.classList.toggle('embedded', embedded);

const store = {
  get: (key, fallback = null) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} }
};
const pdfThemeKey = 'starport-latex-pdf-theme';
const state = {
  project: null, path: null, file: null, dirty: false, saving: null, again: false, conflict: null,
  build: null, shownBuild: 0, pdfId: 0, auto: store.get('starport-latex-auto') !== '0', view: store.get('starport-latex-view', 'split'), visual: store.get('starport-latex-visual') !== '0'
};
let source = null, pdf = null, tree = null, visual = null, saveTimer = null, cursorTimer = null, selectionTimer = null, lastLine = 1;

function translatePage() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(Boolean));
  return node;
}
let toastTimer = null;
function toast(message) {
  let node = $('.toast');
  if (!node) document.body.append((node = el('div', { class: 'toast', role: 'status' })));
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3200);
}

// Starport changes its token when it restarts; the page fetches the new one once and tries again.
async function refreshToken() {
  const html = await (await fetch(location.pathname + location.search, { cache: 'no-store' })).text();
  const fresh = /name="hub-token" content="([^"]+)"/.exec(html)?.[1];
  if (fresh && fresh !== token) { token = fresh; return true; }
  return false;
}
async function api(path, { method = 'GET', body, query = {}, keepalive = false } = {}, retried = false) {
  const url = new URL('/api/latex/' + path, location.origin);
  if (method === 'GET') { url.searchParams.set('chatId', chatId); for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value); }
  const response = await fetch(url, {
    method, keepalive, headers: { 'X-Hub-Token': token, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ chatId, ...body }) })
  });
  if ((response.status === 401 || response.status === 403) && !retried && !keepalive && (await refreshToken().catch(() => false)))
    return api(path, { method, body, query, keepalive }, true);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(t(data.error || '请求失败 ({status})', { status: response.status })), { status: response.status, data });
  return data;
}
const post = (message) => channel?.postMessage({ chatId, ...message });
// A file from the server as bytes, for the pictures and graphics the visual mode draws.
async function bytes(path, { method = 'GET', body, query = {} } = {}, retried = false) {
  const url = new URL('/api/latex/' + path, location.origin);
  if (method === 'GET') { url.searchParams.set('chatId', chatId); for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value); }
  const response = await fetch(url, {
    method, headers: { 'X-Hub-Token': token, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ chatId, ...body }) })
  });
  if ((response.status === 401 || response.status === 403) && !retried && (await refreshToken().catch(() => false))) return bytes(path, { method, body, query }, true);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(t(data.error || '请求失败 ({status})', { status: response.status })), { status: response.status, needsLua: !!data.needsLua });
  }
  return { type: response.headers.get('content-type') || '', data: await response.arrayBuffer() };
}

// --- choosing the main file ------------------------------------------------------------------
function mainFilePicker(files, current, pick) {
  const breadcrumbs = el('nav', { class: 'picker-path', 'aria-label': t('主文件路径') });
  const entries = el('ul', { class: 'candidates' });
  function showFolder(trail, focus = false) {
    const folder = trail.at(-1);
    const crumbs = trail.map((dir, index) => {
      const name = dir.name || t('工作目录');
      return dir === folder
        ? el('span', { text: name, 'aria-current': 'location', tabindex: '-1' })
        : el('button', { type: 'button', text: name, onclick: () => showFolder(trail.slice(0, index + 1), true) });
    });
    const folders = [...folder.dirs.values()].sort(byName).map(dir => el('li', {}, [
      el('button', { type: 'button', class: 'tree-row folder', onclick: () => showFolder([...trail, dir], true) }, [
        el('span', { class: 'chevron', 'aria-hidden': 'true' }),
        el('span', { class: 'tree-name', text: dir.name })
      ])
    ]));
    const tex = folder.files.sort(byName).map(file => {
      const active = file.path === current;
      return el('li', {}, [
        el('button', { type: 'button', class: 'tree-row file' + (active ? ' current' : ''), title: file.path, onclick: () => pick(file.path) }, [
          el('span', { class: 'chevron', 'aria-hidden': 'true' }),
          el('span', { class: 'tree-name', text: file.name }),
          active ? el('span', { class: 'tree-badge', text: t('主文件') }) : null
        ])
      ]);
    });
    breadcrumbs.replaceChildren(...crumbs);
    entries.replaceChildren(...folders, ...tex);
    entries.scrollTop = 0;
    if (focus) crumbs.at(-1).focus();
  }
  showFolder([buildTree(files)]);
  return el('div', { class: 'main-file-picker' }, [breadcrumbs, entries]);
}
function renderSetup(data) {
  const setup = $('#setup');
  $('#work').hidden = true; $('#problems').hidden = true; setup.hidden = false;
  document.body.classList.add('choosing');
  const pick = async root => {
    try { state.project = await api('link', { method: 'POST', body: { root } }); await start(); }
    catch (error) { toast(error.message); }
  };
  const input = el('input', { type: 'text', placeholder: 'paper/main.tex', 'aria-label': t('主文件路径') });
  setup.replaceChildren(...[
    el('h1', { text: t('选择这个对话的主文件') }),
    el('p', { text: data.missing ? t('原来的主文件 {path} 找不到了，请重新选择。', { path: data.missing }) : t('主文件是含 \\documentclass 的那个 .tex 文件。编译、预览和跳转都从它开始。') }),
    el('p', { class: 'workspace', text: data.workspace }),
    data.candidates?.length
      ? mainFilePicker(data.candidates, data.root, pick)
      : el('p', { text: t('工作目录里没有找到含 \\documentclass 的 .tex 文件。可以在下面填写路径，或先让模型建一个。') }),
    el('form', { class: 'other', onsubmit: event => { event.preventDefault(); if (input.value.trim()) pick(input.value.trim()); } }, [
      input, el('button', { type: 'submit', class: 'action', text: t('使用这个文件') }),
      data.current ? el('button', { type: 'button', class: 'action subtle', text: t('取消'), onclick: () => { setup.hidden = true; document.body.classList.remove('choosing'); $('#work').hidden = false; renderProblems(); } }) : null
    ]),
    data.tex === false ? el('p', { text: t('本机还没有找到 TeX（latexmk）。可以先编辑源码；要编译，请安装 TeX Live 或 MiKTeX。') }) : null
  ].filter(Boolean));
}

// --- files -------------------------------------------------------------------------------------
// The tree shows the whole working folder; the folders down to the file being edited open by
// themselves. Beside a narrow source pane it opens over the source
// and closes once a file is picked; on a wide one it stays open beside it if the user left it so.
const treeOpenKey = 'starport-latex-tree';
const treeWidthKey = 'starport-latex-tree-width';
const defaultTreeWidth = 220;
const minTreeWidth = 150;
const minSourceWidth = 260;
const treeHandleWidth = 6;
const sourceWidth = () => $('.source-pane').clientWidth;
const overlay = () => sourceWidth() < 560;
let wideTreeOpen = store.get(treeOpenKey, '1') === '1';
let treeWidth = Number(store.get(treeWidthKey)) || defaultTreeWidth;
function applyTreeWidth(width = treeWidth) {
  const max = Math.max(minTreeWidth, Math.min(600, sourceWidth() - minSourceWidth - treeHandleWidth));
  const fitted = Math.min(max, Math.max(minTreeWidth, Math.round(width)));
  $('#tree-pane').style.setProperty('--tree-width', fitted + 'px');
  const handle = $('#tree-resize');
  handle.setAttribute('aria-valuemin', minTreeWidth);
  handle.setAttribute('aria-valuemax', max);
  handle.setAttribute('aria-valuenow', fitted);
  return fitted;
}
function renderFiles() {
  const project = state.project;
  if (!project?.root || !tree) return;
  const files = project.files || [];
  tree.render({
    base: '', root: project.root, current: state.path,
    files: !state.path || files.includes(state.path) ? files : [state.path, ...files],
    errors: new Set((state.build?.state === 'idle' && state.build.errors || []).map(e => e.file).filter(Boolean))
  });
  $('#tree-title').textContent = String(project.workspace || '').split(/[\\/]/).filter(Boolean).pop() || t('工作目录');
  $('#tree-title').title = project.workspace || '';
  const parts = (state.path || '').split('/');
  $('#file-label').textContent = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : state.path || '';
  $('#tree-toggle').title = (state.path ? state.path + '\n' : '') + t('显示或收起文件列表');
  $('#tree-toggle').disabled = false;
}
function showTree(open, { remember = true } = {}) {
  const pane = $('#tree-pane');
  if (open && state.view === 'pdf') setView('split');
  const narrow = overlay();
  pane.classList.toggle('overlay', open && narrow);
  pane.hidden = !open;
  $('#tree-toggle').setAttribute('aria-expanded', String(open));
  if (remember && !narrow) {
    wideTreeOpen = open;
    store.set(treeOpenKey, open ? '1' : '0');
  }
  if (open) { refreshFiles(); tree?.reveal(state.path || ''); }
}
// When the source pane narrows (split view, a narrower dock) a tree beside it steps aside, and it
// comes back when there is room again, if the user had it open.
function fitTree() {
  const pane = $('#tree-pane');
  if (!tree || !state.project?.root || !$('#setup').hidden || state.view === 'pdf') return;
  if (overlay()) {
    if (!pane.hidden && !pane.classList.contains('overlay')) showTree(false, { remember: false });
    return;
  }
  applyTreeWidth();
  const open = !pane.hidden;
  if (open !== wideTreeOpen) showTree(wideTreeOpen, { remember: false });
  else pane.classList.remove('overlay');
}
function setupTreeResize() {
  const handle = $('#tree-resize');
  const pane = $('#tree-pane');
  const rememberWidth = () => store.set(treeWidthKey, String(treeWidth));
  const resize = width => {
    treeWidth = applyTreeWidth(width);
    rememberWidth();
  };
  handle.addEventListener('dblclick', () => resize(defaultTreeWidth));
  handle.addEventListener('keydown', event => {
    const width = pane.offsetWidth;
    const target = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: minTreeWidth, End: Infinity }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    resize(target);
  });
  let drag = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: pane.offsetWidth };
    handle.classList.add('dragging');
    document.body.classList.add('dragging');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) applyTreeWidth(drag.width + event.clientX - drag.x);
  });
  handle.addEventListener('lostpointercapture', () => {
    if (drag && !pane.hidden && !overlay() && pane.offsetWidth !== drag.width) resize(pane.offsetWidth);
    else applyTreeWidth();
    drag = null;
    handle.classList.remove('dragging');
    document.body.classList.remove('dragging');
  });
}
// Files a model added since appear without reopening the editor.
let refreshing = null;
function refreshFiles() {
  refreshing ??= api('project')
    .then(data => { if (data.root && data.root === state.project?.root) { state.project = { ...state.project, files: data.files, engine: data.engine }; renderFiles(); } })
    .catch(() => {})
    .finally(() => { refreshing = null; });
  return refreshing;
}
async function openFile(path, { line } = {}) {
  if ($('#tree-pane').classList.contains('overlay')) showTree(false);
  if (path === state.path && state.file) { if (line) source.reveal(line); else source.focus(); return; }
  if (state.dirty) await save();
  if (state.conflict) { toast(t('请先处理文件冲突')); renderFiles(); return; }
  let data;
  try { data = await api('file', { query: { path } }); }
  catch (error) { toast(error.message); renderFiles(); return; }
  state.path = data.path; state.file = data; state.dirty = false;
  visual?.setFile(data.path);
  source.load(data.text);
  publishSelection(null);
  store.set('starport-latex-file:' + chatId, data.path);
  renderFiles(); tree?.reveal(data.path); renderSave(); diagnose();
  if (line) source.reveal(line); else source.focus();
  presence();
  await followMain(data.path, data.text);
}
// A file that is a document of its own (an uncommented \documentclass) becomes the main file when
// it is opened, so building, the PDF and SyncTeX follow what is being edited. A part brought in
// with \input keeps the main file as it is. Opening the old one again switches back.
const STANDALONE = /^[^%\n]*\\documentclass\b/m;
async function followMain(path, text) {
  if (!state.project?.root || path === state.project.root || !/\.tex$/i.test(path) || !STANDALONE.test(text.slice(0, 16384))) return;
  let data;
  try { data = await api('link', { method: 'POST', body: { root: path } }); }
  catch (error) { toast(error.message); return; }
  if (!data.root || path !== state.path) return;
  state.project = data;
  $('#lua-revoke').hidden = !data.luaAllowed;
  pdf?.close();
  state.pdfId = 0; state.shownBuild = 0; pdfFailed = 0;
  $('#pdf-download').hidden = true; $('#pdf-snip').disabled = true; $('#pdf-empty').textContent = '';
  onBuild(data.build);
  renderProblems(); diagnose(); renderFiles();
  if (state.visual) refreshContextSoon();
  toast(t('主文件已换成 {path}', { path }));
  if (data.tex && !data.build?.at && state.auto) compile();
}
async function chooseRoot() {
  await save();
  try { renderSetup({ ...(await api('project', { query: { choose: '1' } })), current: true }); } catch (error) { toast(error.message); }
}
function renderSave(note) {
  const node = $('#save-state');
  node.classList.toggle('dirty', state.dirty || !!state.conflict);
  node.textContent = note || (state.conflict ? t('有冲突') : state.saving ? t('正在保存…') : state.dirty ? t('未保存') : state.file ? t('已保存') : '');
}
function scheduleSave() {
  state.dirty = true; renderSave();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 1000);
}
async function save({ force = false, keepalive = false } = {}) {
  clearTimeout(saveTimer);
  if (!state.path || !state.file || (state.conflict && !force)) return;
  if (state.saving) { state.again = true; return state.saving; }
  if (!state.dirty && !force) return;
  const version = source.version(), text = source.text();
  const body = { path: state.path, text: state.file.eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text, baseHash: state.file.hash, force };
  state.saving = api('file', { method: 'PUT', body, keepalive })
    .then(data => {
      state.file = { ...state.file, hash: data.hash, mtime: data.mtime, size: data.size };
      state.conflict = null; hideBanner();
      if (source.version() === version) state.dirty = false;
      if (state.auto) compile();
    })
    .catch(error => {
      if (error.status === 409) { state.conflict = error.data; showConflict(); }
      else toast(error.message);
    })
    .finally(() => {
      state.saving = null; renderSave();
      if (state.again) { state.again = false; if (state.dirty) save(); }
    });
  renderSave();
  return state.saving;
}
// The file changed on disk. Without local edits it is merged in place; with them, the user decides.
async function changedOnDisk() {
  let data;
  try { data = await api('file', { query: { path: state.path } }); } catch { return; }
  if (data.hash === state.file.hash) { state.file.mtime = data.mtime; return; }
  if (state.dirty || state.saving) { state.conflict = data; showConflict(); return; }
  const changed = source.merge(data.text);
  state.file = data;
  renderSave(changed ? t('已载入外部修改（第 {from}–{to} 行）', changed) : undefined);
  setTimeout(() => renderSave(), 5000);
}
function showConflict() {
  const banner = $('#banner');
  banner.hidden = false;
  banner.replaceChildren(
    el('p', { text: t('{path} 在别处被修改了（可能是模型或其他编辑器），这里也有没保存的改动。', { path: state.path }) }),
    el('button', { type: 'button', text: t('载入磁盘上的版本'), onclick: async () => {
      try { const data = await api('file', { query: { path: state.path } }); state.conflict = null; state.dirty = false; state.file = data; source.merge(data.text); hideBanner(); renderSave(); }
      catch (error) { toast(error.message); }
    } }),
    el('button', { type: 'button', text: t('用我的版本覆盖'), onclick: () => { state.dirty = true; save({ force: true }); } })
  );
  renderSave();
}
function hideBanner() { const banner = $('#banner'); banner.hidden = true; delete banner.dataset.kind; banner.replaceChildren(); }
// LuaLaTeX reads outside the main file's folder, so it waits for the user's own yes (build.mjs).
async function allowLua(allowed) {
  try {
    const data = await api('lua', { method: 'POST', body: { allowed } });
    state.project = { ...state.project, luaAllowed: data.allowed };
    visual?.clearFigures(); source?.redrawVisual();
    if ($('#banner').dataset.kind === 'lua') hideBanner();
    $('#lua-revoke').hidden = !data.allowed;
    onBuild(data.build);
  } catch (error) { toast(error.message); }
}
function renderLua() {
  const banner = $('#banner'), needed = !!state.build?.needsLua && !state.conflict;
  if (banner.dataset.kind === 'lua' && !needed) { hideBanner(); return; }
  if (!needed || !banner.hidden) return;
  banner.dataset.kind = 'lua'; banner.hidden = false;
  banner.replaceChildren(
    el('p', { text: t('这篇文档要用 LuaLaTeX。LuaLaTeX 编译时能读到工作目录以外的文件，所以要你先允许。') }),
    el('button', { type: 'button', text: t('允许这个主文件用 LuaLaTeX'), onclick: () => allowLua(true) })
  );
}

// --- building ----------------------------------------------------------------------------------
async function compile() {
  try { onBuild(await api('compile', { method: 'POST', body: {} })); }
  catch (error) { toast(error.message); }
}
let pdfOpening = 0, pdfFailed = 0;
function onBuild(build) {
  if (!build) return;
  state.build = build;
  renderBuild();
  renderLua();
  // A new PDF opens; so does one that should be on show but is not (an open dropped when the main
  // file changed), unless it already failed to open.
  const missing = !!pdf && !pdf.loaded && !pdfOpening && build.pdfId !== pdfFailed;
  if (build.pdf && build.pdfId && pdf && (build.pdfId !== state.pdfId || missing)) {
    const id = (state.pdfId = build.pdfId);
    pdfOpening++;
    pdf.open('/api/latex/pdf?chatId=' + encodeURIComponent(chatId) + '&b=' + id)
      .then(shown => { if (shown) { pdfFailed = 0; $('#pdf-empty').textContent = ''; $('#pdf-download').hidden = false; $('#pdf-snip').disabled = false; } })
      .catch(error => { if (state.pdfId === id) { pdfFailed = id; $('#pdf-empty').textContent = t('PDF 打不开：{error}', { error: error.message }); } })
      .finally(() => { pdfOpening--; });
  }
  if (build.buildId && build.buildId !== state.shownBuild && build.state === 'idle') { state.shownBuild = build.buildId; renderProblems(); diagnose(); renderFiles(); if (!$('#tree-pane').hidden) refreshFiles(); visual?.built(); refreshContextSoon(); }
  $('.pdf-frame').classList.toggle('stale', !!build.pdf && build.state === 'idle' && !build.ok && build.pdfId !== build.buildId);
  if (!build.pdf && !pdf?.loaded) $('#pdf-empty').textContent = build.needsLua ? t('允许使用 LuaLaTeX 后才会编译。') : build.state !== 'idle' ? t('正在编译…') : build.missing ? t('本机没有找到 TeX（latexmk），还不能编译。') : build.at ? t('这次编译没有生成 PDF，见下方的错误。') : t('保存或按 Ctrl S 编译后，PDF 显示在这里。');
}
function renderBuild() {
  const build = state.build, node = $('#build-state');
  node.className = 'build-state';
  if (!build) { node.textContent = ''; return; }
  if (build.state !== 'idle') { node.classList.add('running'); node.textContent = t('正在编译…'); return; }
  if (build.needsLua) { node.classList.add('error'); node.textContent = t('等待允许 LuaLaTeX'); return; }
  if (build.missing) { node.classList.add('error'); node.textContent = t('没有找到 TeX'); return; }
  if (!build.at) { node.textContent = ''; return; }
  const seconds = ((build.ms || 0) / 1000).toFixed(1);
  if (build.ok) { node.classList.add('ok'); node.textContent = t('已编译 · {seconds} 秒', { seconds }) + (build.engine && build.engine !== 'pdflatex' ? ' · ' + build.engine : ''); }
  else { node.classList.add('error'); node.textContent = build.timedOut ? t('编译超时') : build.errors?.length ? t('{count} 个错误', { count: build.errors.length }) : t('编译失败'); }
}
function problems() {
  const build = state.build;
  if (!build || build.state !== 'idle') return [];
  return [...(build.errors || []).map(p => ({ ...p, kind: 'error' })), ...(build.warnings || []).map(p => ({ ...p, kind: 'warning' }))];
}
function diagnose() { if (source && state.path) source.diagnose(problems().filter(p => p.file === state.path)); }
function renderProblems() {
  const build = state.build, list = problems(), footer = $('#problems'), toggle = $('#problems-toggle'), items = $('#problem-list');
  const errors = build?.errors?.length || 0, warnings = build?.warnings?.length || 0;
  const show = !!build && (errors || warnings || build.tail || build.missing || build.badboxes);
  footer.hidden = !show;
  if (!show) return;
  toggle.replaceChildren(...[
    errors ? el('span', { class: 'errors', text: '✕ ' + t('{count} 个错误', { count: errors }) }) : null,
    warnings ? el('span', { class: 'warnings', text: '! ' + t('{count} 个警告', { count: warnings }) }) : null,
    build.badboxes ? el('span', { text: t('{count} 处排版溢出', { count: build.badboxes }) }) : null,
    !errors && !warnings && !build.badboxes ? el('span', { class: 'errors', text: build.missing ? t('没有找到 TeX') : t('编译失败') }) : null
  ].filter(Boolean));
  const expanded = errors > 0 || (!warnings && !!(build.tail || build.missing));
  toggle.setAttribute('aria-expanded', String(expanded)); items.hidden = !expanded;
  items.replaceChildren(...[
    ...list.map(p => el('li', { class: p.kind }, [el('button', {
      type: 'button', disabled: !p.file, title: p.file ? t('打开 {path} 第 {line} 行', { path: p.file, line: p.line || 1 }) : '',
      onclick: () => p.file && (p.file === state.path ? source.reveal(p.line || 1) : openFile(p.file, { line: p.line || 1 }))
    }, [
      el('span', { class: 'kind', text: p.kind === 'error' ? '✕' : '!' }),
      el('span', {}, [el('span', { class: 'where', text: `${p.file || p.name || ''}${p.line ? ':' + p.line : ''}` }), document.createTextNode(p.message)])
    ])])),
    build.missing ? el('li', {}, [el('pre', { text: t('没有找到 latexmk。请安装 TeX Live 或 MiKTeX；已经装了的话，可以把它的 bin 文件夹填进环境变量 STARPORT_TEX_BIN，再重启星港。') })]) : null,
    build.tail ? el('li', {}, [el('pre', { text: build.tail })]) : null
  ].filter(Boolean));
}

// --- SyncTeX -----------------------------------------------------------------------------------
async function toPdf() {
  if (!state.path) return;
  if (state.view === 'source') setView('split');
  const { line, column } = source.cursor();
  try { const data = await api('synctex', { method: 'POST', body: { to: 'pdf', path: state.path, line, column } }); data.boxes?.length ? pdf.showBoxes(data.boxes) : toast(t('PDF 里没有找到这一行')); }
  catch (error) { toast(error.message); }
}
async function toSource(point) {
  try {
    const data = await api('synctex', { method: 'POST', body: { to: 'source', ...point } });
    if (!data.source) { toast(t('这个位置不在工作目录的源码里')); return; }
    if (state.view === 'pdf') setView('split');
    if (data.source.path === state.path) source.reveal(data.source.line); else openFile(data.source.path, { line: data.source.line });
  } catch (error) { toast(error.message); }
}

// --- the visual mode -----------------------------------------------------------------------------
// A picture is compiled alone with the document's preamble. One that depends on something in the
// body cannot be, so it is cut out of the built PDF instead, if that PDF is of this very text.
async function cropPicture(code, line) {
  const inFile = state.file && !state.dirty && state.build?.at && state.file.mtime <= state.build.at;
  if (!inFile || !pdf?.loaded || code.split('\n').length < 3) return null;
  const data = await api('synctex', { method: 'POST', body: { to: 'pdf', path: state.path, line: line + 1 } }).catch(() => null);
  const box = data?.boxes?.reduce((best, item) => (!best || item.width * item.height > best.width * best.height ? item : best), null);
  return box ? pdf.crop(box) : null;
}
function setupVisual() {
  visual = createVisual({
    t,
    figure: async (code, line) => {
      try { return await pdfToImage((await bytes('figure', { method: 'POST', body: { code } })).data); }
      catch (error) {
        if (error.needsLua) throw error;
        const cut = await cropPicture(code, line).catch(() => null);
        if (cut) return cut;
        throw error;
      }
    },
    graphic: async name => {
      const file = await bytes('graphic', { query: { name } });
      if (file.type.includes('pdf')) return pdfToImage(file.data);
      const url = URL.createObjectURL(new Blob([file.data], { type: file.type }));
      const image = await new Promise((done, fail) => { const img = new Image(); img.onload = () => done(img); img.onerror = fail; img.src = url; });
      return { src: url, width: image.naturalWidth * 0.75, height: image.naturalHeight * 0.75 };
    }
  });
  $('#visual-mode').checked = state.visual;
  $('#visual-mode').addEventListener('change', event => {
    state.visual = event.target.checked;
    store.set('starport-latex-visual', state.visual ? '1' : '0');
    source?.setVisual(state.visual ? visual.extension : []);
    if (state.visual) refreshContext();
  });
}
let contextTimer = null;
async function refreshContext() {
  if (!state.visual || !state.project?.root) return;
  try { if (visual.setContext(await api('context'))) source?.redrawVisual(); } catch {}
}
const refreshContextSoon = () => { clearTimeout(contextTimer); contextTimer = setTimeout(refreshContext, 400); };

// --- what Starport hears ------------------------------------------------------------------------
function presence() {
  if (!state.path) return;
  api('presence', { method: 'POST', body: { path: state.path, line: lastLine, outline: source.outline() } }).catch(() => {});
}
function cursorMoved(line) {
  if (line === lastLine) return;
  lastLine = line;
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(presence, 1500);
}
// What is selected shows in the input box as a live quote and leaves it with the selection.
// Keeping it (Ctrl L, or the pin on its card) leaves it there while other passages are selected.
const MAX_QUOTE = 20000;
let quotedKey = '';
const quoteKey = selection => (selection ? [state.path, selection.fromLine, selection.toLine, selection.text].join('\0') : '');
function publishSelection(selection) {
  clearTimeout(selectionTimer);
  const usable = selection?.text.trim() && selection.text.length <= MAX_QUOTE ? selection : null, key = quoteKey(usable);
  if (key === quotedKey) return;
  quotedKey = key;
  post(usable ? { type: 'selection', path: state.path, ...usable } : { type: 'selection-clear' });
}
function selected(selection) {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => publishSelection(selection), 180);
}
function keepSelection() {
  const selection = source?.selection();
  if (!selection?.text.trim()) return false;
  clearTimeout(selectionTimer);
  if (selection.text.length > MAX_QUOTE) { toast(t('选中的内容太长，最多 {count} 个字符', { count: MAX_QUOTE })); return true; }
  quotedKey = quoteKey(selection);
  post({ type: 'keep', path: state.path, ...selection });
  return true;
}

// A box dragged over the PDF goes to the input box as a picture. The page uploads it and tells
// Starport's page which attachment to add; every open Starport tab adds the same one only once.
const MAX_SNIP = 7.5 * 1024 * 1024;
async function upload(body, retried = false) {
  const response = await fetch('/api/attachments', { method: 'POST', headers: { 'X-Hub-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if ((response.status === 401 || response.status === 403) && !retried && (await refreshToken().catch(() => false))) return upload(body, true);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(t(data.error || '请求失败 ({status})', { status: response.status }));
  return data;
}
async function attachSnip({ page, canvas }) {
  let type = 'png', data = canvas.toDataURL('image/png').split(',')[1];
  // A region full of photographs can be too heavy as PNG; JPEG keeps it under the attachment limit.
  if (data.length * 0.75 > MAX_SNIP) { type = 'jpg'; data = canvas.toDataURL('image/jpeg', 0.92).split(',')[1]; }
  if (data.length * 0.75 > MAX_SNIP) throw new Error(t('截取的区域太大，请缩小一些再试'));
  const base = (state.project?.root || 'pdf').split('/').pop().replace(/\.tex$/i, '') || 'pdf';
  const attachment = await upload({ name: `${base}-p${page}.${type}`, data });
  post({ type: 'attachment', attachment });
  toast(t('已把第 {page} 页的截图附到输入框', { page }));
}

// --- layout ------------------------------------------------------------------------------------
function setView(view) {
  state.view = ['source', 'split', 'pdf'].includes(view) ? view : 'split';
  store.set('starport-latex-view', state.view);
  $('#work').dataset.view = state.view;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  if (state.view === 'pdf') showTree(false, { remember: false });
  requestAnimationFrame(fitTree);
}
function setupSplitter() {
  const work = $('#work'), handle = $('#splitter');
  const apply = ratio => { const r = Math.min(0.8, Math.max(0.2, ratio)); work.style.setProperty('--split', (r / (1 - r)).toFixed(3) + 'fr'); return r; };
  const saved = Number(store.get('starport-latex-split'));
  if (saved) apply(saved);
  handle.addEventListener('dblclick', () => { work.style.removeProperty('--split'); store.set('starport-latex-split', ''); });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || getComputedStyle(work).gridTemplateRows.split(' ').length > 1) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); document.body.classList.add('dragging');
    const box = work.getBoundingClientRect();
    const move = e => store.set('starport-latex-split', String(apply((e.clientX - box.left) / box.width)));
    const up = () => { handle.classList.remove('dragging'); document.body.classList.remove('dragging'); handle.removeEventListener('pointermove', move); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up, { once: true }); handle.addEventListener('pointercancel', up, { once: true });
  });
}
function showPlace() {
  for (const button of document.querySelectorAll('[data-place]')) button.setAttribute('aria-pressed', String(button.dataset.place === place));
}
function showOwner(title) {
  if (embedded || !title) return;
  const label = $('#editor-owner-title');
  if (label.textContent === title) return;
  label.textContent = label.title = title;
  $('#editor-owner').hidden = false;
  document.title = title + ' · LaTeX · Starport';
}
function setupPlaces() {
  showPlace();
  for (const button of document.querySelectorAll('[data-place]')) {
    button.addEventListener('click', async () => {
      const target = button.dataset.place;
      if (target === place) return;
      await save();
      if (state.dirty) return;
      if (target === 'window') {
        const win = window.open('', 'starport-latex-' + chatId, 'popup=yes,width=1280,height=860');
        if (!win) { toast(t('浏览器拦截了新窗口')); return; }
        if (win.location.href === 'about:blank') win.location.href = '/latex/?chat=' + encodeURIComponent(chatId);
        win.focus();
        post({ type: 'dock', place: 'window' });
      } else if (embedded) post({ type: 'dock', place: target });
      else dockBack(target);
    });
  }
  $('#close-editor').addEventListener('click', async () => {
    await save();
    post({ type: 'close' });
    if (!embedded) window.close();
  });
}
// From the window back into Starport's page: close only once a Starport page has taken it.
function dockBack(target) {
  let taken = false;
  const listen = event => { if (event.data?.chatId === chatId && event.data.type === 'docked') { taken = true; window.close(); } };
  channel?.addEventListener('message', listen);
  post({ type: 'dock', place: target });
  setTimeout(() => { channel?.removeEventListener('message', listen); if (!taken) toast(t('星港主窗口没有打开这个对话，编辑器留在这个窗口。')); }, 1500);
}

// --- start ---------------------------------------------------------------------------------------
async function start() {
  const data = state.project;
  showOwner(data.chatTitle);
  if (!data.root) { renderSetup(data); return; }
  $('#setup').hidden = true; $('#work').hidden = false; document.body.classList.remove('choosing');
  $('#compile').disabled = !data.tex;
  $('#lua-revoke').hidden = !data.luaAllowed;
  if (!source) {
    source = createSource($('#source'), { onChange: scheduleSave, onSelection: selected, onCursor: cursorMoved, onSave: () => (state.dirty ? save().then(() => !state.auto && compile()) : compile()), onToPdf: toPdf });
  }
  if (state.visual) { await refreshContext(); source.setVisual(visual.extension); }
  if (!tree) tree = createTree($('#tree'), { chatId, t, onOpen: path => openFile(path) });
  if (!pdf) {
    try { pdf = await createPdf({ container: $('#pdf-container'), viewerEl: $('#pdf-viewer'), zoomLabel: $('#zoom-fit'), token: () => token, onPoint: toSource }); }
    catch (error) { $('#pdf-empty').textContent = t('PDF 预览没能加载：{error}', { error: error.message }); }
    if (pdf) createSnip({ container: $('#pdf-container'), viewerEl: $('#pdf-viewer'), button: $('#pdf-snip'), pdf: () => pdf, onSnip: attachSnip, onError: error => toast(error.message) });
  }
  const remembered = store.get('starport-latex-file:' + chatId);
  state.path = null; state.file = null;
  await openFile(data.files?.includes(remembered) ? remembered : data.root);
  fitTree();
  state.pdfId = 0; state.shownBuild = 0;
  onBuild(data.build);
  if (data.tex && !data.build?.at) compile();
}
async function poll() {
  try {
    if (state.project?.root) {
      const data = await api('watch', { query: { path: state.path || '', auto: state.auto ? '1' : '0' } });
      showOwner(data.chatTitle);
      if (data.file && state.file && data.file.path === state.path && data.file.mtime !== state.file.mtime && !state.saving) await changedOnDisk();
      onBuild(data.build);
    }
  } catch {}
  setTimeout(poll, document.hidden ? 4000 : 1500);
}

async function boot() {
  translatePage();
  setView(state.view);
  setupSplitter();
  setupTreeResize();
  setupPlaces();
  setupVisual();
  if (!chatId) { $('#setup').hidden = false; $('#setup').replaceChildren(el('p', { text: t('请从星港的对话里打开 LaTeX 编辑器。') })); return; }
  $('#auto-compile').checked = state.auto;
  $('#auto-compile').addEventListener('change', event => { state.auto = event.target.checked; store.set('starport-latex-auto', state.auto ? '1' : '0'); });
  $('#compile').addEventListener('click', () => (state.dirty ? save().then(() => !state.auto && compile()) : compile()));
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
  const pdfTheme = $('#pdf-theme');
  const applyPdfTheme = value => {
    pdfTheme.value = value === 'dark' ? 'dark' : 'light';
    $('.pdf-pane').dataset.pdfTheme = pdfTheme.value;
  };
  applyPdfTheme(store.get(pdfThemeKey));
  pdfTheme.addEventListener('change', () => {
    applyPdfTheme(pdfTheme.value);
    store.set(pdfThemeKey, pdfTheme.value);
  });
  $('#zoom-in').addEventListener('click', () => pdf?.zoomIn());
  $('#zoom-out').addEventListener('click', () => pdf?.zoomOut());
  $('#zoom-fit').addEventListener('click', () => pdf?.fit());
  $('#to-pdf').addEventListener('click', toPdf);
  $('#pdf-download').href = '/api/latex/pdf?chatId=' + encodeURIComponent(chatId);
  $('#problems-toggle').addEventListener('click', () => {
    const open = $('#problems-toggle').getAttribute('aria-expanded') !== 'true';
    $('#problems-toggle').setAttribute('aria-expanded', String(open)); $('#problem-list').hidden = !open;
  });
  $('#tree-toggle').addEventListener('click', () => showTree($('#tree-pane').hidden));
  $('#tree-collapse').addEventListener('click', () => { showTree(false); $('#tree-toggle').focus(); });
  $('#tree-refresh').addEventListener('click', () => refreshFiles());
  $('#change-root').addEventListener('click', chooseRoot);
  $('#lua-revoke').addEventListener('click', () => allowLua(false));
  $('#tree-pane').addEventListener('keydown', event => { if (event.key === 'Escape' && $('#tree-pane').classList.contains('overlay')) { showTree(false); source?.focus(); } });
  new ResizeObserver(fitTree).observe($('.source-pane'));
  channel?.addEventListener('message', event => {
    const message = event.data;
    if (message?.chatId !== chatId) return;
    if (message.type === 'reveal' && message.path) message.path === state.path ? source?.reveal(message.line || 1, { keepSelection: true, focus: false }) : openFile(message.path, { line: message.line || 1 });
    if (message.type === 'where') post({ type: 'here', place });
    if (message.type === 'placed' && embedded && ['left', 'right'].includes(message.place)) { place = message.place; showPlace(); }
  });
  addEventListener('storage', event => {
    if (event.key === 'starport-theme' && event.newValue) globalThis.StarportTheme?.set(event.newValue);
    if (event.key === pdfThemeKey || event.key === null) applyPdfTheme(store.get(pdfThemeKey));
  });
  addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'l') return;
    if (keepSelection()) event.preventDefault();
  });
  addEventListener('pagehide', () => {
    publishSelection(null);
    if (state.dirty) save({ keepalive: true });
    api('presence', { method: 'POST', body: { open: false }, keepalive: true }).catch(() => {});
    if (!embedded) post({ type: 'closed', place });
  });
  setInterval(() => { if (!document.hidden) presence(); }, 60000);
  if (!embedded) post({ type: 'opened', place });
  try { state.project = await api('project'); await start(); }
  catch (error) { $('#setup').hidden = false; $('#setup').replaceChildren(el('p', { text: error.message })); }
  poll();
}
boot();

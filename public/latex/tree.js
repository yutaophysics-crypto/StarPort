// The file tree beside the source: the conversation's whole working folder, folders before
// files, each folder opened and closed on its own. Only files the editor can open are listed, so a
// folder holding none of them is left out. Which folders are open is remembered per conversation.

// Paths are relative to the working folder; base is the main file's folder in the same terms.
export function buildTree(paths, base = '') {
  const prefix = base ? base + '/' : '';
  const root = { name: base.split('/').pop() || '', path: base, dirs: new Map(), files: [] };
  for (const path of paths) {
    const rest = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : prefix ? null : path;
    // A file outside the main file's folder (rare) sits at the top under its full path.
    if (rest === null) { root.files.push({ name: path, path }); continue; }
    const parts = rest.split('/'), name = parts.pop();
    let node = root, at = base;
    for (const part of parts) {
      at = at ? at + '/' + part : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: at, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ name, path });
  }
  return root;
}
export const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
export const ancestors = path => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

export function createTree(container, { chatId, t, onOpen }) {
  const KEY = 'starport-latex-open:' + chatId;
  let open;
  try { open = new Set(JSON.parse(localStorage.getItem(KEY)) || []); } catch { open = new Set(); }
  const remember = () => { try { localStorage.setItem(KEY, JSON.stringify([...open].slice(-300))); } catch {} };
  let last = null;

  function row(attrs, children) {
    const button = document.createElement('button');
    button.type = 'button';
    for (const [key, value] of Object.entries(attrs)) if (value != null) button.setAttribute(key, value);
    button.append(...children);
    return button;
  }
  function text(tag, className, value) { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; }

  function branch(node, depth, view) {
    const list = document.createElement('ul');
    list.setAttribute('role', depth ? 'group' : 'tree');
    for (const dir of [...node.dirs.values()].sort(byName)) {
      const expanded = open.has(dir.path), item = document.createElement('li');
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-expanded', String(expanded));
      // A closed folder still shows that a file inside it failed to build.
      const button = row({ class: 'tree-row folder', style: `--depth:${depth}`, 'data-dir': dir.path, title: dir.path }, [
        text('span', 'chevron' + (expanded ? ' open' : ''), ''), text('span', 'tree-name', dir.name),
        !expanded && view.errorDirs.has(dir.path) ? Object.assign(text('span', 'tree-error', ''), { title: t('这个文件夹里有编译错误') }) : ''
      ]);
      button.addEventListener('click', () => toggle(dir.path));
      item.append(button);
      if (expanded) item.append(branch(dir, depth + 1, view));
      list.append(item);
    }
    for (const file of node.files.sort(byName)) {
      const item = document.createElement('li'), current = file.path === view.current;
      item.setAttribute('role', 'treeitem');
      const kind = (file.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
      const button = row({ class: 'tree-row file' + (current ? ' current' : '') + (kind === 'tex' ? '' : ' aux'), style: `--depth:${depth}`, 'data-file': file.path, title: file.path, ...(current ? { 'aria-current': 'true' } : {}) }, [
        text('span', 'chevron', ''), text('span', 'tree-name', file.name),
        file.path === view.root ? text('span', 'tree-badge', t('主文件')) : '',
        view.errors.has(file.path) ? Object.assign(text('span', 'tree-error', ''), { title: t('这个文件里有编译错误') }) : ''
      ]);
      button.addEventListener('click', () => onOpen(file.path));
      item.append(button);
      list.append(item);
    }
    return list;
  }

  function render(view = last) {
    if (!view) return;
    last = view;
    const focused = document.activeElement?.closest?.('.tree-row');
    const key = focused?.dataset.dir ? 'dir:' + focused.dataset.dir : focused?.dataset.file ? 'file:' + focused.dataset.file : null;
    const tree = buildTree(view.files, view.base);
    view.errorDirs = new Set([...view.errors].flatMap(ancestors));
    container.replaceChildren(branch(tree, 0, view));
    if (key) {
      const [type, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      [...container.querySelectorAll('.tree-row')].find(b => (type === 'dir' ? b.dataset.dir : b.dataset.file) === value)?.focus();
    }
  }
  function toggle(path, value = !open.has(path)) {
    if (value) open.add(path); else open.delete(path);
    remember(); render();
  }
  // The folders down to a file open, so the file being edited is always in sight.
  function reveal(path) {
    let changed = false;
    for (const dir of ancestors(path)) if (!open.has(dir)) { open.add(dir); changed = true; }
    if (changed) remember();
    render();
    container.querySelector('.tree-row.current')?.scrollIntoView({ block: 'nearest' });
  }
  // Up and down move between the rows on show; right opens a folder, left closes it.
  container.addEventListener('keydown', event => {
    const rows = [...container.querySelectorAll('.tree-row')], index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    const current = rows[index], dir = current.dataset.dir;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
    else if (event.key === 'ArrowRight' && dir && !open.has(dir)) { event.preventDefault(); toggle(dir, true); }
    else if (event.key === 'ArrowLeft' && dir && open.has(dir)) { event.preventDefault(); toggle(dir, false); }
  });
  return { render, reveal };
}

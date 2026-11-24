import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = file => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
const layout = read('app-layout.js');
const source = layout.slice(layout.indexOf('function setupSidebarToggle'), layout.indexOf('function setupPanelResizers'));

function page(width, saved = new Map()) {
  const classes = new Set(), listeners = [], attrs = {};
  let focused = 'inside';
  const button = { dataset: {}, title: '', setAttribute: (k, v) => (attrs[k] = v), focus: () => (focused = 'button') };
  const sidebar = {
    classList: { contains: c => classes.has(c), toggle: c => (classes.has(c) ? classes.delete(c) : classes.add(c)) },
    contains: node => node === 'inside'
  };
  const document = {
    documentElement: { dataset: {} },
    addEventListener: (type, fn) => listeners.push(fn),
    querySelector: () => null,
    get activeElement() { return focused; }
  };
  runInNewContext(source + ';setupSidebarToggle();', {
    document,
    $: selector => (selector === '#sidebar-toggle' ? button : sidebar),
    t: text => 'T:' + text,
    matchMedia: () => ({ matches: width <= 650, addEventListener() {} }),
    MutationObserver: class { observe() {} },
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: k => saved.delete(k) }
  });
  const key = init => {
    const event = { key: 'b', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...init, preventDefault() { this.defaultPrevented = true; } };
    listeners.forEach(fn => fn(event));
    return event;
  };
  return { button, attrs, classes, root: document.documentElement, saved, key, focused: () => focused };
}

test('on a wide window the sidebar folds away, remembers it, and hands focus to the toggle', () => {
  const p = page(1400);
  assert.equal(p.attrs['aria-expanded'], 'true');
  assert.equal(p.attrs['aria-label'], 'T:收起侧边栏');
  assert.equal(p.button.dataset.i18nTitle, '收起侧边栏 · Ctrl B', 'a language switch keeps the current label');
  p.button.onclick();
  assert.equal(p.root.dataset.sidebar, 'collapsed');
  assert.equal(p.saved.get('starport-sidebar-collapsed'), '1');
  assert.equal(p.attrs['aria-expanded'], 'false');
  assert.equal(p.attrs['aria-label'], 'T:展开侧边栏');
  assert.equal(p.focused(), 'button', 'focus never stays inside a hidden sidebar');
  assert.ok(p.key({}).defaultPrevented, 'Ctrl B toggles it back');
  assert.equal(p.root.dataset.sidebar, undefined);
  assert.equal(p.saved.has('starport-sidebar-collapsed'), false);
  assert.equal(p.key({ shiftKey: true }).defaultPrevented, false, 'Ctrl Shift B is left alone');
  assert.equal(p.root.dataset.sidebar, undefined);
});

test('on a narrow window the same toggle opens the drawer and saves nothing', () => {
  const p = page(500);
  assert.equal(p.attrs['aria-expanded'], 'false');
  p.button.onclick();
  assert.ok(p.classes.has('open'));
  assert.equal(p.attrs['aria-expanded'], 'true');
  assert.equal(p.root.dataset.sidebar, undefined);
  assert.equal(p.saved.size, 0);
});

test('a collapsed sidebar is applied before the first paint and only on wide windows', () => {
  const root = { dataset: {} };
  runInNewContext(read('theme.js'), {
    document: { documentElement: root, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: key => (key === 'starport-sidebar-collapsed' ? '1' : null), setItem() {} }
  });
  assert.equal(root.dataset.sidebar, 'collapsed');
  const css = read('style.css');
  assert.match(css, /@media \(min-width: 651px\) \{\s*:root\[data-sidebar='collapsed'\] \.app-shell \{\s*--sidebar-width: 0px !important;/);
  const html = read('index.html');
  assert.match(html, /id="sidebar-toggle"[^>]*aria-controls="sidebar"/);
  assert.doesNotMatch(html, /id="sidebar-toggle"[^>]*mobile-only/, 'the toggle shows on every width');
});

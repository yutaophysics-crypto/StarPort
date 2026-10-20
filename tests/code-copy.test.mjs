import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Just enough DOM for decorate(): elements with children, classes and replaceWith.
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = {}; this.className = ''; this.textContent = ''; this.style = {}; }
  get classList() { return { contains: name => this.className.split(/\s+/).includes(name) }; }
  set innerHTML(value) { this.children = []; this.html = value; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...nodes) { for (const node of nodes) { node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1); node.parentElement = this; this.children.push(node); } }
  replaceWith(node) { const siblings = this.parentElement.children; siblings[siblings.indexOf(this)] = node; node.parentElement = this.parentElement; this.parentElement = null; }
  querySelectorAll(selector) { const tag = selector.toUpperCase(), found = []; const walk = node => { for (const child of node.children) { if (child.tagName === tag) found.push(child); walk(child); } }; walk(this); return found; }
}
const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../public/code-copy.js', import.meta.url), 'utf8'), context);
const { decorate, source } = context.StarportCodeCopy;

test('every code box gets one copy button, even when decorated twice', () => {
  const root = new Element('div'), reply = new Element('pre'), tool = new Element('pre');
  root.append(reply, tool);
  decorate(root);
  decorate(root);
  assert.equal(root.children.length, 2);
  for (const box of root.children) {
    assert.equal(box.className, 'code-box');
    assert.deepEqual(box.children.map(node => node.tagName), ['PRE', 'BUTTON']);
    assert.equal(box.children[1].attributes['aria-label'], '复制代码');
  }
});

test('copied text is the code itself, without the newline Markdown adds at the end', () => {
  const pre = new Element('pre');
  pre.textContent = '\\begin{equation}\n  E = mc^2\n\\end{equation}\n';
  assert.equal(source(pre), '\\begin{equation}\n  E = mc^2\n\\end{equation}');
  pre.textContent = 'line\n\n';
  assert.equal(source(pre), 'line\n');
});

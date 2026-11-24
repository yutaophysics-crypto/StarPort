// The visual mode: the source stays exactly as it is, and what the parser finds in it is drawn over it.
// Formulas, pictures and graphics appear finished, headings and styles take their look with their
// commands hidden, and references show their numbers. Wherever the caret goes, the source comes back.
import { Decoration, EditorView, StateEffect, StateField, WidgetType } from '/vendor/codemirror.mjs';
import { parseVisual } from './visual-parse.js';
import { assignNumbers, documentMacros, renderMath } from './visual-math.js';

const setHeld = StateEffect.define();
export const refreshVisual = StateEffect.define();
const hide = Decoration.replace({});
const STYLE_MARKS = Object.fromEntries(['bold', 'italic', 'underline', 'mono', 'smallcaps'].map(style => [style, Decoration.mark({ class: 'vis-' + style })]));
const PT_TO_PX = 96 / 72;

const touches = (ranges, from, to) => ranges.some(range => range.from <= to && range.to >= from);
function wholeLines(doc, from, to) {
  const first = doc.lineAt(from), last = doc.lineAt(to);
  if (doc.sliceString(first.from, from).trim() || doc.sliceString(to, last.to).trim()) return null;
  return { from: first.from, to: last.to };
}
function showImage(box, image, { max = '100%' } = {}) {
  let img = box.querySelector('img');
  if (!img) { img = document.createElement('img'); img.draggable = false; img.alt = ''; box.replaceChildren(img); }
  img.src = image.src;
  img.style.width = Math.round(image.width * PT_TO_PX) + 'px';
  img.style.maxWidth = max;
  box.classList.remove('loading', 'failed', 'stale');
}
const note = (box, text, kind) => { box.classList.remove('loading', 'failed', 'stale'); box.classList.add(kind); box.textContent = text; };

class MathWidget extends WidgetType {
  constructor(host, item, block) { super(); this.host = host; this.item = item; this.block = block; this.key = `${host.version}|${item.display}|${item.env}|${item.tex}|${block}|${item.numbers || ""}`; }
  eq(other) { return other.key === this.key; }
  get estimatedHeight() { return this.block ? 56 : -1; }
  toDOM() {
    const node = document.createElement(this.block ? 'div' : 'span'), html = this.host.math(this.item);
    node.className = 'vis-math' + (this.block ? ' block' : '') + (this.item.display && !this.block ? ' display' : '');
    if (html) node.innerHTML = html;
    else { node.classList.add('raw'); node.textContent = this.item.tex.trim(); node.title = this.host.t('这个公式画不出来，点开可以看源码'); }
    return node;
  }
  ignoreEvent() { return false; }
}

class PictureWidget extends WidgetType {
  constructor(host, code, line, block, preview) { super(); this.host = host; this.code = code; this.line = line; this.block = block; this.preview = preview; this.version = host.figureVersion; }
  eq(other) { return other.code === this.code && other.block === this.block && other.preview === this.preview && other.version === this.version; }
  get estimatedHeight() { const hit = this.host.images.get(this.code); return hit ? Math.round(hit.height * PT_TO_PX) + 18 : 170; }
  draw(box, view) {
    const hit = this.host.images.get(this.code), code = this.code;
    box.dataset.code = code;
    if (hit) { showImage(box, hit); return; }
    if (box.querySelector('img')) box.classList.add('stale'); else note(box, this.host.t('正在渲染图…'), 'loading');
    this.host.figure(code, this.line).then(image => {
      if (box.dataset.code !== code) return;
      showImage(box, image);
      view.requestMeasure();
    }).catch(error => {
      if (box.dataset.code !== code) return;
      if (this.preview && box.querySelector('img')) { box.classList.add('stale'); box.title = error.message; return; }
      note(box, error.needsLua ? this.host.t('允许使用 LuaLaTeX 后才能显示这张图') : this.host.t('这张图没能渲染：{error}', { error: error.message }), 'failed');
      view.requestMeasure();
    });
  }
  toDOM(view) {
    const box = document.createElement(this.block || this.preview ? 'div' : 'span');
    box.className = 'vis-picture' + (this.preview ? ' preview' : '');
    this.draw(box, view);
    return box;
  }
  // While the picture is edited its preview stays on show and redraws once typing pauses.
  updateDOM(box, view) {
    if (!this.preview || !box.classList.contains('preview')) return false;
    clearTimeout(box.redraw);
    box.dataset.code = this.code;
    if (this.host.images.has(this.code)) { showImage(box, this.host.images.get(this.code)); return true; }
    if (box.querySelector('img')) box.classList.add('stale');
    box.redraw = setTimeout(() => { if (box.dataset.code === this.code) this.draw(box, view); }, 900);
    return true;
  }
  ignoreEvent() { return false; }
}

class GraphicWidget extends WidgetType {
  constructor(host, file, block) { super(); this.host = host; this.file = file; this.block = block; this.stamp = host.buildStamp; }
  eq(other) { return other.file === this.file && other.block === this.block && other.stamp === this.stamp; }
  get estimatedHeight() { const hit = this.host.lastGraphic.get(this.file); return this.block ? (hit ? Math.round(hit.height * PT_TO_PX) + 18 : 170) : -1; }
  toDOM(view) {
    const box = document.createElement(this.block ? 'div' : 'span'), last = this.host.lastGraphic.get(this.file);
    box.className = 'vis-picture graphic';
    box.title = this.file;
    if (last) showImage(box, last); else note(box, this.host.t('正在读取图片…'), 'loading');
    this.host.graphic(this.file).then(image => { showImage(box, image); view.requestMeasure(); })
      .catch(() => { if (!last) { note(box, this.file, 'failed'); view.requestMeasure(); } });
    return box;
  }
  ignoreEvent() { return false; }
}

class ChipWidget extends WidgetType {
  constructor(text, title, kind) { super(); this.text = text; this.title = title; this.kind = kind; }
  eq(other) { return other.text === this.text && other.title === this.title && other.kind === this.kind; }
  toDOM() {
    const node = document.createElement('span');
    node.className = 'vis-chip ' + this.kind;
    node.textContent = this.text;
    node.title = this.title;
    return node;
  }
  ignoreEvent() { return false; }
}

function refText(host, item) {
  const values = item.keys.map(key => host.labels[key] ?? null), known = values.every(value => value !== null);
  const text = values.map((value, i) => value ?? item.keys[i] + '?').join(', ');
  return { text: item.command === 'eqref' ? `(${text})` : text, known };
}
function citeText(host, item) {
  const values = item.keys.map(key => host.cites[key] ?? null), known = values.every(value => value !== null);
  return { text: '[' + values.map((value, i) => value ?? item.keys[i]).join(', ') + ']', known };
}

function draw(state, items, shown, host) {
  const { doc } = state, out = [];
  const conceal = (from, to) => { if (from < to) out.push(hide.range(from, to)); };
  const replaceWith = (from, to, widget, block = false) => out.push(Decoration.replace({ widget, block }).range(from, to));
  for (const item of items) {
    const near = touches(shown, item.from, item.to);
    if (item.kind === 'math') {
      const lines = item.display ? wholeLines(doc, item.from, item.to) : null;
      if (!near) replaceWith(lines?.from ?? item.from, lines?.to ?? item.to, new MathWidget(host, item, !!lines), !!lines);
      else if (item.display) out.push(Decoration.widget({ widget: new MathWidget(host, item, true), block: true, side: 1 }).range(doc.lineAt(item.to).to));
    } else if (item.kind === 'picture') {
      const lines = wholeLines(doc, item.from, item.to), line = doc.lineAt(item.from).number;
      if (!near) replaceWith(lines?.from ?? item.from, lines?.to ?? item.to, new PictureWidget(host, item.code, line, !!lines, false), !!lines);
      else out.push(Decoration.widget({ widget: new PictureWidget(host, item.code, line, true, true), block: true, side: 1 }).range(doc.lineAt(item.to).to));
    } else if (item.kind === 'graphic') {
      const lines = wholeLines(doc, item.from, item.to);
      if (!near) replaceWith(lines?.from ?? item.from, lines?.to ?? item.to, new GraphicWidget(host, item.file, !!lines), !!lines);
    } else if (item.kind === 'heading') {
      const first = doc.lineAt(item.from), last = doc.lineAt(item.to);
      for (let n = first.number; n <= last.number; n++) out.push(Decoration.line({ class: `vis-heading vis-h${item.level}` }).range(doc.line(n).from));
      if (!touches(shown, first.from, last.to)) { conceal(item.from, item.innerFrom); conceal(item.innerTo, item.to); }
    } else if (item.kind === 'style') {
      if (item.innerFrom < item.innerTo) out.push(STYLE_MARKS[item.style].range(item.innerFrom, item.innerTo));
      if (!near) { conceal(item.from, item.innerFrom); conceal(item.innerTo, item.to); }
    } else if (!near) {
      if (item.kind === 'label') replaceWith(item.from, item.to, new ChipWidget(item.key, '\\label{' + item.key + '}', 'label'));
      else {
        const { text, known } = item.kind === 'ref' ? refText(host, item) : citeText(host, item);
        replaceWith(item.from, item.to, new ChipWidget(text, item.keys.join(', '), item.kind + (known ? '' : ' unknown')));
      }
    }
  }
  return Decoration.set(out, true);
}

// Which items the selection is in: while that stays the same the drawing does not change.
const nearKey = (items, ranges) => {
  let key = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i], from = item.kind === 'heading' ? item.lineFrom ?? item.from : item.from, to = item.kind === 'heading' ? item.lineTo ?? item.to : item.to;
    if (touches(ranges, from, to)) key += i + ',';
  }
  return key;
};
const rangesOf = selection => selection.ranges.map(({ from, to }) => ({ from, to }));

export function createVisual({ t, figure, graphic }) {
  const host = {
    t, version: 0, figureVersion: 0, buildStamp: 0, preamble: null, labelsKey: '', macros: {}, labels: {}, cites: {}, equations: {}, path: null,
    formulas: new Map(), images: new Map(), pending: new Map(), lastGraphic: new Map(), graphics: new Map(),
    math(item) {
      const key = `${item.display}|${item.env}|${item.tex}|${item.numbers || ''}`;
      if (!host.formulas.has(key)) {
        if (host.formulas.size > 4000) host.formulas.clear();
        host.formulas.set(key, globalThis.katex ? renderMath(globalThis.katex, item, { macros: host.macros, labels: host.labels }) : null);
      }
      return host.formulas.get(key);
    },
    figure(code, line) {
      if (host.images.has(code)) return Promise.resolve(host.images.get(code));
      if (!host.pending.has(code)) {
        const version = host.figureVersion;
        host.pending.set(code, figure(code, line).then(image => {
          if (version === host.figureVersion) { if (host.images.size > 200) host.images.delete(host.images.keys().next().value); host.images.set(code, image); }
          return image;
        }).finally(() => host.pending.delete(code)));
      }
      return host.pending.get(code);
    },
    graphic(file) {
      const key = host.buildStamp + '|' + file;
      if (!host.graphics.has(key)) {
        if (host.graphics.size > 300) host.graphics.clear();
        const work = graphic(file).then(image => { host.lastGraphic.set(file, image); return image; });
        work.catch(() => host.graphics.delete(key));
        host.graphics.set(key, work);
      }
      return host.graphics.get(key);
    }
  };
  const number = (items, doc) => assignNumbers(items, host.equations[host.path] || [], position => doc.lineAt(position).number);
  const parse = doc => {
    const items = parseVisual(doc.toString());
    for (const item of items) if (item.kind === 'heading') { item.lineFrom = doc.lineAt(item.from).from; item.lineTo = doc.lineAt(item.to).to; }
    number(items, doc);
    return items;
  };
  const field = StateField.define({
    create(state) {
      const items = parse(state.doc), shown = rangesOf(state.selection);
      return { items, shown, held: false, key: nearKey(items, shown), decorations: draw(state, items, shown, host) };
    },
    update(value, tr) {
      let { held } = value, refreshed = false;
      for (const effect of tr.effects) { if (effect.is(setHeld)) held = effect.value; if (effect.is(refreshVisual)) refreshed = true; }
      if (!tr.docChanged && !tr.selection && !refreshed && held === value.held) return value;
      const items = tr.docChanged ? parse(tr.newDoc) : value.items;
      if (refreshed && !tr.docChanged) number(items, tr.newDoc);
      // While the mouse is down the drawing holds still, so a selection is not chased by moving text.
      const shown = held && !tr.docChanged ? value.shown : rangesOf(tr.newSelection), key = nearKey(items, shown);
      if (!tr.docChanged && !refreshed && key === value.key) return { ...value, shown, held };
      return { items, shown, held, key, decorations: draw({ doc: tr.newDoc }, items, shown, host) };
    },
    provide: self => EditorView.decorations.from(self, value => value.decorations)
  });
  const pointer = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false;
      view.dispatch({ effects: setHeld.of(true) });
      const release = () => {
        removeEventListener('mouseup', release, true);
        setTimeout(() => view.dispatch({ effects: setHeld.of(false) }), 0);
      };
      addEventListener('mouseup', release, true);
      return false;
    }
  });
  return {
    extension: [field, pointer],
    // True when formulas or pictures have to be drawn again.
    setContext({ preamble = '', labels = {}, cites = {}, equations = {} }) {
      const labelsKey = JSON.stringify([labels, cites, equations]), newPreamble = preamble !== host.preamble;
      if (!newPreamble && labelsKey === host.labelsKey) return false;
      if (newPreamble) { host.preamble = preamble; host.macros = documentMacros(preamble); host.images.clear(); host.figureVersion++; }
      host.labelsKey = labelsKey; host.labels = labels; host.cites = cites; host.equations = equations;
      host.formulas.clear(); host.version++;
      return true;
    },
    // Which file is open: the build's equation numbers are per file.
    setFile(path) { host.path = path; },
    clearFigures() { host.images.clear(); host.figureVersion++; },
    // A build may have regenerated the graphics a document includes.
    built() { host.buildStamp++; }
  };
}

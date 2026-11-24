// The source pane: CodeMirror 6 with LaTeX highlighting, wrapped lines, search, undo, error marks,
// and changes made elsewhere (a model, another editor) merged in place with the lines they touched lit.
import {
  EditorState, EditorView, Compartment, StateEffect, StateField, Transaction, Annotation, Prec, Decoration, keymap,
  lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, defaultKeymap, history, historyKeymap, indentWithTab,
  searchKeymap, highlightSelectionMatches, closeBrackets, closeBracketsKeymap, setDiagnostics, lintGutter, lintKeymap,
  StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, tags, stex
} from '/vendor/codemirror.mjs';
import { changedLines } from './diff.js';
import { refreshVisual } from './visual.js';

const external = Annotation.define();
// Colours come from the page's theme variables (editor.css), so the editor follows Starport's theme.
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--paper)', color: 'var(--ink)', fontSize: '13.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0 40vh' },
  '.cm-line': { padding: '0 14px 0 8px' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'color-mix(in srgb, var(--muted) 70%, transparent)', borderRight: '1px solid var(--line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--ink)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 55%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--select)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 55%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-textfield, .cm-button': { backgroundColor: 'var(--field)', backgroundImage: 'none', border: '1px solid var(--line)', borderRadius: '4px', color: 'var(--ink)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--error)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline dotted var(--warn)', textUnderlineOffset: '3px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--error)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' }
}, { dark: true });
const style = HighlightStyle.define([
  { tag: tags.tagName, color: 'var(--accent)' },
  { tag: tags.keyword, color: 'var(--warn)' },
  { tag: tags.atom, color: 'var(--ok)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.bracket, color: 'var(--faint)' },
  { tag: tags.number, color: 'var(--ok)' },
  { tag: [tags.string, tags.special(tags.variableName)], color: 'var(--warn)' },
  { tag: tags.invalid, color: 'var(--error)' }
]);

// Lines lit for a moment: changes from outside, or the line a jump landed on.
const mark = StateEffect.define();
const marks = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(mark)) {
      const { lines, kind } = effect.value, doc = tr.state.doc;
      value = kind ? Decoration.set(lines.filter(n => n >= 1 && n <= doc.lines).slice(0, 400).map(n => Decoration.line({ class: kind }).range(doc.line(n).from)), true) : Decoration.none;
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

const HEADING = /\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const LEVEL = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };

// What is selected, or null. A selection ending at the very start of a line does not count that line.
function selectionOf(state) {
  const { main } = state.selection, { doc } = state;
  if (main.empty) return null;
  const last = doc.lineAt(main.to);
  return { fromLine: doc.lineAt(main.from).number, toLine: last.from === main.to ? last.number - 1 : last.number, text: doc.sliceString(main.from, main.to) };
}

export function createSource(parent, { onChange, onSelection, onCursor, onSave, onToPdf }) {
  let version = 0, clearMarks = null, visualLayer = [];
  const visualSlot = new Compartment();
  const extensions = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(style), bracketMatching(),
    closeBrackets(), EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{'] } }]),
    rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    Prec.high(keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (onSave(), true) },
      { key: 'Ctrl-Alt-ArrowRight', preventDefault: true, run: () => (onToPdf(), true) }
    ])),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...lintKeymap, indentWithTab]),
    StreamLanguage.define(stex), EditorView.lineWrapping, lintGutter(), marks, theme,
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'LaTeX' }),
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        version++;
        if (!update.transactions.some(tr => tr.annotation(external))) onChange();
      }
      if (update.selectionSet || update.docChanged) {
        const { main } = update.state.selection;
        onCursor(update.state.doc.lineAt(main.head).number);
        onSelection(selectionOf(update.state));
      }
    })
  ];
  const stateFor = doc => EditorState.create({ doc, extensions: [...extensions, visualSlot.of(visualLayer)] });
  const view = new EditorView({ parent, state: stateFor('') });

  const light = (lines, kind, ms) => {
    clearTimeout(clearMarks);
    view.dispatch({ effects: mark.of({ lines, kind }) });
    clearMarks = setTimeout(() => view.dispatch({ effects: mark.of({ lines: [], kind: null }) }), ms);
  };
  const lineRange = line => view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));

  return {
    view,
    focus: () => view.focus(),
    text: () => view.state.doc.toString(),
    version: () => version,
    // A newly opened file starts its own undo history.
    load(text) { view.setState(stateFor(text)); version++; },
    setVisual(layer) { visualLayer = layer; view.dispatch({ effects: visualSlot.reconfigure(layer) }); },
    redrawVisual() { view.dispatch({ effects: refreshVisual.of(null) }); },
    // Text changed on disk: only the changed middle is replaced, so the caret, scroll and undo stay put.
    merge(text) {
      text = text.replace(/\r\n?/g, '\n');
      const old = view.state.doc.toString();
      if (old === text) return null;
      let start = 0, endOld = old.length, endNew = text.length;
      while (start < endOld && start < endNew && old.charCodeAt(start) === text.charCodeAt(start)) start++;
      while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) { endOld--; endNew--; }
      view.dispatch({
        changes: { from: start, to: endOld, insert: text.slice(start, endNew) },
        annotations: [external.of(true), Transaction.addToHistory.of(false)]
      });
      const lines = changedLines(old, text);
      light(lines, 'changed', 6000);
      return { from: lines[0], to: lines.at(-1) };
    },
    selection: () => selectionOf(view.state),
    reveal(line, { flash = true, focus = true, keepSelection = false } = {}) {
      const target = lineRange(line);
      view.dispatch({ ...(keepSelection ? {} : { selection: { anchor: target.from } }), effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
      if (flash) light([target.number], 'flash', 1600);
      if (focus) view.focus();
    },
    cursor() {
      const head = view.state.selection.main.head, line = view.state.doc.lineAt(head);
      return { line: line.number, column: head - line.from };
    },
    // The headings above the caret, innermost last: "\section{Intro} › \subsection{Setup}".
    outline() {
      const upto = view.state.doc.sliceString(0, view.state.doc.lineAt(view.state.selection.main.head).to);
      const open = [];
      for (const match of upto.matchAll(HEADING)) {
        const level = LEVEL[match[1]];
        while (open.length && open.at(-1).level >= level) open.pop();
        open.push({ level, text: `\\${match[1]}{${match[2].trim().slice(0, 60)}}` });
      }
      return open.map(item => item.text).join(' › ');
    },
    diagnose(problems) {
      const doc = view.state.doc;
      const list = problems.filter(p => p.line).map(p => {
        const line = doc.line(Math.min(Math.max(1, p.line), doc.lines));
        return { from: line.from, to: line.to, severity: p.kind === 'error' ? 'error' : 'warning', message: p.message };
      });
      view.dispatch(setDiagnostics(view.state, list));
    }
  };
}

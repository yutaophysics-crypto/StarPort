// The parts of CodeMirror 6 the LaTeX editor (public/latex) uses, bundled into one file:
// public/vendor/codemirror.mjs. Rebuild with scripts/vendor/build-latex-vendor.mjs.
export { EditorState, EditorSelection, Compartment, StateEffect, StateField, RangeSetBuilder, Transaction, Annotation, Prec } from '@codemirror/state';
export {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, Decoration, ViewPlugin, WidgetType
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { setDiagnostics, lintGutter, lintKeymap } from '@codemirror/lint';
export { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { stex } from '@codemirror/legacy-modes/mode/stex';

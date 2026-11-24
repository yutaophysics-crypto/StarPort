// Finds what the visual mode draws in a LaTeX source: formulas, pictures, headings, text styles,
// references, citations, labels and graphics. It only reads positions; the source is never changed.
// Comments and verbatim text are skipped, and anything left unclosed stays plain source.

export const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'math']);
const PICTURE_ENVS = new Set(['tikzpicture', 'tikzcd', 'circuitikz', 'pgfpicture']);
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*']);
const HEADINGS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
const STYLES = { textbf: 'bold', textit: 'italic', emph: 'italic', underline: 'underline', texttt: 'mono', textsc: 'smallcaps' };
const REFS = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'nameref']);
const CITES = new Set(['cite', 'citep', 'citet', 'citealp', 'citealt', 'autocite', 'parencite', 'textcite', 'footcite']);

const isLetter = code => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const lineEnd = (text, at) => { const end = text.indexOf('\n', at); return end < 0 ? text.length : end; };
const skipSpace = (text, at) => { while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\n' || text[at] === '\r')) at++; return at; };

// At "{": the index just past its matching "}", or -1.
export function closeGroup(text, at) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '%') i = lineEnd(text, i);
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}
// At "[": the index just past its "]", braces inside kept whole.
function closeOptional(text, at) {
  let depth = 0;
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth <= 0) return i + 1;
    else if (c === '\n' && text[i + 1] === '\n') return -1;
  }
  return -1;
}
const skipOptionals = (text, at) => {
  for (let next = skipSpace(text, at); text[next] === '['; next = skipSpace(text, at)) {
    const end = closeOptional(text, next);
    if (end < 0) return at;
    at = end;
  }
  return at;
};
// The first uncommented, unescaped occurrence of a closing token.
function findToken(text, token, at) {
  for (let i = at; i < text.length; i++) {
    if (text.startsWith(token, i)) return i;
    if (text[i] === '\\') i++;
    else if (text[i] === '%') i = lineEnd(text, i);
  }
  return -1;
}
// The \end{name} closing the \begin{name} before `at`, counting nested ones of the same name.
function findEnd(text, name, at) {
  const open = `\\begin{${name}}`, close = `\\end{${name}}`;
  let depth = 1;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '%') { i = lineEnd(text, i); continue; }
    if (text[i] !== '\\') continue;
    if (text.startsWith(close, i)) { if (--depth === 0) return i; i += close.length - 1; }
    else if (text.startsWith(open, i)) { depth++; i += open.length - 1; }
    else i++;
  }
  return -1;
}
// $ ... $ stays within a paragraph, so one stray dollar cannot swallow the text after it.
function closeInline(text, at) {
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '%') i = lineEnd(text, i);
    else if (c === '$') return i;
    else if (c === '\n' && /^[ \t]*\r?\n/.test(text.slice(i + 1, i + 200))) return -1;
  }
  return -1;
}

export function parseVisual(text) {
  const items = [], start = text.search(/\\begin\s*\{document\}/);
  let i = start < 0 ? 0 : start + text.slice(start).indexOf('}') + 1;
  const keys = (from, end) => text.slice(from + 1, end - 1).split(',').map(key => key.trim()).filter(Boolean);
  while (i < text.length) {
    const c = text[i];
    if (c === '%') { i = lineEnd(text, i) + 1; continue; }
    if (c === '$') {
      const display = text[i + 1] === '$', from = i, inner = i + (display ? 2 : 1);
      const end = display ? findToken(text, '$$', inner) : closeInline(text, inner);
      if (end < 0) { i = inner; continue; }
      const to = end + (display ? 2 : 1);
      if (text.slice(inner, end).trim()) items.push({ kind: 'math', from, to, tex: text.slice(inner, end), display, env: null });
      i = to;
      continue;
    }
    if (c !== '\\') { i++; continue; }
    const next = text[i + 1];
    if (next === '(' || next === '[') {
      const close = next === '(' ? '\\)' : '\\]', end = findToken(text, close, i + 2);
      if (end < 0) { i += 2; continue; }
      items.push({ kind: 'math', from: i, to: end + 2, tex: text.slice(i + 2, end), display: next === '[', env: null });
      i = end + 2;
      continue;
    }
    if (next === undefined || !isLetter(next.charCodeAt(0))) { i += 2; continue; }
    let e = i + 1;
    while (e < text.length && isLetter(text.charCodeAt(e))) e++;
    const name = text.slice(i + 1, e), from = i;
    const star = text[e] === '*' ? 1 : 0;
    if (name === 'verb' || name === 'lstinline') {
      const open = e + star, close = text[open] && text.indexOf(text[open], open + 1);
      i = close > 0 && close < lineEnd(text, open) ? close + 1 : open;
      continue;
    }
    if (name === 'begin') {
      const brace = skipSpace(text, e);
      if (text[brace] !== '{') { i = e; continue; }
      const close = text.indexOf('}', brace), env = text.slice(brace + 1, close);
      if (close < 0) break;
      const body = close + 1;
      if (VERBATIM_ENVS.has(env)) { const end = findEnd(text, env, body); i = end < 0 ? text.length : end + env.length + 6; continue; }
      if (MATH_ENVS.has(env) || PICTURE_ENVS.has(env)) {
        const end = findEnd(text, env, body);
        if (end < 0) { i = body; continue; }
        const to = end + env.length + 6;
        if (MATH_ENVS.has(env)) items.push({ kind: 'math', from, to, tex: text.slice(body, end), display: env !== 'math', env });
        else items.push({ kind: 'picture', from, to, code: text.slice(from, to) });
        i = to;
        continue;
      }
      i = body;
      continue;
    }
    if (name === 'feynmandiagram' || name === 'tikz') {
      const at = skipSpace(text, skipOptionals(text, e)), group = text[at] === '{' ? closeGroup(text, at) : -1;
      let to = -1;
      if (group > 0) { const after = skipSpace(text, group); to = name === 'feynmandiagram' && text[after] === ';' ? after + 1 : group; }
      else if (name === 'tikz') { const semi = findToken(text, ';', at); to = semi >= 0 && semi - at < 2000 ? semi + 1 : -1; }
      if (to > 0) { items.push({ kind: 'picture', from, to, code: text.slice(from, to) }); i = to; continue; }
      i = e;
      continue;
    }
    if (name in HEADINGS || name in STYLES) {
      const after = name in HEADINGS ? skipSpace(text, skipOptionals(text, e + star)) : e;
      const end = text[after] === '{' ? closeGroup(text, after) : -1;
      if (end < 0) { i = e; continue; }
      if (name in HEADINGS) items.push({ kind: 'heading', level: HEADINGS[name], from, to: end, innerFrom: after + 1, innerTo: end - 1 });
      else items.push({ kind: 'style', style: STYLES[name], from, to: end, innerFrom: after + 1, innerTo: end - 1 });
      i = after + 1;
      continue;
    }
    if (REFS.has(name) || CITES.has(name) || name === 'label') {
      const after = skipSpace(text, name === 'label' ? e : skipOptionals(text, e + star)), end = text[after] === '{' ? closeGroup(text, after) : -1;
      if (end < 0) { i = e; continue; }
      const list = keys(after, end);
      if (list.length) items.push(name === 'label' ? { kind: 'label', key: list[0], from, to: end } : { kind: REFS.has(name) ? 'ref' : 'cite', command: name, keys: list, from, to: end });
      i = end;
      continue;
    }
    if (name === 'includegraphics') {
      const after = skipSpace(text, skipOptionals(text, e + star)), end = text[after] === '{' ? closeGroup(text, after) : -1;
      if (end < 0) { i = e; continue; }
      const file = text.slice(after + 1, end - 1).trim();
      if (file) items.push({ kind: 'graphic', file, from, to: end });
      i = end;
      continue;
    }
    i = e;
  }
  return items;
}

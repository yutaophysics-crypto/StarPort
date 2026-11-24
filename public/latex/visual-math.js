// Turns a formula from the source into what KaTeX can draw, with the document's own macros and, where
// the last build knows it, its real equation number. A formula KaTeX cannot draw stays source.

const lastArg = body => { let n = 0; for (const m of body.matchAll(/#(\d)/g)) n = Math.max(n, Number(m[1])); return n; };
function readGroup(text, at) {
  let i = at;
  while (/\s/.test(text[i] || '')) i++;
  if (text[i] === '\\') { let e = i + 1; while (/[a-zA-Z@]/.test(text[e] || '')) e++; if (e === i + 1) e++; return { value: text.slice(i, e), end: e }; }
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return { value: text.slice(i + 1, j), end: j + 1 };
  }
  return null;
}
const commandName = value => /^\\(?:[a-zA-Z@]+|.)$/.test(value.trim()) ? value.trim() : null;
// KaTeX counts arguments from the ones the body uses; one declared but unused is consumed invisibly.
function define(macros, name, body, count = lastArg(body)) {
  let out = body;
  for (let k = 1; k <= count; k++) if (!out.includes('#' + k)) out += `\\@secondoftwo{#${k}}{}`;
  macros[name] = out;
}

// The macros a formula may use, from the preamble with its local files written in place.
export function collectMacros(preamble) {
  const text = String(preamble || '').replace(/(^|[^\\])%.*$/gm, '$1'), macros = {};
  for (const match of text.matchAll(/\\(?:new|renew|provide)command\*?\s*/g)) {
    let at = match.index + match[0].length;
    const head = readGroup(text, at), name = head && commandName(head.value);
    if (!name) continue;
    at = head.end;
    let count = 0, hasDefault = false;
    const num = /^\s*\[(\d)\]/.exec(text.slice(at, at + 12));
    if (num) { count = Number(num[1]); at += num[0].length; if (/^\s*\[/.test(text.slice(at, at + 6))) hasDefault = true; }
    if (hasDefault) { const close = text.indexOf(']', at); if (close < 0) continue; at = close + 1; }
    const body = readGroup(text, at);
    if (body && !hasDefault) define(macros, name, body.value, count);
  }
  for (const match of text.matchAll(/\\[gex]?def\s*(\\[a-zA-Z@]+)((?:#\d)*)\s*(?=\{)/g)) {
    const body = readGroup(text, match.index + match[0].length);
    if (body) define(macros, match[1], body.value, match[2].length / 2);
  }
  for (const match of text.matchAll(/\\DeclareMathOperator(\*?)\s*/g)) {
    const head = readGroup(text, match.index + match[0].length), name = head && commandName(head.value);
    const body = name && readGroup(text, head.end);
    if (body) macros[name] = `\\operatorname${match[1]}{${body.value}}`;
  }
  for (const match of text.matchAll(/\\DeclarePairedDelimiter\s*/g)) {
    const head = readGroup(text, match.index + match[0].length), name = head && commandName(head.value);
    const left = name && readGroup(text, head.end), right = left && readGroup(text, left.end);
    if (right) macros[name] = `\\left${left.value}#1\\right${right.value}`;
  }
  for (const match of text.matchAll(/\\let\s*(\\[a-zA-Z@]+)\s*=?\s*(\\[a-zA-Z]+)/g)) macros[match[1]] ??= match[2];
  return macros;
}
export const usesPackage = (preamble, name) => new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*(?<![\\w-])${name}(?![\\w-])`).test(String(preamble || '').replace(/(^|[^\\])%.*$/gm, '$1'));

// --- common physics notation ----------------------------------------------------------------
const tokens = group => group.tokens.slice().reverse().map(token => token.text).join(' ');
const arg = context => { context.consumeSpaces(); return tokens(context.consumeArg()); };
const braced = context => { context.consumeSpaces(); return context.future().text === '{'; };
function optional(context) {
  context.consumeSpaces();
  if (context.future().text !== '[') return '';
  context.popToken();
  let out = '';
  while (!['EOF', ']'].includes(context.future().text)) out += context.popToken().text + ' ';
  context.popToken();
  return out.trim();
}
function delimited(context) {
  context.consumeSpaces();
  const open = context.future().text, pair = { '(': ')', '[': ']', '|': '|', '\\{': '\\}' }[open];
  if (open === '{') return `\\left( ${tokens(context.consumeArg())} \\right)`;
  if (!pair) return '';
  context.popToken();
  let depth = 0, out = '';
  while (context.future().text !== 'EOF') {
    const text = context.future().text;
    if (text === pair && depth === 0) break;
    if (pair !== open) { if (text === open) depth++; else if (text === pair) depth--; }
    out += context.popToken().text + ' ';
  }
  context.popToken();
  return `\\left${open} ${out}\\right${pair}`;
}
const derivative = d => context => {
  const power = optional(context), up = power ? `^{${power}}` : '', first = arg(context);
  if (!braced(context)) return `\\frac{${d}${up}}{${d} ${first}${up}}`;
  return `\\frac{${d}${up} ${first}}{${d} ${arg(context)}${up}}`;
};
const COMMON = { '\\slashed': '\\not{#1}', '\\bm': '\\boldsymbol{#1}', '\\mathbbm': '\\mathbb{#1}', '\\bbm': '\\mathbb{#1}' };
const PHYSICS = {
  '\\abs': '\\left\\lvert #1\\right\\rvert', '\\norm': '\\left\\lVert #1\\right\\rVert',
  '\\mel': '\\left\\langle #1\\middle\\vert #2\\middle\\vert #3\\right\\rangle', '\\matrixel': '\\left\\langle #1\\middle\\vert #2\\middle\\vert #3\\right\\rangle',
  '\\comm': '\\left[#1,#2\\right]', '\\commutator': '\\left[#1,#2\\right]', '\\acomm': '\\left\\{#1,#2\\right\\}', '\\anticommutator': '\\left\\{#1,#2\\right\\}',
  '\\pb': '\\left\\{#1,#2\\right\\}', '\\op': '\\left\\lvert #1\\middle\\rangle\\!\\middle\\langle #2\\right\\rvert', '\\ip': '\\left\\langle #1\\middle\\vert #2\\right\\rangle',
  '\\pqty': '\\left(#1\\right)', '\\bqty': '\\left[#1\\right]', '\\Bqty': '\\left\\{#1\\right\\}', '\\vqty': '\\left\\lvert #1\\right\\rvert',
  '\\dd': '\\mathrm{d}', '\\tr': '\\operatorname{tr}', '\\Tr': '\\operatorname{Tr}', '\\rank': '\\operatorname{rank}', '\\erf': '\\operatorname{erf}',
  '\\vb': '\\mathbf{#1}', '\\va': '\\vec{\\mathbf{#1}}', '\\vu': '\\hat{\\mathbf{#1}}', '\\grad': '\\nabla', '\\curl': '\\nabla\\times', '\\divergence': '\\nabla\\cdot', '\\laplacian': '\\nabla^2',
  '\\order': '\\mathcal{O}\\left(#1\\right)', '\\qty': delimited, '\\dv': derivative('\\mathrm{d}'), '\\pdv': derivative('\\partial'),
  '\\braket': context => { const a = arg(context); return braced(context) ? `\\left\\langle ${a}\\middle\\vert ${arg(context)}\\right\\rangle` : `\\left\\langle ${a}\\middle\\vert ${a}\\right\\rangle`; }
};
// \expval{A} is ⟨A⟩; \expval{A}{ψ} is ⟨ψ|A|ψ⟩.
PHYSICS['\\expval'] = PHYSICS['\\ev'] = context => {
  const a = arg(context);
  if (!braced(context)) return `\\left\\langle ${a}\\right\\rangle`;
  const state = arg(context);
  return `\\left\\langle ${state}\\middle\\vert ${a}\\middle\\vert ${state}\\right\\rangle`;
};

export function documentMacros(preamble) {
  return { ...COMMON, ...(usesPackage(preamble, 'physics') ? PHYSICS : {}), ...collectMacros(preamble) };
}

// --- equation numbers ---------------------------------------------------------------------------
const NUMBERED = new Set(['equation', 'align', 'flalign', 'alignat', 'gather', 'multline', 'eqnarray']);
const ONE_NUMBER = new Set(['equation', 'multline']);
const NO_NUMBER = /\\(?:nonumber|notag|tag)(?![a-zA-Z])/;
const uncomment = text => String(text).replace(/(^|[^\\])%.*$/gm, '$1');
// The rows of a multi-line formula. Line breaks inside braces or an inner environment do not count.
export function splitRows(tex) {
  const rows = [];
  let depth = 0, inner = 0, start = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '\\') {
      if (/^\\begin(?![a-zA-Z])/.test(tex.slice(i, i + 7))) inner++;
      else if (/^\\end(?![a-zA-Z])/.test(tex.slice(i, i + 5))) inner--;
      else if (tex[i + 1] === '\\' && !depth && !inner) {
        const tail = /^\\\\\*?(?:\s*\[[^\]]*\])?/.exec(tex.slice(i))[0];
        rows.push({ text: tex.slice(start, i), end: tail });
        start = i + tail.length;
        i = start - 1;
        continue;
      }
      i++;
    }
  }
  rows.push({ text: tex.slice(start), end: '' });
  return rows;
}
const rowTakesNumber = text => !!text.trim() && !NO_NUMBER.test(text);
// How many numbers a formula uses: rows marked \nonumber, \notag or \tag take none.
export function numberedRows({ tex, env }) {
  if (!NUMBERED.has(env)) return 0;
  const body = uncomment(tex);
  if (ONE_NUMBER.has(env)) return NO_NUMBER.test(body) ? 0 : 1;
  return splitRows(body).filter(row => rowTakesNumber(row.text)).length;
}
// Gives each formula the numbers the last build used for it. While the formulas line up with the
// build's they go by order, so typing above them shifts nothing; otherwise only those still on the
// very line the build saw get one, rather than risk a wrong number until the next build.
export function assignNumbers(items, records = [], lineOf = () => 0) {
  const wanted = [];
  for (const item of items) if (item.kind === 'math') { delete item.numbers; const count = numberedRows(item); if (count) wanted.push({ item, count }); }
  const inOrder = wanted.length === records.length && wanted.every(({ count }, i) => records[i].numbers.length === count);
  const byLine = inOrder ? null : new Map(records.map(record => [record.line, record]));
  wanted.forEach(({ item, count }, i) => {
    const record = inOrder ? records[i] : byLine.get(lineOf(item.to));
    if (record?.numbers.length === count) item.numbers = record.numbers;
  });
}

// --- from the source's form to KaTeX's --------------------------------------------------------
const ENV = { align: 'align*', flalign: 'align*', gather: 'gather*', multline: 'gather*', alignat: 'alignat*', eqnarray: 'align*' };
const unmarked = text => text.replace(/\\label\s*\{[^{}]*\}/g, '').replace(/\\(?:nonumber|notag)(?![a-zA-Z])/g, '');
// eqnarray's "a &=& b" is align's "a &= b": the second & of each row goes.
function eqnarrayRow(text) {
  let depth = 0, seen = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '&' && !depth && ++seen === 2) return text.slice(0, i) + text.slice(i + 1);
  }
  return text;
}
const joinRows = rows => rows.map(row => row.text + row.end).join('');
// The build's number when it is known, else the number of a \label, else none.
export function mathSource({ tex, env, numbers }, labels = {}) {
  const base = env ? env.replace('*', '') : null, source = uncomment(tex);
  const numbered = NUMBERED.has(env);
  const wrap = body => {
    if (!env || base === 'equation' || base === 'displaymath' || base === 'math') return body;
    const inner = base === 'eqnarray' ? joinRows(splitRows(body).map(row => ({ ...row, text: eqnarrayRow(row.text) }))) : body;
    return `\\begin{${ENV[base]}}${inner}\\end{${ENV[base]}}`;
  };
  const plain = unmarked(source);
  let tagged;
  if (numbers?.length && ONE_NUMBER.has(env)) tagged = `${plain}\\tag{${numbers[0]}}`;
  else if (numbers?.length) {
    let next = 0;
    tagged = joinRows(splitRows(source).map(row => ({ ...row, text: unmarked(row.text) + (rowTakesNumber(row.text) && next < numbers.length ? `\\tag{${numbers[next++]}}` : '') })));
  } else tagged = unmarked(source.replace(/\\label\s*\{([^{}]*)\}/g, (whole, key) => (numbered && labels[key] !== undefined ? `\\tag{${labels[key]}}` : whole)));
  return { tagged: wrap(tagged), plain: wrap(plain) };
}
const OPTIONS = { throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 };
// The drawn HTML, or null. A number that cannot sit where the \label was is dropped, not the formula.
export function renderMath(katex, item, { macros = {}, labels = {} } = {}) {
  const { tagged, plain } = mathSource(item, labels);
  for (const tex of tagged === plain ? [plain] : [tagged, plain]) {
    try { return katex.renderToString(tex, { ...OPTIONS, displayMode: item.display, macros: { ...macros } }); } catch {}
  }
  return null;
}

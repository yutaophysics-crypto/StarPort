// Stands in for latexmk in tests/latex.test.mjs. STARPORT_FAKE_LATEX picks the outcome:
// ok, error (a PDF and an error in an included file), fatal (no PDF), slow (ok after a pause).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2), mode = process.env.STARPORT_FAKE_LATEX || 'ok';
const outDir = args.find(arg => arg.startsWith('-outdir=')).slice(8), file = args.at(-1), base = file.replace(/\.tex$/, '');
mkdirSync(outDir, { recursive: true });
appendFileSync(join(outDir, 'calls.txt'), JSON.stringify({ args, cwd: process.cwd(), openin: process.env.openin_any, width: process.env.max_print_line }) + '\n');
if (mode === 'slow') await new Promise(done => setTimeout(done, 500));
const log = mode === 'ok' || mode === 'slow'
  ? `This is pdfTeX\n(./${file}\n(./sections/a.tex)\n)\nOutput written on ${base}.pdf (1 page).\n`
  : `This is pdfTeX\n(./${file} (c:/texlive/2025/texmf-dist/tex/latex/base/article.cls)\n(./sections/a.tex\n./sections/a.tex:3: Undefined control sequence.\nl.3 \\undefinedmacro\n\nLaTeX Warning: Reference \`eq:x' on page 1 undefined on input line 2.\n\nOverfull \\hbox (3.0pt too wide) in paragraph at lines 4--5\n)\nPackage hyperref Warning: Token not allowed in a PDF string (Unicode):\n(hyperref)                removing \`math shift' on input line 7.\n\n)\n`;
writeFileSync(join(outDir, base + '.log'), log);
writeFileSync(join(outDir, base + '.fls'), `PWD ${process.cwd()}\nINPUT ./${file}\nINPUT ./sections/a.tex\nINPUT c:/texlive/2025/texmf-dist/tex/latex/base/article.cls\nOUTPUT ${base}.log\n`);
if (mode !== 'fatal') writeFileSync(join(outDir, base + '.pdf'), '%PDF-1.4 fake ' + Date.now() + '\n');
process.exit(mode === 'ok' || mode === 'slow' ? 0 : 12);

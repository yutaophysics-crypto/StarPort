// Stands in for a TeX engine in tests/latex-visual.test.mjs: compiles one picture file, or fails
// when its source says BROKEN, and counts its runs.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2), folder = args.find(arg => arg.startsWith('-output-directory=')).slice(18), file = args.at(-1), base = file.replace(/\.tex$/, '');
const source = readFileSync(join(folder, file), 'utf8');
appendFileSync(join(folder, 'runs.txt'), JSON.stringify({ cwd: process.cwd(), openin: process.env.openin_any, preview: source.includes('\\begin{preview}') }) + '\n');
await new Promise(done => setTimeout(done, 60));
if (source.includes('BROKEN')) {
  writeFileSync(join(folder, base + '.log'), `This is TeX\n./${file}:9: Undefined control sequence.\n`);
  process.exit(1);
}
writeFileSync(join(folder, base + '.log'), 'This is TeX\n');
writeFileSync(join(folder, base + '.pdf'), '%PDF-1.4 picture\n');

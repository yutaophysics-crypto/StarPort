// Rebuilds the LaTeX editor's vendored libraries in public/vendor. Starport itself never runs this:
// the output is committed, so the app has no build step. To update the libraries, in a scratch folder:
//   npm install codemirror@6 @codemirror/state@6 @codemirror/view@6 @codemirror/commands@6 @codemirror/search@6 \
//     @codemirror/autocomplete@6 @codemirror/lint@6 @codemirror/language@6 @codemirror/legacy-modes@6 pdfjs-dist@5 esbuild
//   node <repo>/scripts/vendor/build-latex-vendor.mjs <scratch>/node_modules
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modules = resolve(process.argv[2] || 'node_modules');
const repo = fileURLToPath(new URL('../..', import.meta.url));
const vendor = join(repo, 'public', 'vendor'), pdfOut = join(vendor, 'pdfjs');
const { build, transform } = await import(pathToFileURL(join(modules, 'esbuild', 'lib', 'main.js')).href);
const version = name => JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version;
mkdirSync(pdfOut, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL('./codemirror-entry.mjs', import.meta.url))],
  bundle: true, format: 'esm', minify: true, target: 'es2022', legalComments: 'none',
  nodePaths: [modules], outfile: join(vendor, 'codemirror.mjs')
});
copyFileSync(join(modules, 'codemirror', 'LICENSE'), join(vendor, 'codemirror-LICENSE.txt'));

const pdfjs = join(modules, 'pdfjs-dist');
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) copyFileSync(join(pdfjs, 'build', file), join(pdfOut, file));
const viewer = await transform(readFileSync(join(pdfjs, 'web', 'pdf_viewer.mjs'), 'utf8'), { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' });
writeFileSync(join(pdfOut, 'pdf_viewer.min.mjs'), '/* pdf.js viewer components, Apache-2.0, see LICENSE */\n' + viewer.code);
copyFileSync(join(pdfjs, 'LICENSE'), join(pdfOut, 'LICENSE'));

// Only the page, text-selection and link layers are used, so keep their rules. The rest of the stylesheet
// is the full viewer's dialogs and annotation editor, much of it pointing at images not shipped here.
const css = readFileSync(join(pdfjs, 'web', 'pdf_viewer.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const keep = /\.(textLayer|annotationLayer|pdfViewer|canvasWrapper|hiddenCanvasElement)\b|^:root$/;
const editor = /annotationEditor|editToolbar|altText|popup|signature|freeText|ink|stamp|commentButton/i;
let depth = 0, start = 0, kept = '';
for (let i = 0; i < css.length; i++) {
  if (css[i] === '{') depth++;
  else if (css[i] === '}' && --depth === 0) {
    const block = css.slice(start, i + 1), selector = block.slice(0, block.indexOf('{')).trim();
    const relevant = selector.startsWith('@') ? keep.test(block) : keep.test(selector);
    // Declarations naming those images go; the rest of their block stays.
    if (relevant && !editor.test(selector)) kept += block.replace(/[\w-]+\s*:[^;{}]*url\([^)]*\)[^;{}]*;?/g, '') + '\n';
    start = i + 1;
  }
}
writeFileSync(join(pdfOut, 'pdf_viewer.min.css'), '/* pdf.js viewer styles (subset), Apache-2.0, see LICENSE */\n' + (await transform(kept, { loader: 'css', minify: true })).code);

const versions = { codemirror: version('@codemirror/view'), state: version('@codemirror/state'), legacyModes: version('@codemirror/legacy-modes'), pdfjs: version('pdfjs-dist') };
writeFileSync(join(vendor, 'latex-vendor.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('vendored', versions);

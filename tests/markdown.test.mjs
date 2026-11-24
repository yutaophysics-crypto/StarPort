import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const runtime=vm.createContext({console:{warn(){},log(){}}});
for(const path of ['public/vendor/marked.min.js','public/vendor/katex.min.js','public/markdown.js'])vm.runInContext(readFileSync(new URL('../'+path,import.meta.url),'utf8'),runtime);
const render=text=>runtime.StarportMarkdown.render(text);
const count=(html,pattern)=>(html.match(pattern)||[]).length;
const mathCount=html=>count(html,/class="katex"/g);

// Actual failing structure: no blank line before $$; a standalone '=' inside TeX.
const regression=String.raw`四条实际约束及其大元胞平移为
$$
\boxed{
S_{j,\mathbf R}
=
T_{\mathbf R}\!\left[i^{\kappa_j}X_1[AQe_j]\,Z_0[Qe_j]\,Z_1[\mathsf H e_j]\right],
\qquad (\kappa_0,\kappa_1,\kappa_2,\kappa_3)=(2,0,2,0).
}
$$
其中 $e_j$ 是四维标准基，$T_{\mathbf R}$ 表示大元胞平移。约束空间是
$$
\boxed{\mathcal H_N=\{\lvert\psi\rangle:S_{j,\mathbf R}\lvert\psi\rangle=\lvert\psi\rangle\ \text{对所有 }j,\mathbf R\}.}
$$
例如第四条展开后很简单。`;
test('real imported display equations cannot become setext headings or swallow adjacent prose',()=>{
  const html=render(regression);assert.equal(mathCount(html),4);assert.equal(count(html,/class="katex-display"/g),2);
  assert.doesNotMatch(html,/<h[1-6]>|math-error|katex-error|STARPORTMATH|\$\$/);
  assert.match(html,/其中/);assert.match(html,/例如第四条展开后很简单。/);
  assert.doesNotMatch(html,/<annotation[^>]*>[^<]*其中/);
});
test('dollar and bracket delimiters preserve TeX before Markdown emphasis and escapes',()=>{
  const html=render(String.raw`**结论 $a_b*c_d$**，\(x_i^2\)。\[\begin{pmatrix}1&2\\3&4\end{pmatrix}\] $$\boxed{x=1}$$`);
  assert.equal(mathCount(html),4);assert.equal(count(html,/class="katex-display"/g),2);assert.doesNotMatch(html,/math-error|STARPORTMATH/);assert.match(html,/<strong>/);
});
test('GFM tables keep literal TeX pipes inside their own cells',()=>{
  const html=render('| 条件 | 结果 |\n| --- | --- |\n| $\\{x|x>0\\}$ | $|x|$ |');
  assert.equal(count(html,/<td>/g),2);assert.equal(mathCount(html),2);assert.doesNotMatch(html,/math-error/);
});
test('fenced, nested and inline code remain literal, including escaped delimiters and dollars',()=>{
  const source=['```latex\n$x_i$\n$$\nx\n=\n1\n$$\n```','~~~text\n\\(literal\\)\n~~~','> ```latex\n> $quoted$\n> ```','- ```latex\n  $listed$\n  ```','`$inline$` and ``a `$two$` b``','    $indented$','Cost $5 and $10; escaped \\$x\\$; real $x+1$.'].join('\n\n');
  const html=render(source);assert.equal(mathCount(html),1);assert.doesNotMatch(html,/STARPORTMATH|math-error/);assert.match(html,/\$indented\$/);assert.match(html,/Cost \$5 and \$10/);
});
test('blockquotes and nested lists support display math without leaking quote markers',()=>{
  const html=render('> 定义\n> $$\n> x\n> =\n> 1\n> $$\n\n- 公式\n  $$\n  y\n  =\n  2\n  $$');
  assert.equal(mathCount(html),2);assert.doesNotMatch(html,/math-error|STARPORTMATH/);assert.match(html,/<blockquote>/);assert.match(html,/<li>/);
  assert.doesNotMatch(html,/<annotation[^>]*>[^<]*&gt;/);
});
test('incomplete streaming math stays local and completes when its delimiter arrives',()=>{
  const prefix='正常文字\n$$\n\\boxed{x\n=\n1}';
  const partial=render(prefix);assert.equal(mathCount(partial),0);assert.match(partial,/math-pending/);assert.match(partial,/正常文字/);assert.doesNotMatch(partial,/<h1>/);
  const complete=render(prefix+'\n$$\n后续 $y$。');assert.equal(mathCount(complete),2);assert.doesNotMatch(complete,/math-pending|math-error/);
});
test('invalid TeX uses an escaped source fallback and does not prevent later valid formulas',()=>{
  const html=render(String.raw`坏公式 $\unknowncommand{x}$，好公式 $x^2$。`);
  assert.match(html,/math-error/);assert.doesNotMatch(html,/katex-error/);assert.equal(mathCount(html),1);
  const hostile=render('$$\\unknown{<img src=x onerror=alert(1)>}$$');assert.doesNotMatch(hostile,/<img/);assert.match(hostile,/&lt;img/);
});
test('raw HTML code and attributes, URL dollars and normal Markdown retain their meaning',()=>{
  const html=render('<code>$literal$</code> <span title="$attribute$">$x$</span>\n\n[link](https://example.com/$path$)\n\nHeading\n=======\n\n---\n\n- **item**');
  assert.equal(mathCount(html),1);assert.match(html,/<code>\$literal\$<\/code>/);assert.match(html,/title="\$attribute\$"/);assert.match(html,/href="https:\/\/example.com\/\$path\$"/);assert.match(html,/<h1>Heading<\/h1>/);assert.match(html,/<hr>/);assert.match(html,/<strong>item<\/strong>/);
});
test('literal placeholder-like input cannot forge or duplicate a formula; CRLF is supported',()=>{
  const literal='\uE000STARPORTMATH0\uE001';const html=render(literal+'\r\n$$\r\nx=1\r\n$$');assert.match(html,new RegExp(literal));assert.equal(mathCount(html),1);
  const hostile=render(String.raw`$\href{javascript:alert(1)}{click}$`);assert.doesNotMatch(hostile,/href="javascript:/i);
});

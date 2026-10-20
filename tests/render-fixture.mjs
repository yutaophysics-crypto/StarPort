// Local, isolated visual regression server; never invokes a native harness.
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const registry={resolve:()=>null,list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:false,statusLabel:'隔离测试环境'})),models:async()=>({models:[],source:'unavailable'})};
const hub=createHub({port:3211,dataDir:mkdtempSync(join(tmpdir(),'starport-render-')),registry});
if(process.argv[2]){
  const source=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const chat=hub.store.newChat({title:'渲染回归 · 导入示例',workspace:process.cwd()});
  for(const message of source.messages)hub.store.message(chat.id,message.role,message.provider,message.content,message.status,{});
}
const cases=hub.store.newChat({title:'公式与代码边界',workspace:process.cwd()});
hub.store.message(cases.id,'assistant','codex',[
  '普通标题\n========\n\n**粗体 $x_i^2$**，以及行内 \\(y_i\\)。',
  '> 定义\n> $$\n> x\n> =\n> 1\n> $$',
  '| 条件 | 结果 |\n| --- | --- |\n| $\\{x|x>0\\}$ | $|x|$ |',
  '```latex\n$$\nx = 1\n$$\n```\n\n`$literal$`，价格 $5 和 $10，公式 $x+1$。',
  '括号公式 \\[\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\\]。',
  '不支持的公式 $\\unknowncommand{x}$，后面仍然正常 $x^2$。',
  '<img src=x onerror="window.__mathXss=true"><script>window.__mathXss=true</script>',
  '正在接收的公式\n$$\n\\boxed{x=1'
].join('\n\n'),'complete');
await hub.listen();console.log('Isolated formula fixture http://127.0.0.1:3211');

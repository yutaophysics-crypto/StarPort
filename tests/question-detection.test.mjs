import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const context=vm.createContext({});
vm.runInContext(await readFile(new URL('../public/questions.js',import.meta.url),'utf8'),context);
const questions=context.StarportQuestions;

// Same structure as the reported failure: a numbered explanation includes a
// rhetorical question, answers it, then introduces ordinary Markdown bullets.
const explanation=`1. 第一个阶段不是直接完成全部工作，而是用小范围实验检查设计。
还有哪些环节可以优化？应先关注实际测量，而不是凭感觉判断。
2. 更重要的是验证场景，例如：

- 小型实验不需要完整的生产环境，先把关键步骤跑通即可。
- 记录输入、输出和异常，才能判断修改是否有效。
- 自动化验证能减少重复劳动，但不能替代对结果的检查。`;

test('numbered explanations and ordinary bullet lists never become reply cards because of an earlier question mark',()=>{
  const examples=[explanation,
    '为什么需要测试？主要有以下原因：\n\n- 发现边界问题\n- 验证预期行为',
    '你希望使用哪个模型？目前模型的能力主要包括：\n\n- 处理长文本\n- 整理文件',
    '你知道缓存如何工作吗？\n\n- 命中缓存时复用结果\n- 缓存失效时重新计算',
    'Why does the renderer wrap text?\n\n- The available width is limited.\n- Long content uses additional lines.',
    'Do you know how caching works?\n\n- A hit reuses the result.\n- A miss computes it again.'
  ];
  for(const text of examples)assert.equal(questions.extract(text).length,0,text);
});

test('explicit user choices and clarification prompts remain interactive in both languages',()=>{
  const examples=[
    '你希望先检查哪部分？\n\n- 消息显示\n- 文件打开',
    '你现在使用的是 Windows 还是 macOS？\n\n- Windows\n- macOS',
    '你说的“示例项目”是项目A吗？我先按它与项目B比较；若编号不同，请告诉我。\n\n- 是项目A\n- 不确定编号',
    '“主目录一半、子目录一半”是新增文件各一半，还是整个项目最终各一半？这会影响如何计算文件分布。\n\n- 新增文件各一半\n- 整个项目最终各一半',
    '请选择检查范围：\n\n- 单元测试\n- 浏览器测试',
    'Which model would you prefer?\n\n- Fast\n- Thorough',
    'Which checks would you like? This will determine the validation scope.\n\n- Unit tests\n- Browser tests',
    'Are you using Windows or macOS?\n\n- Windows\n- macOS',
    'Please choose the checks to run:\n\n- Unit tests\n- Browser tests',
    '你想选择哪一种？可选方案如下：\n\n- 保留当前设计\n- 使用新设计',
    '你希望使用版本 6.1 还是 6.0？\n\n- 6.1\n- 6.0'
  ];
  for(const text of examples)assert.equal(questions.extract(text).length,1,text);
});

test('inferred questions ignore source-code examples and literal LaTeX itemize lists',()=>{
  for(const text of [
    '```md\n你希望选择哪种？\n- A\n- B\n```',
    String.raw`为什么需要测试？
\begin{itemize}
\item 发现边界问题
\item 验证预期行为
\end{itemize}`,
    '批准删除文件？\n\n- 是\n- 否'
  ])assert.equal(questions.extract(text).length,0);
});

test('completed and streamed explanations produce no inferred question for every harness',()=>{
  for(const provider of ['codex','claude','antigravity','deepseek']){
    const message={id:'explanation',role:'assistant',provider,status:'running',content:explanation,details:{activity:[{kind:'text',status:'complete',text:explanation}]}};
    const state={messages:[message],queue:[],run:{approvals:[]}};
    assert.equal(questions.latest(state).questions.length,0,provider+' running');
    message.status='complete';state.run=null;
    assert.equal(questions.latest(state).questions.length,0,provider+' complete');
  }
});

test('real questions keep stable IDs, partial-list protection and answer/skip recovery',()=>{
  const text='你希望检查哪部分？\n\n- 消息显示\n- 文件打开';
  const row=questions.extract(text)[0];assert.ok(row);
  assert.equal(questions.extract(text,{allowTail:false}).length,0);
  assert.equal(questions.extract(text+'\n\n我会继续检查。',{allowTail:false})[0].id,row.id);
  const message={id:'choice',role:'assistant',status:'complete',content:text,details:{activity:[{kind:'text',status:'complete',text}]}};
  const state={messages:[message],queue:[],run:null};
  assert.equal(questions.latest(state).questions.length,1);
  state.queue.push({details:{replyTo:{messageId:message.id,questions:[row.id]}}});
  assert.equal(questions.latest(state).questions.length,0);
  state.queue=[];message.details.skippedQuestions=[row.id];
  assert.equal(questions.latest(state).questions.length,0);
  message.details.skippedQuestions=[];state.run={approvals:[{kind:'question'}]};
  assert.equal(questions.latest(state).questions.length,0);
});

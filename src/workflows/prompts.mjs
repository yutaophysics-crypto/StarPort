// The prompt each desk receives. These builders take plain data; Workflows gathers it.
// The task comes from the position; personality only colours how the result is told to the user.
import { historyMessage } from '../history-context.mjs';
import { clip, tail, oneLine, localTime } from './common.mjs';
import { runLabel, TRIGGER_LABEL, planTable } from './cards.mjs';
import { KNOWLEDGE } from './exam.mjs';
import { MAIN } from './planning.mjs';

// A one-way request names neither the room nor the conversation: its title comes from what was said.
const ONE_WAY=`这次点名是单向可见的：你看不到用户和对话模型之前聊过什么，只收到下面这条消息，以及同一次点名里排在你前面的伙伴的产出；你的回答会回到对话里。
缺少的背景不要猜，在结果里写明还需要用户补充什么。工作目录里 .starport/history 下是对话存档，不要读取。`;
export function identity(companion,{room,title,members,isolated=false}){
  const roster=members.map(c=>`${c.avatar} ${c.name}${c.role?'（'+c.role+'）':''}`).join('、');
  return `你是「${companion.name}」${companion.avatar}，星港里的一位伙伴。
${isolated?ONE_WAY:`你现在在房间「${room||'未分组'}」的对话「${title}」里工作。`}
房间里的伙伴：${roster||'（只有你）'}`;
}
const VERIFY='- 你是验收位：只按验收标准和上游产出逐条检查。没发现问题就判通过，不要为了挑刺而挑刺；不通过时写明哪一条没满足。最后一行单独写「验收：通过」或「验收：不通过——原因」。';
export function requirements(step,companion,{ledger=false}={}){
  return ['## 要求','- 第一行写「我负责：……」，一句话说明这次你接下的部分。',
    '- 做好你这一部分，不替别的伙伴完成它们的部分。分工以外如果发现会影响结论的重大问题（错误、风险、遗漏），在最后单列「分工外的发现」；没有就不写。',
    '- 你在无人值守的工位里运行：没人能回答问题或批准权限，需要审批的操作会被自动拒绝。需要人来做的事，写在结果里。',
    ...step.verify?[VERIFY]:[],
    ...ledger?['- 回复最后附一个 starport-ledger 代码块（没有改动也附 {}）。']:[],
    ...companion.persona?['','## 语气',`分析和结论不受性格影响。写给用户的文字可以带上你的语气：${companion.persona}`]:[]].join('\n');
}
export function upstream(outputs){
  if(!outputs.length)return '';
  let budget=30000;
  return '## 上游产出\n'+outputs.map(item=>{const body=clip(item.output,Math.max(800,Math.min(8000,budget)));budget-=body.length;return `### 第 ${item.order} 步 · ${item.avatar} ${item.companionName}${item.label?' · '+item.label:''}\n${body}`;}).join('\n\n');
}
// What happened in the conversation after `cursor` (the companion's last request), newest last.
// The companion's own earlier answers are left out because its desk remembers them; one-way
// answers came from another desk, so they are included.
export function progressSince(messages,cursor,{exclude=new Set(),companionId=null}={}){
  const start=cursor?messages.findIndex(m=>m.id===cursor)+1:0,lines=[];
  for(const message of messages.slice(start)){
    if(exclude.has(message.id))continue;
    const run=message.details?.workflowRun;
    if(run){
      // The conversation model's part of a run is its own reply below, not repeated here.
      const outputs=(run.steps||[]).filter(step=>step.output&&step.companionId!==MAIN.id&&(step.companionId!==companionId||run.isolated)).map(step=>`\n  ${step.companionName}：${clip(oneLine(step.output),600)}`).join('');
      lines.push(`[${run.title} · ${runLabel(run.status)}]${outputs}`);
    }else if(message.role==='user'&&message.details?.dispatchStep)lines.push(`星港把点名里的这部分交给了对话模型：${clip(oneLine(message.details.dispatchStep.task),600)}`);
    else if(message.role==='user'&&message.status==='complete')lines.push(`用户：${clip(message.content,3000)}`);
    else if(message.role==='assistant'){
      const record=historyMessage(message);
      if(record)lines.push(`对话模型（${message.provider||'unknown'}，messageId=${message.id}）：${clip(record.content,8000)}`);
    }
  }
  return tail(lines.join('\n\n'),12000);
}
// What the user said since the workflow's last run (or in the last 20 messages).
export function userNotes(messages,lastMessageId){
  const start=lastMessageId?messages.findIndex(m=>m.id===lastMessageId)+1:Math.max(0,messages.length-20);
  return tail(messages.slice(start).filter(m=>m.role==='user'&&m.status==='complete'&&!m.details?.dispatch&&!m.details?.dispatchStep).map(m=>`- ${clip(oneLine(m.content),600)}`).join('\n'),4000);
}
export function lastConclusion(run){
  if(!run)return '';
  const body=(run.steps||[]).filter(step=>step.output).map(step=>`- ${step.companionName}${step.label?'（'+step.label+'）':''}：${clip(oneLine(step.output),500)}`).join('\n');
  return body?`## 上次运行的结论（${localTime(run.started)} · ${runLabel(run.status)}）\n${tail(body,3000)}`:'';
}
const feedbackSection=feedback=>feedback?`## 上一轮验收意见\n${feedback}\n请针对这些意见修正你的产出。`:'';

const orderSection=(step,rows)=>rows.length>1?`## 本次执行顺序\n${planTable(rows)}\n你在第 ${step.order} 步。${rows.some(row=>row.companionId===MAIN.id)?'表里的「主模型」是这个对话自己的模型，它在对话里完成它那部分。':''}`:'';

export function adhocPrompt({intro,history,cursor,step,companion,context}){
  return [intro,
    context.isolated?'':`## 对话里自你上次发言以来的进展\n${history||(cursor?'（没有新的进展）':'（这是你第一次在这个对话里被点名）')}`,
    `## 用户这条消息（原文）\n${context.text}`,
    orderSection(step,context.rows),
    `## 你的分工\n${step.task}`,
    upstream(context.outputs),
    feedbackSection(context.feedback),
    requirements(step,companion)].filter(Boolean).join('\n\n');
}
// The conversation's own model takes its part of an @-message as an ordinary turn of this
// conversation, so it keeps its session, tools and approvals; only the framing is new.
export function mainPrompt({step,context}){
  return [`[星港点名] 用户在上面那条消息里点名了伙伴，也用 @主模型 点名了你。下面是排给你的部分；伙伴的部分由它们在各自工位完成，结果在对话里的运行卡片上。`,
    `## 用户那条消息（原文）\n${clip(context.text,20000)}`,
    orderSection(step,context.rows),
    `## 你的分工\n${step.task}`,
    upstream(context.outputs),
    feedbackSection(context.feedback),
    ['## 要求','- 只做你的分工，不替伙伴完成它们的部分。分工以外如果发现会影响结论的重大问题，在最后单独指出。',...step.verify?[VERIFY]:[]].join('\n')].filter(Boolean).join('\n\n');
}
// A companion called mid-task by the conversation's model or another companion. Its answer goes
// back to the caller as the call's result, and shows on the call's card in the conversation.
export function callPrompt({intro,history,caller,step,companion}){
  return [intro,
    `## 对话到现在的进展\n${history||'（还没有内容）'}`,
    `## ${caller} 交给你的任务\n${step.task}`,
    `${caller} 正在做事，做到一半把这件事交给了你。你的回答会作为结果交回给它，同时显示在对话的运行卡片上。任务说明里没写清的地方，按对话进展合理理解，并在结果里说明你的理解。`,
    requirements(step,companion)].filter(Boolean).join('\n\n');
}
// An examinee hears only the exam: no room, conversation, roster or memory.
export function examPrompt({companion,instruction,seat,knowledge}){
  return [`你是「${companion.name}」${companion.avatar}，正在星港的一个独立考场里作答。`,
    ['## 考场规则',
      `- 你的工作目录就是你的考位：${seat}。题目材料都在这里。只在这个目录里读写，不要查看或访问它以外的任何位置。`,
      '- 你看不到出题人的对话，也看不到其他考生；同一道题可能有其他考生在别处独立作答。',
      knowledge?`- 这是开卷考：${KNOWLEDGE}/ 里是允许参考的资料。`:'- 这是闭卷考：只用题目材料和你自己的知识。',
      '- 题目材料里写明的规则（比如哪些文件不能改、自测次数）必须遵守。交卷后会逐个文件核对材料有没有被改动，并检查你访问过的位置。',
      '- 你在无人值守的考位里运行：没人能回答问题或批准权限，需要审批的操作会被自动拒绝。缺少的信息不要猜，写在答卷里。'].join('\n'),
    `## 题目说明\n${instruction}`,
    '## 交卷\n你最后的回复就是答卷，会交给出题人评阅：写清结论、你做了什么、产出的文件在哪里（考位里的相对路径），以及还没解决的问题。',
    companion.persona?`## 语气\n分析和结论不受性格影响。写给用户的文字可以带上你的语气：${companion.persona}`:''].filter(Boolean).join('\n\n');
}
// `background` is the ledger section, or the last run's conclusion for workflows without one.
export function workflowPrompt({intro,step,companion,context,background}){
  const {workflow}=context;
  return [intro,
    `## 工作流「${workflow.name}」· ${TRIGGER_LABEL[context.trigger]||'手动'}运行 · ${localTime(Date.now())}`,
    workflow.description,workflow.acceptance?`验收标准：${workflow.acceptance}`:'',
    context.request?`## 用户这次的要求\n${context.request}`:'',
    `## 本次运行的分工表\n${planTable(context.rows)}`,
    `你的位置：第 ${step.order} 步 · ${step.stageName} · ${step.label}\n你的任务：${step.task}`,
    upstream(context.outputs),
    feedbackSection(context.feedback),
    context.history?`## 自上次运行以来，用户在这个对话里说过的话\n${context.history}`:'',
    background,
    requirements(step,companion,{ledger:workflow.ledger})].filter(Boolean).join('\n\n');
}

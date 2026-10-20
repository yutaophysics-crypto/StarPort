// The text form of a run card: what the conversation's own model and the history tools see.
import { clip, oneLine, localTime } from './common.mjs';

export const RUN_LABEL={proposed:'待开考',cancelled:'已取消',planning:'排顺序中',running:'运行中',done:'完成',passed:'验收通过',failed:'失败','verify-failed':'验收未通过',stopped:'已停止'};
export const TRIGGER_LABEL={schedule:'定时',catchup:'补跑',manual:'手动',dispatch:'点名',exam:'考场'};
export const runLabel=status=>RUN_LABEL[status]||status;

export function planTable(rows){
  return '| 顺序 | 伙伴 | 分工 |\n|---|---|---|\n'+rows.map(row=>`| ${row.order} | ${row.companionName||row.companionId}${row.label?'（'+row.label+'）':''} | ${clip(oneLine(row.task),180)}${row.verify?' · 验收':''} |`).join('\n');
}
const names=list=>list.slice(0,8).join('、')+(list.length>8?` 等 ${list.length} 个`:'');
// What the checks found in one seat after it handed in.
export function auditText(audit){
  if(!audit)return '';
  const changed=[audit.modified.length?'修改了 '+names(audit.modified):'',audit.deleted.length?'删除了 '+names(audit.deleted):''].filter(Boolean).join('；');
  const stray=audit.stray?.count?`越界：${audit.stray.count} 次工具调用碰到了考位以外的位置，例如 ${audit.stray.samples.map(hit=>`${hit.tool}「${hit.text}」`).slice(0,2).join('，')}`:'越界：未发现';
  return `试卷改动：${changed||'无'}；另新增 ${audit.added} 个文件\n${stray}`;
}
export function examSummary(run){
  const exam=run.exam,lines=[`试卷：${exam.paper.path}（${exam.paper.files} 个文件）`];
  if(exam.knowledge?.length)lines.push(`知识库：${exam.knowledge.map(item=>item.path).join('；')}`);
  if(exam.folder)lines.push(`考场文件夹：${exam.folder}`);
  return lines.join('\n');
}
function examText(run){
  const head=`**${run.title}** · ${runLabel(run.status)} · ${localTime(run.started)}`;
  const seats=['proposed','cancelled'].includes(run.status)?`考位：${(run.exam.seats||[]).map(seat=>(seat.companionName||seat.companionId)+(seat.knowledge?'（开卷）':'')).join('、')}`:'';
  const steps=(run.steps||[]).map(step=>[`### ${step.avatar||''} ${step.companionName} · ${step.label}${step.seat?.knowledge?' · 开卷':''}`,
    step.output||(step.error?'> '+step.error:''),step.seat?`考位文件夹：${step.seat.dir}`:'',auditText(step.seat?.audit)].filter(Boolean).join('\n\n'));
  return [head,examSummary(run),seats,...steps,...(run.notes||[]).map(note=>'> '+note)].filter(Boolean).join('\n\n');
}
export function cardText(run){
  if(run.kind==='exam')return examText(run);
  const head=`**${run.title}**${run.isolated?' · 单向可见':''} · ${runLabel(run.status)} · ${localTime(run.started)}`;
  const steps=(run.steps||[]).map(step=>`### ${step.avatar||''} ${step.companionName}${step.label?' · '+step.label:''}${step.attempt?` · 第 ${step.attempt+1} 次`:''}\n\n${step.output||(step.error?'> '+step.error:'')}`.trim());
  return [head,run.plan?.rows?.length>1?planTable(run.plan.rows):'',...steps,...(run.notes||[]).map(note=>'> '+note)].filter(Boolean).join('\n\n');
}
// Replying to a finished run attaches its outputs, within a fixed budget, to the user's message.
export function runContext(run){
  const label=`${run.title} · ${localTime(run.started)} · ${runLabel(run.status)}`;
  let budget=40000;
  const steps=(run.steps||[]).map(step=>{const body=clip(step.output||(step.error?'（失败）'+step.error:'（无产出）'),Math.max(1000,Math.min(10000,budget)));budget-=body.length;
    return `--- ${step.companionName}${step.label?' · '+step.label:''}${step.verdict?` · 验收 ${step.verdict}`:''} ---\n${body}`;}).join('\n\n');
  return {label,context:`[用户在回复星港的一次运行：${label}]\n${run.plan?.rows?.length>1?planTable(run.plan.rows)+'\n\n':''}${steps}`};
}

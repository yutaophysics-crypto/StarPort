// Turning an @-mention message into an execution order, and reading a verifier's verdict.

// Names are matched exactly and longest first, so Chinese text after a name is never swallowed.
export function parseMentions(value,companions){
  const source=String(value||''),names=[...companions].filter(c=>c?.name).sort((a,b)=>b.name.length-a.name.length),hits=[];
  for(let i=0;i<source.length;i++){
    if(source[i]!=='@'&&source[i]!=='＠')continue;
    const match=names.find(c=>source.startsWith(c.name,i+1));
    if(match){hits.push({companion:match,start:i,end:i+1+match.name.length});i+=match.name.length;}
  }
  return hits.map((hit,index)=>({companion:hit.companion,segment:source.slice(hit.end,hits[index+1]?.start??source.length).replace(/^[\s，,：:、。.;；]+/,'').trim()}));
}
export function verdict(value){
  const source=String(value||''),zh=[...source.matchAll(/验收[:：]\s*\**\s*(不通过|未通过|通过)/g)];
  if(zh.length)return zh.at(-1)[1]==='通过'?'pass':'fail';
  const en=[...source.matchAll(/VERDICT[:：]\s*(PASS|FAIL)/gi)];
  return en.length?(/pass/i.test(en.at(-1)[1])?'pass':'fail'):null;
}

// The no-model fallback: a later mention that talks about "after"/"check" waits for the earlier ones.
const SEQUENCE=/(之后|以后|做完|完成后|然后|接着|随后|再由|最后|验收|检查|审核|复核|核对|review|verify|check)/i;
const CHECKING=/(验收|检查|审核|复核|核对|把关|review|verify|check)/i;
export function heuristicPlan(value,mentions){
  let order=0;
  const rows=mentions.map((mention,index)=>{
    const segment=mention.segment||String(value||'');
    if(index===0||SEQUENCE.test(segment))order++;
    return {order,companionId:mention.companion.id,task:segment,verify:index>0&&CHECKING.test(segment)};
  });
  return {rows};
}

export function plannerPrompt(value,mentions){
  const roster=mentions.map(m=>`- id=${m.companion.id} 名字=${m.companion.name}${m.companion.role?' 角色='+m.companion.role:''}`).join('\n');
  return `你是星港的排程员。用户在房间里点名了几位伙伴，请根据用户原话排出执行顺序表。只输出一个 JSON 对象，不要输出任何别的文字。

被点名的伙伴：
${roster}

用户原话：
"""
${value}
"""

规则：
- 只使用上面列出的伙伴，用 id 指代；每位伙伴至少出现一次。
- order 从 1 开始。同一个 order 的步骤并行；order 大的步骤在之前的步骤全部完成后才开始，并能看到之前的产出。
- 用户说“某人做完后另一人验收/检查/审核”时，后者的 order 更大，并标 verify=true。
- 用户没有说先后关系的，放在同一个 order 并行。
- task 按用户原意概括这一步要做的事，不要添加用户没要求的工作。

输出格式：{"steps":[{"order":1,"companion":"<id>","task":"…","verify":false}]}`;
}
// A planner answer is accepted only if it uses exactly the mentioned companions.
export function parsePlan(output,mentions){
  const source=String(output||''),fenced=source.match(/```(?:json)?\s*\n([\s\S]*?)```/),candidate=fenced?fenced[1]:source.slice(source.indexOf('{'),source.lastIndexOf('}')+1);
  let data;try{data=JSON.parse(candidate);}catch{return null;}
  const allowed=new Map(mentions.map(m=>[m.companion.id,m.companion])),byName=new Map(mentions.map(m=>[m.companion.name,m.companion]));
  if(!Array.isArray(data?.steps)||!data.steps.length||data.steps.length>16)return null;
  const rows=[];
  for(const step of data.steps){
    const companion=allowed.get(step?.companion)||byName.get(step?.companion);const order=Number(step?.order);
    if(!companion||!Number.isInteger(order)||order<1||order>16||typeof step.task!=='string'||!step.task.trim())return null;
    rows.push({order,companionId:companion.id,task:step.task.trim().slice(0,4000),verify:step.verify===true});
  }
  if(![...allowed.keys()].every(id=>rows.some(row=>row.companionId===id)))return null;
  const orders=[...new Set(rows.map(row=>row.order))].sort((a,b)=>a-b);
  for(const row of rows)row.order=orders.indexOf(row.order)+1;
  return {rows:rows.sort((a,b)=>a.order-b.order)};
}

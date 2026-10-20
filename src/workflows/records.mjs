// Validation for companions, workflows and triggers, and the tool options a desk runs with.
import { PROVIDERS, validateOptions } from '../providers.mjs';
import { fail, text, slug, newId } from './common.mjs';

// Unattended desks must never wait for a person: anything that still asks is
// declined automatically. A companion picks its tool's own 工作方式; these presets
// are the older three-level setting, kept for older companions and the planner.
export const ACCESS={
  readonly:{claude:{permissionMode:'dontAsk'},codex:{mode:'chat',permissionMode:'read-only'},antigravity:{mode:'auto',permissionMode:'configured',sandbox:true},deepseek:{}},
  workspace:{claude:{permissionMode:'acceptEdits'},codex:{mode:'chat',permissionMode:'ask'},antigravity:{mode:'accept-edits',permissionMode:'configured',sandbox:true},deepseek:{}},
  full:{claude:{permissionMode:'bypassPermissions'},codex:{mode:'chat',permissionMode:'full-access'},antigravity:{mode:'accept-edits',permissionMode:'allow-all',sandbox:false},deepseek:{}}
};
// The choices come from each tool's own options; the descriptions say what happens at a
// desk nobody is watching. Codex 目标模式 is left out: the assembled desk prompt
// is a task rather than a goal to keep pursuing indefinitely.
const DESK_KEYS={claude:['permissionMode'],codex:['mode','permissionMode'],antigravity:['mode','permissionMode','sandbox'],deepseek:[]};
const UNATTENDED={
  claude:{default:'需要审批的操作会被自动拒绝。',plan:'只读分析，不修改文件、不运行命令。',dontAsk:'只做原工具规则已允许的操作，其余直接拒绝。',
    acceptEdits:'可编辑工作目录里的文件；运行命令（如 Python）仍需审批，会被自动拒绝。'},
  codex:{'read-only':'只读取文件、运行只读命令，不修改工作目录。',ask:'在工作目录内读写、运行命令；需要额外权限的操作会被自动拒绝。'},
  antigravity:{configured:'按原工具的权限规则执行；需要审批的操作会被拒绝。'}
};
export const DESK_FIELDS=Object.fromEntries(Object.entries(DESK_KEYS).map(([provider,keys])=>[provider,keys.map(key=>{
  const field=PROVIDERS[provider].fields.find(item=>item.key===key),notes=UNATTENDED[provider]||{};
  let choices=field.choices;
  if(provider==='codex'&&key==='mode')choices=choices.filter(choice=>choice.value!=='goal');
  if(provider==='codex'&&key==='permissionMode')choices=[{value:'read-only',label:'只读'},...choices];
  return {key,label:field.label,type:field.type,default:ACCESS.readonly[provider][key],
    ...(choices?{choices:choices.map(choice=>notes[choice.value]?{...choice,description:notes[choice.value]}:choice)}:{})};
})]));
export const DEFAULT_PLANNERS=[
  {provider:'codex',model:'gpt-6-luna',effort:''},
  {provider:'antigravity',model:'claude-sonnet-5-5-low',effort:''},
  {provider:'deepseek',model:'deepseek-flash',effort:''}
];

// A companion's 工作方式 for its tool; anything it has not chosen comes from the old preset.
export function companionOptions(provider,options,access='readonly'){
  if(options!=null&&(typeof options!=='object'||Array.isArray(options)))throw fail('工作方式格式无效');
  const preset=ACCESS[access]?.[provider]||ACCESS.readonly[provider]||{},result={};
  for(const field of DESK_FIELDS[provider]||[]){
    const value=options?.[field.key]??preset[field.key];
    if(field.type==='select'&&!field.choices.some(choice=>choice.value===value))throw fail(`${field.label}选项无效`);
    if(field.type==='checkbox'&&typeof value!=='boolean')throw fail(`${field.label}格式无效`);
    result[field.key]=value;
  }
  return result;
}
export function companionData(raw={},old=null){
  const next={...old,...raw};
  const provider=next.provider||'codex';if(!PROVIDERS[provider])throw fail('未知工具');
  const effort=text(next.effort,100,'思考强度');if(effort&&!/^[\w-]+$/.test(effort))throw fail('思考强度格式无效');
  const access=next.access||'readonly';if(!ACCESS[access])throw fail('权限预设无效');
  // Switching tools without new choices falls back to the preset, never to the old tool's values.
  const options=companionOptions(provider,raw.options??(old?.provider===provider?old.options:null),access);
  return {name:text(next.name,40,'名字',true),avatar:text(next.avatar,16,'头像')||'·',role:text(next.role,80,'角色'),persona:text(next.persona,4000,'性格'),
    provider,model:text(next.model,200,'模型'),effort,service:text(next.service,200,'模型服务'),access,options};
}
export function deskOptions(provider,{model='',effort='',service='',options=null,access='readonly'}={}){
  const raw={...companionOptions(provider,options,access),model,effort};
  // 只读 is Codex's read-only sandbox; anything beyond it asks, and the desk declines.
  if(provider==='codex'&&raw.permissionMode==='read-only')Object.assign(raw,{permissionMode:'ask',sandbox:'read-only'});
  if(provider==='deepseek'&&service)raw.provider=service;
  return validateOptions(provider,raw);
}
export function workflowData(raw={},old=null){
  const next={...old,...raw};
  if(!Array.isArray(next.stages)||!next.stages.length||next.stages.length>12)throw fail('工作流需要 1–12 个阶段');
  const seen=new Set();
  const stages=next.stages.map((stage,i)=>{
    if(!stage||typeof stage!=='object'||!Array.isArray(stage.positions)||!stage.positions.length||stage.positions.length>8)throw fail(`第 ${i+1} 阶段需要 1–8 个位置`);
    return {id:slug(stage.id,'s_'),name:text(stage.name,60,'阶段名称')||`第 ${i+1} 阶段`,positions:stage.positions.map((position,j)=>{
      let id=slug(position?.id,'p_');if(seen.has(id))id=newId('p_');seen.add(id);
      return {id,name:text(position?.name,60,'位置名称')||`位置 ${j+1}`,task:text(position?.task,6000,`「${position?.name||'位置 '+(j+1)}」的任务`,true),verify:position?.verify===true};
    })};
  });
  const retries=Number(next.retries??0);if(!Number.isInteger(retries)||retries<0||retries>3)throw fail('验收失败重试次数应为 0–3');
  return {name:text(next.name,80,'工作流名称',true),description:text(next.description,4000,'说明'),acceptance:text(next.acceptance,4000,'验收标准'),
    ledger:next.ledger===true,retries,stages,planTemplate:text(next.planTemplate,20000,'台账模板')};
}
export function triggerData(raw){
  const type=raw?.type;
  if(type==='manual')return {type};
  if(type==='daily'){
    if(typeof raw.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time))throw fail('时间格式应为 HH:MM');
    const days=[...new Set((Array.isArray(raw.days)?raw.days:[1,2,3,4,5,6,7]).map(Number))].filter(d=>Number.isInteger(d)&&d>=1&&d<=7).sort((a,b)=>a-b);
    if(!days.length)throw fail('至少选择一天');
    return {type,time:raw.time,days};
  }
  if(type==='interval'){
    const unit=raw.unit==='hours'?'hours':'minutes',every=Number(raw.every);
    if(!Number.isInteger(every)||every<1||every>10000)throw fail('间隔应为正整数');
    if(unit==='minutes'&&every<5)throw fail('间隔至少 5 分钟');
    return {type,every,unit};
  }
  throw fail('触发方式无效');
}
// Days are ISO weekdays: 1 = Monday … 7 = Sunday, in the computer's local time.
export function nextSlot(trigger,from){
  if(trigger?.type==='daily'){
    const [hour,minute]=trigger.time.split(':').map(Number);
    for(let i=0;i<9;i++){
      const day=new Date(from);day.setDate(day.getDate()+i);day.setHours(hour,minute,0,0);
      if(day.getTime()>from&&trigger.days.includes((day.getDay()+6)%7+1))return day.getTime();
    }
    return null;
  }
  if(trigger?.type==='interval')return from+trigger.every*(trigger.unit==='hours'?3600000:60000);
  return null;
}
// Checks a position→companion map against a workflow; unknown companions are rejected.
export function assignmentsFor(workflow,raw,old,exists){
  if(raw&&(typeof raw!=='object'||Array.isArray(raw)))throw fail('位置安排无效');
  const result={};
  for(const stage of workflow.stages)for(const position of stage.positions){
    const value=raw&&Object.hasOwn(raw,position.id)?raw[position.id]:old[position.id]??null;
    if(value!==null&&(typeof value!=='string'||!exists(value)))throw fail(`「${position.name}」的伙伴不存在`);
    result[position.id]=value;
  }
  return result;
}

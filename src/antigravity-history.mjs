import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { mergeActivity, nativeStatus, settleActivity } from './activity.mjs';
import { redact } from './process.mjs';

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN=new Set(['USER_INPUT','PLANNER_RESPONSE','GENERIC','SYSTEM_MESSAGE','CHECKPOINT','ERROR_MESSAGE']);
const MEDIA_NOTICE='原对话的图片、音频和文件未复制；保留文字与附件引用。';
// Tool records are kept for reference only, so very long inputs and outputs are shortened.
const FIELD_LIMIT=20000;

export const historyDate=(value,fallback)=>{
  if(typeof value==='number')return Number.isFinite(value)&&value>0?new Date(value).toISOString():fallback;
  if(typeof value!=='string'||!value)return fallback;
  // agy writes both "2026-09-25T17:31:04Z" and "2026-09-25 17:31:04.0212156+00:00".
  const time=Date.parse(value.replace(' ','T').replace(/(\.\d{3})\d+/,'$1'));
  return Number.isFinite(time)&&time>0?new Date(time).toISOString():fallback;
};
export const capText=(value,limit=FIELD_LIMIT)=>typeof value==='string'&&value.length>limit?value.slice(0,limit)+`\n…（已截断，原文共 ${value.length} 字符）`:value;
export const capInput=value=>{
  if(typeof value==='string')return capText(value);
  if(!value||typeof value!=='object')return value;
  const text=JSON.stringify(value);
  return text.length>FIELD_LIMIT?capText(JSON.stringify(value,null,2)):value;
};

// Starport adds its own instructions and, for a fresh native session, the earlier messages of
// the chat to every prompt. A conversation Starport started keeps that text, so it is unpacked
// here: preamble lines go, packed history becomes messages again.
const PREAMBLE=['星港候选记忆约定：','星港个人偏好（','星港项目要求（','这些偏好和要求不能扩大原工具权限','星港长期记忆','关键词候选索引：','星港集成说明','星港历史与记忆工具','星港考场：','当前原工具通过命令工具','记忆检索：同一命令','提议考场：','通过命令调用：'];
const HISTORY_HEADER='以下是当前对话的历史和最新请求。';
// Plan mode puts agy's /plan command in front of what Starport sent.
const PLAN=/^\/plan\s+/;
export const isStarportPrompt=text=>{text=text.replace(PLAN,'');return PREAMBLE.some(prefix=>text.startsWith(prefix))||text.startsWith(HISTORY_HEADER);};
export function unpackStarportPrompt(text){
  const lines=text.replace(PLAN,'').split('\n');let i=0;
  while(i<lines.length&&PREAMBLE.some(prefix=>lines[i].startsWith(prefix))){
    const line=lines[i++];
    // The preference and project blocks carry their content as one JSON line.
    if(/^星港(个人偏好|项目要求)（/.test(line)&&/^["{]/.test(lines[i]||''))i++;
  }
  const rest=lines.slice(i).join('\n');
  if(!rest.startsWith(HISTORY_HEADER))return {messages:[{role:'user',content:rest.trim()}],partial:false};
  const parts=rest.slice(rest.indexOf('\n')+1).split(/\n--- (用户|助手 \(([^)\n]*)\)) ---\n/);
  const messages=[];
  for(let k=1;k+2<parts.length;k+=3)messages.push({role:parts[k]==='用户'?'user':'assistant',provider:parts[k+1]||null,content:parts[k+2].trim()});
  return {messages:messages.filter(m=>m.content),partial:/<对话摘要>|较早的 \d+ 条消息/.test(parts[0])};
}

export function antigravityRequest(content){
  const text=typeof content==='string'?content:'';
  const open=text.indexOf('<USER_REQUEST>');
  if(open<0)return text.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g,'').trim();
  const start=open+'<USER_REQUEST>'.length,meta=text.indexOf('<ADDITIONAL_METADATA>',start);
  let end=text.lastIndexOf('</USER_REQUEST>',meta<0?text.length:meta);
  if(end<start)end=meta<0?text.length:meta;
  return text.slice(start,end).trim();
}

// agy prefixes every tool result with when it started and finished.
function toolResult(record){
  let text=typeof record.content==='string'?record.content:'',durationMs;
  const head=/^Created At: ([^\n]*)\n(?:Completed At: ([^\n]*)\n)?/.exec(text);
  if(head){
    text=text.slice(head[0].length);
    const start=Date.parse(head[1]),end=Date.parse(head[2]||'');
    if(Number.isFinite(start)&&Number.isFinite(end)&&end>=start)durationMs=end-start;
  }
  if(record.error)text=(text?text+'\n\n':'')+String(record.error);
  if(Array.isArray(record.media)&&record.media.length)text+=(text?'\n':'')+record.media.map(m=>`[${typeof m?.mime_type==='string'?m.mime_type:'media'}]`).join('\n');
  return {output:capText(text.trim()),durationMs};
}

// One transcript becomes user and assistant messages. Hidden reasoning, agy's own system
// messages and checkpoints stay behind; tool calls become a record on the reply they belong to.
export function convertAntigravityTranscript(records,{fallback=new Date().toISOString(),running=false}={}){
  const messages=[],calls=[];let assistant=null,pending=[],turnError=null,unknown=0,packed=false;
  const finishTurn=()=>{
    if(pending.length){assistant={role:'assistant',content:'',status:'complete',created:messages.at(-1)?.created||fallback,details:{source:{provider:'antigravity',type:'activity'},activity:pending}};messages.push(assistant);pending=[];}
    if(turnError){
      const target=assistant||(messages.push({role:'assistant',content:'',status:'error',created:turnError.created,details:{source:{provider:'antigravity',type:'ERROR_MESSAGE'},activity:[]}}),messages.at(-1));
      target.status='error';(target.details.notices??=[]).push('Antigravity 报错：'+capText(redact(turnError.text),500));
    }
    assistant=null;turnError=null;calls.length=0;
  };
  for(const record of records){
    if(!record||typeof record!=='object'||!KNOWN.has(record.type)){unknown++;continue;}
    const created=historyDate(record.created_at,fallback),step=Number.isInteger(record.step_index)?record.step_index:null;
    if(record.type==='USER_INPUT'){
      finishTurn();
      let content=antigravityRequest(record.content);const notices=[];
      if(Array.isArray(record.media)&&record.media.length){notices.push(MEDIA_NOTICE);content+=(content?'\n\n':'')+record.media.map(m=>`[${typeof m?.mime_type==='string'?m.mime_type:'media'}]`).join('\n');}
      const source={provider:'antigravity',stepIndex:step,type:'USER_INPUT'};
      if(isStarportPrompt(content)){
        const unpacked=unpackStarportPrompt(content);packed||=unpacked.partial;
        const latest=unpacked.messages.at(-1)?.role==='user'?unpacked.messages.pop():null;
        for(const m of unpacked.messages)messages.push({role:m.role,content:m.content,status:'complete',created,
          ...(m.role==='assistant'&&m.provider&&m.provider!=='unknown'?{provider:m.provider}:{}),details:{source:{...source,packed:true}}});
        content=latest?.content||'';
      }
      if(content.trim())messages.push({role:'user',content,status:'complete',created,details:{source,...(notices.length?{notices}:{})}});
      continue;
    }
    if(record.type==='PLANNER_RESPONSE'){
      const text=typeof record.content==='string'?record.content.trim():'';
      if(text){
        turnError=null;
        assistant={role:'assistant',content:text,status:'complete',created,details:{source:{provider:'antigravity',stepIndex:step,type:'PLANNER_RESPONSE'},activity:pending}};
        messages.push(assistant);pending=[];
      }
      for(const [index,call] of (Array.isArray(record.tool_calls)?record.tool_calls:[]).entries()){
        if(!call||typeof call.name!=='string')continue;
        const args=call.args&&typeof call.args==='object'?{...call.args}:call.args;
        const summary=typeof args?.toolSummary==='string'?args.toolSummary:undefined;
        if(args&&typeof args==='object'){delete args.toolSummary;delete args.toolAction;}
        const target=assistant?assistant.details.activity:pending,id=`agy:${step??messages.length}:${index}`;
        mergeActivity(target,{type:'tool',id,name:call.name,status:'running',input:capInput(args),...(summary?{text:summary}:{}),stepIndex:step});
        calls.push({id,target});
      }
      continue;
    }
    if(record.type==='GENERIC'){
      const call=calls.shift(),{output,durationMs}=toolResult(record),status=nativeStatus(record.status);
      if(call)mergeActivity(call.target,{type:'tool',id:call.id,status,output,durationMs});
      else mergeActivity(assistant?assistant.details.activity:pending,{type:'tool',id:`agy:${step??messages.length}:result`,kind:'step',name:'工具结果',status,output,durationMs,stepIndex:step});
      continue;
    }
    if(record.type==='ERROR_MESSAGE'){
      const text=[record.error,record.content].filter(v=>typeof v==='string'&&v.trim()).join('\n')||'未知错误';
      turnError={text,created};
    }
    // SYSTEM_MESSAGE and CHECKPOINT are agy's own bookkeeping, not part of the conversation.
  }
  finishTurn();
  const last=messages.at(-1);
  if(running&&last?.role==='assistant'&&last.status==='complete'){last.status='interrupted';(last.details.notices??=[]).push('导入时原对话仍在运行，只复制了当时已有的内容。');}
  const first=messages[0];
  if(first&&unknown)(first.details.notices??=[]).push('原记录中有部分无法识别的步骤，未导入。');
  if(first&&packed)(first.details.notices??=[]).push('这段对话由星港发起；星港当时只把摘要或部分较早的消息交给了 Antigravity，更早的原文不在这份记录里。');
  for(const message of messages)if(message.details.activity)settleActivity(message.details,message.status);
  return messages;
}

const workspaceOf=uris=>{
  try{const list=JSON.parse(uris||'[]');const uri=Array.isArray(list)?list.find(v=>typeof v==='string'&&v.startsWith('file:')):null;return uri?fileURLToPath(uri):'';}catch{return '';}
};

// Reads agy's local files directly and read-only: the conversation index in
// conversation_summaries.db and each conversation's JSON transcript. No account is contacted.
export class AntigravityHistory {
  constructor(home=join(homedir(),'.gemini','antigravity-cli')){this.home=home;this.heads=new Map();}
  transcript(id){
    const logs=join(this.home,'brain',id,'.system_generated','logs');
    for(const [name,truncated] of [['transcript_full.jsonl',false],['transcript.jsonl',true]]){const file=join(logs,name);if(existsSync(file))return {file,truncated};}
    return null;
  }
  summaries(){
    const file=join(this.home,'conversation_summaries.db');
    if(!existsSync(file))return [];
    let db;
    try{
      db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=3000');
      const columns=new Set(db.prepare("SELECT name FROM pragma_table_info('conversation_summaries')").all().map(c=>c.name));
      if(!columns.has('conversation_id'))throw new Error();
      const wanted=['conversation_id','title','preview','last_modified_time','workspace_uris','status','parent_conversation_id'].filter(name=>columns.has(name));
      return db.prepare(`SELECT ${wanted.join(',')} FROM conversation_summaries`).all();
    }catch{throw new Error('Antigravity 的对话索引格式无法识别，未读取');}
    finally{db?.close();}
  }
  // The first request tells whether Starport started the conversation, gives a title when agy
  // has none, and its time is the conversation's start. Only the file's beginning is read.
  head(id,file){
    const stat=statSync(file),key=stat.size+':'+stat.mtimeMs,cached=this.heads.get(id);
    if(cached?.key===key)return cached;
    const fd=openSync(file,'r'),buffer=Buffer.alloc(Math.min(stat.size,512*1024));
    try{readSync(fd,buffer,0,buffer.length,0);}finally{closeSync(fd);}
    let created=null,starport=false,request='';
    for(const line of buffer.toString('utf8').split('\n')){
      let record;
      try{record=JSON.parse(line);}catch{
        // A long first request may not fit in what was read; its opening words are enough.
        const at=line.indexOf('<USER_REQUEST>');
        if(line.includes('"USER_INPUT"')&&at>=0)starport=isStarportPrompt(line.slice(at+14).replace(/^(\\n|\s)+/,''));
        created??=historyDate(/"created_at":"([^"]+)"/.exec(line)?.[1],null);
        break;
      }
      created??=historyDate(record?.created_at,null);
      if(record?.type==='USER_INPUT'){
        const text=antigravityRequest(record.content);starport=isStarportPrompt(text);
        request=(starport?unpackStarportPrompt(text).messages.find(m=>m.role==='user')?.content||'':text).trim().split('\n')[0].slice(0,120);
        break;
      }
    }
    const head={key,created,starport,request};this.heads.set(id,head);return head;
  }
  summary(row){
    const updated=historyDate(row.last_modified_time,new Date().toISOString()),transcript=this.transcript(row.conversation_id);
    const head=transcript?this.head(row.conversation_id,transcript.file):{};
    // agy titles a conversation Starport started after the instructions Starport put first.
    const title=[row.title,row.preview].map(v=>String(v||'').trim()).find(v=>v&&!isStarportPrompt(v))||head.request||'Antigravity 对话';
    return {id:row.conversation_id,title:title.slice(0,300),
      workspace:workspaceOf(row.workspace_uris),created:head.created&&head.created<=updated?head.created:updated,updated,
      ...(head.starport?{origin:'starport'}:{})};
  }
  async list({cursor=null,search='',archived=false,exclude=new Set()}={}){
    if(archived)throw new Error('Antigravity 本地历史不区分归档，请选择全部对话');
    if(cursor!==null&&!/^(0|[1-9]\d{0,6})$/.test(cursor))throw new Error('搜索条件无效');
    const offset=Number(cursor||0),term=search.trim().toLocaleLowerCase();
    // Subagent conversations belong to their parent; conversations Starport still holds are already here.
    const rows=this.summaries().filter(row=>typeof row.conversation_id==='string'&&ID.test(row.conversation_id)&&!row.parent_conversation_id&&!exclude.has(row.conversation_id)&&this.transcript(row.conversation_id))
      .map(row=>this.summary(row))
      .filter(s=>!term||s.title.toLocaleLowerCase().includes(term)||s.workspace.toLocaleLowerCase().includes(term))
      .sort((a,b)=>b.updated.localeCompare(a.updated)||a.id.localeCompare(b.id));
    return {data:rows.slice(offset,offset+30),nextCursor:offset+30<rows.length?String(offset+30):null};
  }
  async read(id,{preview=false}={}){
    if(!ID.test(id))throw new Error('对话标识无效');
    const row=this.summaries().find(r=>r.conversation_id===id),transcript=row&&this.transcript(id);
    if(!row||!transcript)throw new Error('本机未找到这段 Antigravity 对话，请刷新列表');
    if(row.parent_conversation_id)throw new Error('这是 Antigravity 的子任务对话，请导入它所属的主对话');
    if(statSync(transcript.file).size>128*1024*1024)throw new Error('Antigravity 原记录超过 128 MB，无法一次导入');
    const lines=readFileSync(transcript.file,'utf8').split('\n').filter(line=>line.trim()),records=[];
    for(const [index,line] of lines.entries()){
      try{records.push(JSON.parse(line));}
      catch{if(index===lines.length-1)break;throw new Error('Antigravity 对话记录格式无法识别，未导入');}
    }
    if(!records.some(r=>r?.type==='USER_INPUT'))throw new Error('Antigravity 对话记录格式无法识别，未导入');
    const source=this.summary(row);
    const messages=convertAntigravityTranscript(records,{fallback:source.created,running:!!row.status&&!/IDLE/.test(row.status)});
    if(transcript.truncated&&messages[0])(messages[0].details.notices??=[]).push('本机只有 Antigravity 的精简记录，部分较长的内容在原记录里已被截短。');
    return finishRead(source,messages,preview);
  }
}

export function finishRead(source,messages,preview){
  if(!preview&&messages.some(m=>m.content.length>2000000))throw new Error('单条消息过长，无法完整导入');
  if(messages.reduce((n,m)=>n+Buffer.byteLength(m.content)+Buffer.byteLength(JSON.stringify(m.details)),0)>64*1024*1024)throw new Error('对话内容超过 64 MB，无法一次导入');
  return {...source,messages:preview?messages.slice(0,12).map(m=>({...m,content:m.content.slice(0,6000)})):messages,
    ...(preview?{partial:messages.length>12||messages.some(m=>m.content.length>6000)}:{})};
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { parseDeepseekEvent } from './adapters/deepseek.mjs';
import { mergeActivity, settleActivity } from './activity.mjs';
import { capInput, capText, finishRead, historyDate } from './antigravity-history.mjs';
import { redact } from './process.mjs';

const VERSIONS=new Set([0,1,2,3,4]);
const FILE=/^session(\.v\d+)?\.jsonl(\.zstd)?$/;
const ID=/^[A-Za-z0-9_-]{1,120}$/;
const MEDIA_NOTICE='原对话的图片、音频和文件未复制；保留文字与附件引用。';
const TEXT_LIMIT=512*1024*1024;

// dsh appends one zstd frame per write. zlib's one-shot call stops after the first frame,
// so the file is walked frame by frame using the sizes in each frame's block headers.
export function zstdFrames(buffer){
  const frames=[];let i=0;
  const need=n=>{if(i+n>buffer.length)throw new Error('truncated');};
  while(i<buffer.length){
    need(4);const magic=buffer.readUInt32LE(i);
    if((magic&0xFFFFFFF0)===0x184D2A50){need(8);i+=8+buffer.readUInt32LE(i+4);continue;}
    if(magic!==0xFD2FB528)throw new Error('magic');
    const start=i;i+=4;need(1);
    const descriptor=buffer[i++],single=(descriptor>>5)&1;
    i+=(single?0:1)+[0,1,2,4][descriptor&3]+[single?1:0,2,4,8][descriptor>>6];
    for(let last=0;!last;){
      need(3);const header=buffer[i]|(buffer[i+1]<<8)|(buffer[i+2]<<16);i+=3;
      last=header&1;const type=(header>>1)&3;if(type===3)throw new Error('block');
      i+=type===1?1:header>>>3;
    }
    if((descriptor>>2)&1)i+=4;
    if(i>buffer.length)throw new Error('truncated');
    frames.push(buffer.subarray(start,i));
  }
  return frames;
}

export function readDeepseekEvents(file,{headOnly=false}={}){
  const buffer=readFileSync(file);
  if(!file.endsWith('.zstd'))return parseLines(buffer.toString('utf8'),headOnly);
  let frames;
  try{frames=zstdFrames(buffer);}catch{throw new Error('DeepSeek 会话文件格式无法识别，未读取');}
  let text='';
  for(const frame of headOnly?frames.slice(0,1):frames){
    text+=zstdDecompressSync(frame).toString('utf8');
    if(text.length>TEXT_LIMIT)throw new Error('DeepSeek 原记录过大，无法一次导入');
  }
  return parseLines(text,headOnly);
}
function parseLines(text,headOnly){
  const lines=text.split('\n').filter(line=>line.trim()),events=[];
  for(const [index,line] of (headOnly?lines.slice(0,1):lines).entries()){
    try{events.push(JSON.parse(line));}
    catch{if(index===lines.length-1)break;throw new Error('DeepSeek 会话记录格式无法识别，未导入');}
  }
  const head=events[0];
  if(head?.type!=='session'||typeof head.id!=='string')throw new Error('DeepSeek 会话记录格式无法识别，未导入');
  if(!VERSIONS.has(head.version))throw new Error('这份 DeepSeek 会话的格式版本还不支持导入');
  return events;
}

const textOf=(content,notices)=>(Array.isArray(content)?content:[]).map(block=>{
  if(block?.type==='text')return typeof block.text==='string'?block.text:'';
  if(['image','file','document','audio'].includes(block?.type)){notices.add(MEDIA_NOTICE);return `[${block.type}${typeof block.name==='string'?': '+block.name.slice(0,300):''}]`;}
  return '';
}).filter(Boolean).join('\n\n');

// Only what the user typed and what the model said become messages. dsh's system prompt, skill
// catalog and runtime snapshots arrive as user messages from other sources and stay behind,
// as does reasoning. Tool calls become a record on the reply they belong to.
export function convertDeepseekEvents(events,fallback=new Date().toISOString()){
  const messages=[],calls=new Map(),state={};let assistant=null,pending=[],open=false,turnStart=0;
  const closeReply=()=>{
    if(pending.length){messages.push({role:'assistant',content:'',status:'complete',created:messages.at(-1)?.created||fallback,details:{source:{provider:'deepseek',type:'activity'},activity:pending}});pending=[];}
    assistant=null;
  };
  // A turn that ended any other way than "completed", or never ended, marks its last reply.
  const endTurn=reason=>{
    closeReply();open=false;calls.clear();
    if(!reason)return;
    const kind=String(reason.kind||'interrupted'),status=/error|fail/i.test(kind)?'error':'interrupted';
    let reply=messages.findLast((m,i)=>i>=turnStart&&m.role==='assistant');
    if(!reply&&status!=='error')return;
    if(!reply)messages.push(reply={role:'assistant',content:'',status,created:messages.at(-1)?.created||fallback,details:{source:{provider:'deepseek',type:'turn/end'},activity:[]}});
    reply.status=status;
    const text=typeof reason.message==='string'&&reason.message.trim()?reason.message:kind;
    (reply.details.notices??=[]).push('DeepSeek 本轮未正常结束：'+capText(redact(text),500));
  };
  for(const event of events){
    const data=event?.data||{},created=historyDate(event?.time,fallback);
    if(event?.type==='turn/start'){if(open)endTurn({kind:'interrupted'});open=true;turnStart=messages.length;continue;}
    if(event?.type==='turn/end'){const reason=data.reason;endTurn(reason?.kind==='completed'||reason==='completed'?null:reason&&typeof reason==='object'?reason:{kind:String(reason||'interrupted')});continue;}
    if(event?.type==='user/message'){
      if(data.source?.kind&&data.source.kind!=='user')continue;
      closeReply();
      const notices=new Set(),content=textOf(data.content,notices);
      if(content.trim())messages.push({role:'user',content,status:'complete',created,details:{source:{provider:'deepseek',itemId:data.id,type:'user/message'},...(notices.size?{notices:[...notices]}:{})}});
      continue;
    }
    if(event?.type==='assistant/message'){
      const content=(data.message?.content||[]).filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('').trim();
      if(content){
        assistant={role:'assistant',content,status:data.interrupted?'interrupted':'complete',created,details:{source:{provider:'deepseek',itemId:data.message?.id,type:'assistant/message'},activity:pending}};
        messages.push(assistant);pending=[];
      }
      continue;
    }
    if(event?.type==='tool/call'||event?.type==='tool/result'){
      for(const item of parseDeepseekEvent(event,state)){
        if(item.type!=='tool'||!item.id)continue;
        // A result joins the record its call went into, even if a reply came in between.
        const target=calls.get(item.id)||(assistant?assistant.details.activity:pending);
        if(event.type==='tool/call')calls.set(item.id,target);
        mergeActivity(target,{...item,input:capInput(item.input),output:capText(item.output),meta:item.meta&&JSON.stringify(item.meta).length>20000?undefined:item.meta});
      }
    }
  }
  if(open)endTurn({kind:'interrupted'});else closeReply();
  for(const message of messages)if(message.details.activity)settleActivity(message.details,message.status);
  return messages;
}

// Sessions live in ~/.dsh/sessions/<encoded folder>/<session id>/. Starport names its own
// sessions hub-<uuid> and starts a new one for every turn, so those are fragments of Starport
// chats, not conversations; subagent sessions belong to their parent. Neither is offered.
export class DeepseekHistory {
  constructor(home=process.env.DSH_HOME||join(homedir(),'.dsh')){this.root=join(home,'sessions');this.cache=new Map();}
  sessions(){
    if(!existsSync(this.root))return [];
    const found=[];
    for(const folder of readdirSync(this.root,{withFileTypes:true}))if(folder.isDirectory()){
      for(const entry of readdirSync(join(this.root,folder.name),{withFileTypes:true})){
        if(!entry.isDirectory()||!ID.test(entry.name)||entry.name.startsWith('hub-'))continue;
        const dir=join(this.root,folder.name,entry.name);
        const name=readdirSync(dir).filter(f=>FILE.test(f)).sort((a,b)=>version(b)-version(a))[0];
        if(name)found.push({id:entry.name,file:join(dir,name)});
      }
    }
    return found;
  }
  summary(session){
    const stat=statSync(session.file),key=stat.size+':'+stat.mtimeMs,cached=this.cache.get(session.file);
    if(cached?.key===key)return cached.summary;
    let summary=null;
    try{
      const head=readDeepseekEvents(session.file,{headOnly:true})[0];
      if(head.id===session.id&&!head.parentSession&&head.origin!=='subagent'){
        const events=readDeepseekEvents(session.file);let title='',first='',updated=null;
        for(const event of events){
          if(event.type==='session/title'&&typeof event.data?.title==='string')title=event.data.title;
          if(!first&&event.type==='user/message'&&(!event.data?.source?.kind||event.data.source.kind==='user'))first=textOf(event.data.content,new Set());
          if(typeof event.time==='number')updated=event.time;
        }
        const created=historyDate(head.createdAt,historyDate(stat.mtimeMs,new Date().toISOString()));
        if(first.trim())summary={id:head.id,title:(title.trim()||first.trim().split('\n')[0]||'DeepSeek 对话').slice(0,300),workspace:typeof head.cwd==='string'?head.cwd:'',
          created,updated:historyDate(updated,created)};
      }
    }catch{summary=null;}
    this.cache.set(session.file,{key,summary});
    return summary;
  }
  async list({cursor=null,search='',archived=false,exclude=new Set()}={}){
    if(archived)throw new Error('DeepSeek 本地历史不区分归档，请选择全部对话');
    if(cursor!==null&&!/^(0|[1-9]\d{0,6})$/.test(cursor))throw new Error('搜索条件无效');
    const offset=Number(cursor||0),term=search.trim().toLocaleLowerCase();
    const rows=this.sessions().filter(s=>!exclude.has(s.id)).map(s=>this.summary(s)).filter(Boolean)
      .filter(s=>!term||s.title.toLocaleLowerCase().includes(term)||s.workspace.toLocaleLowerCase().includes(term))
      .sort((a,b)=>b.updated.localeCompare(a.updated)||a.id.localeCompare(b.id));
    return {data:rows.slice(offset,offset+30),nextCursor:offset+30<rows.length?String(offset+30):null};
  }
  async read(id,{preview=false}={}){
    if(!ID.test(id))throw new Error('对话标识无效');
    if(id.startsWith('hub-'))throw new Error('这是星港自己发起的 DeepSeek 会话片段，对话本身在星港里');
    const session=this.sessions().find(s=>s.id===id);
    if(!session)throw new Error('本机未找到这段 DeepSeek 对话，请刷新列表');
    if(statSync(session.file).size>128*1024*1024)throw new Error('DeepSeek 原记录超过 128 MB，无法一次导入');
    const events=readDeepseekEvents(session.file),head=events[0];
    if(head.id!==id)throw new Error('DeepSeek 会话文件与所在目录不一致');
    if(head.parentSession||head.origin==='subagent')throw new Error('这是 DeepSeek 的子任务会话，请导入它所属的主对话');
    const source=this.summary(session);
    if(!source)throw new Error('这段对话没有可导入的用户或助手消息');
    return finishRead(source,convertDeepseekEvents(events,source.created),preview);
  }
}
const version=name=>Number(/\.v(\d+)\./.exec(name)?.[1]||0);

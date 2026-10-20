import { listSessions, getSessionInfo, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { parseClaudeEvent } from './adapters/claude-events.mjs';
import { mergeActivity, settleActivity } from './activity.mjs';

const localHistory={listSessions,getSessionInfo,getSessionMessages};
const date=(value,fallback)=>{const time=typeof value==='number'?value:Date.parse(value);return Number.isFinite(time)&&time>0?new Date(time).toISOString():fallback;};
export function claudeHistorySummary(session){
  const updated=date(session.lastModified,new Date().toISOString());
  return {id:session.sessionId,title:(session.customTitle?.trim()||session.summary?.trim()||session.firstPrompt?.trim()||'Claude Code 对话').slice(0,300),
    workspace:session.cwd||'',created:date(session.createdAt,updated),updated};
}

export function convertClaudeMessages(records,fallback){
  const messages=[],state={};let lastAssistant=null;
  for(const record of records){
    if(!['user','assistant'].includes(record.type)||record.parent_tool_use_id||record.parent_agent_id||record.isSidechain||record.isMeta)continue;
    const raw=record.message?.content;let referenced=false;
    const content=typeof raw==='string'?raw:Array.isArray(raw)?raw.map(block=>{
      if(block.type==='text')return typeof block.text==='string'?block.text:'';
      if(['image','document','audio'].includes(block.type)){referenced=true;return `[${block.type}${block.title?': '+String(block.title).slice(0,300):''}]`;}
      return '';
    }).filter(Boolean).join('\n\n'):'';
    const activity=[];
    for(const event of parseClaudeEvent(record,state))if(['tool','activity'].includes(event.type))mergeActivity(record.type==='user'?lastAssistant?.details.activity||activity:activity,event);
    if(!content.trim()&&(!activity.length||record.type==='user'))continue;
    const message={role:record.type,content,status:record.isApiErrorMessage?'error':'complete',created:date(record.timestamp,fallback),
      details:{source:{provider:'claude',itemId:record.uuid,type:record.type},...(record.type==='assistant'?{activity}:{}),...(referenced?{notices:['原对话的图片、音频和文件未复制；保留文字与附件引用。']}:{})}};
    messages.push(message);lastAssistant=record.type==='assistant'?message:null;
  }
  for(const message of messages)settleActivity(message.details,message.status);
  return messages;
}

// Official SDK reads the local transcript chain without launching Claude or contacting an account.
// Only text and media references cross into Starport; original sessions and permissions stay separate.
export class ClaudeHistory {
  constructor(reader=localHistory){this.reader=reader;}
  async list({cursor=null,search='',archived=false}={}){
    if(archived)throw new Error('Claude Code 本地历史不区分归档，请选择全部对话');
    if(cursor!==null&&!/^(0|[1-9]\d{0,6})$/.test(cursor))throw new Error('搜索条件无效');
    const offset=Number(cursor||0),term=search.trim().toLocaleLowerCase();
    const sessions=(await this.reader.listSessions()).map(claudeHistorySummary)
      .filter(s=>!term||s.title.toLocaleLowerCase().includes(term)||s.workspace.toLocaleLowerCase().includes(term))
      .sort((a,b)=>b.updated.localeCompare(a.updated)||a.id.localeCompare(b.id));
    return {data:sessions.slice(offset,offset+30),nextCursor:offset+30<sessions.length?String(offset+30):null};
  }
  async read(id,{preview=false}={}){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('对话标识无效');
    const session=await this.reader.getSessionInfo(id);
    if(!session)throw new Error('本机未找到这段 Claude Code 对话，请刷新列表');
    if(session.sessionId!==id)throw new Error('Claude Code 返回了不匹配的对话');
    if(session.fileSize>128*1024*1024)throw new Error('Claude Code 原记录超过 128 MB，无法一次导入');
    const source=claudeHistorySummary(session);
    const records=await this.reader.getSessionMessages(id);
    const messages=convertClaudeMessages(records,source.created);
    if(!preview&&messages.some(m=>m.content.length>2000000))throw new Error('单条消息过长，无法完整导入');
    if(messages.reduce((n,m)=>n+Buffer.byteLength(m.content),0)>64*1024*1024)throw new Error('对话文字超过 64 MB，无法一次导入');
    return {...source,messages:preview?messages.slice(0,12).map(m=>({...m,content:m.content.slice(0,6000)})):messages,
      ...(preview?{partial:messages.length>12||messages.some(m=>m.content.length>6000)}:{})};
  }
}

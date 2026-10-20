import { connectCodex } from './adapters/codex.mjs';
import { ClaudeHistory } from './claude-history.mjs';
import { AntigravityHistory } from './antigravity-history.mjs';
import { DeepseekHistory } from './deepseek-history.mjs';
import { parseCodexActivity } from './adapters/codex-events.mjs';
import { mergeActivity, settleActivity } from './activity.mjs';

const iso=(value,fallback)=>Number.isFinite(value)&&value>0?new Date(value*1000).toISOString():fallback;
export function historySummary(thread) {
  const created=iso(thread.createdAt,new Date().toISOString());
  return {id:thread.id,title:(thread.name?.trim()||thread.preview?.trim()||'Codex 对话').slice(0,300),
    workspace:thread.cwd||'',created,updated:iso(thread.updatedAt,created)};
}

// Historical input remains message data. Never execute tools, load mentioned files,
// inherit approvals, or attach the original native session to the copied chat.
export function convertTurns(turns, fallback) {
  const messages=[];
  for(const turn of turns){let lastAssistant=null,pending=[];const activityState={};for(const item of turn.items||[]){
    let content='',role,notices=[];
    if(item.type==='userMessage'){
      role='user';content=(item.content||[]).map(part=>{
        if(part.type==='text')return part.text||'';
        if(['mention','skill'].includes(part.type))return [part.name,part.path].filter(Boolean).join(' · ');
        notices.push('原对话的图片、音频和文件未复制；保留文字与附件引用。');
        return `[${part.type}${part.path?': '+part.path:''}]`;
      }).join('\n\n');
    }else if(['agentMessage','plan'].includes(item.type)){role='assistant';content=item.text||'';}
    else {
      if(!['reasoning','commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabToolCall','webSearch','contextCompaction','subAgentActivity','enteredReviewMode','exitedReviewMode'].includes(item.type))continue;
      const target=lastAssistant?.details.activity||pending;
      for(const event of parseCodexActivity('item/completed',{item},activityState))mergeActivity(target,event);
      continue;
    }
    if(!content.trim())continue;
    const status=role==='user'||turn.status==='completed'?'complete':turn.status==='failed'?'error':'interrupted';
    const message={role,content,status,created:iso(role==='user'?turn.startedAt:turn.completedAt,iso(turn.startedAt,fallback)),
      details:{source:{provider:'codex',turnId:turn.id,itemId:item.id,type:item.type},
        ...(notices.length?{notices:[...new Set(notices)]}:{})}};
    if(role==='assistant'){
      message.details.activity=pending;pending=[];lastAssistant=message;
      for(const event of parseCodexActivity('item/completed',{item},activityState))mergeActivity(message.details.activity,event);
    }else lastAssistant=null;
    messages.push(message);
  }
    if(pending.length)messages.push({role:'assistant',content:'',status:turn.status==='completed'?'complete':'interrupted',created:iso(turn.completedAt,fallback),details:{source:{provider:'codex',turnId:turn.id},activity:pending}});
    for(const message of messages.filter(row=>row.details.source?.turnId===turn.id))settleActivity(message.details,message.status);
  }
  return messages;
}

export class HistoryImporter {
  // Codex history is read through its app server; the other tools' files are read directly.
  constructor(store,registry,root,connect=connectCodex,claudeHistory=new ClaudeHistory(),{antigravity=new AntigravityHistory(),deepseek=new DeepseekHistory()}={}){this.store=store;this.registry=registry;this.root=root;this.connect=connect;this.claudeHistory=claudeHistory;this.local={claude:claudeHistory,antigravity,deepseek};this.connections=new Set();this.closing=false;}
  validateProvider(provider){if(!['codex','claude','antigravity','deepseek'].includes(provider))throw new Error('目前支持从 Codex、Claude Code、Antigravity 和 DeepSeek 导入对话');if(this.closing)throw new Error('工具连接已关闭');}
  validateId(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new Error('对话标识无效');}
  async use(provider,work){
    this.validateProvider(provider);if(this.closing)throw new Error('工具连接已关闭');
    const runtime=this.registry.resolve(provider);if(!runtime)throw new Error('未找到 Codex，请在连接与数据中检查工具');
    const rpc=await this.connect(runtime,this.root);
    if(this.closing){await rpc.close();throw new Error('工具连接已关闭');}
    this.connections.add(rpc);
    try{return await work(rpc);}finally{this.connections.delete(rpc);await rpc.close();}
  }
  async list(provider,{cursor=null,search='',archived=false}={}){
    this.validateProvider(provider);
    if(typeof search!=='string'||search.length>300||cursor!==null&&(typeof cursor!=='string'||cursor.length>4000)||typeof archived!=='boolean')throw new Error('搜索条件无效');
    if(this.local[provider]){
      // Antigravity and DeepSeek sessions that Starport ran for a chat it still has are not offered again.
      const exclude=provider==='claude'?undefined:this.store.nativeSessionIds(provider);
      const result=await this.local[provider].list({cursor,search,archived,exclude});
      return {...result,data:result.data.map(row=>({...row,importedChatId:this.store.historyImport(provider,row.id)?.chat_id||null}))};
    }
    return this.use(provider,async rpc=>{
      const result=await rpc.request('thread/list',{limit:30,cursor,searchTerm:search.trim()||null,archived,modelProviders:[],sortKey:'updated_at',useStateDbOnly:true});
      return {data:result.data.map(thread=>({...historySummary(thread),importedChatId:this.store.historyImport(provider,thread.id)?.chat_id||null})),nextCursor:result.nextCursor||null};
    });
  }
  async read(provider,id,{preview=false}={}){
    this.validateProvider(provider);this.validateId(id);
    if(this.local[provider])return this.local[provider].read(id,{preview});
    return this.use(provider,async rpc=>{
      const {thread}=await rpc.request('thread/read',{threadId:id,includeTurns:false});
      if(thread.id!==id)throw new Error('Codex 返回了不匹配的对话');
      const source={...historySummary(thread),messages:[]};
      let cursor=null,bytes=0;const seen=new Set(),turnIds=new Set();
      for(let page=0;page<1000;page++){
        const result=await rpc.request('thread/turns/list',{threadId:id,limit:preview?3:20,sortDirection:'asc',itemsView:'full',cursor});
        for(const turn of result.data){
          if(turnIds.has(turn.id))throw new Error('Codex 历史分页重复，请稍后重试');
          turnIds.add(turn.id);
          if(turn.itemsView&&turn.itemsView!=='full')throw new Error('Codex 未返回完整消息，请升级 Codex 后重试');
        }
        const messages=convertTurns(result.data,source.created);
        if(!preview&&messages.some(m=>m.content.length>2000000))throw new Error('单条消息过长，无法完整导入');
        bytes+=messages.reduce((n,m)=>n+Buffer.byteLength(m.content),0);
        if(bytes>64*1024*1024)throw new Error('对话文字超过 64 MB，无法一次导入');
        source.messages.push(...messages);
        if(preview){const shown=source.messages.slice(0,12).map(m=>({...m,content:m.content.slice(0,6000)}));return {...source,messages:shown,partial:!!result.nextCursor||source.messages.length>12||source.messages.some(m=>m.content.length>6000)};}
        cursor=result.nextCursor;
        if(!cursor)return source;
        if(seen.has(cursor))throw new Error('Codex 历史分页重复，请稍后重试');
        seen.add(cursor);
      }
      throw new Error('对话轮次过多，无法一次导入');
    });
  }
  async import(provider,{id,group_id=null}={}){
    this.validateProvider(provider);this.validateId(id);
    if(group_id!==null&&(typeof group_id!=='string'||!this.store.db.prepare('SELECT id FROM groups WHERE id=?').get(group_id)))throw new Error('目标分组不存在，请重新选择');
    const existing=this.store.historyImport(provider,id);
    if(existing)return {status:'skipped',chatId:existing.chat_id};
    const source=await this.read(provider,id);
    return this.store.importHistory(provider,source,group_id);
  }
  async close(){this.closing=true;await Promise.allSettled([...this.connections].map(rpc=>rpc.close()));}
}

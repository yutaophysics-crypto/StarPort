import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { redact } from './process.mjs';

const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id);
const time=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const clean=(value,max=16000)=>typeof value==='string'?redact(value).slice(0,max):'';
const decode=value=>{try{return JSON.parse(value);}catch{return value;}};
const terminal=new Set(['complete','error','interrupted']);
export function nativeSubagentStatus(value){
  const state=String(value||'').replace(/^SUBAGENT_STATE_/,'').toLowerCase();
  if(['alive','running','working','pending'].includes(state))return 'running';
  if(['done','complete','completed','success','finished'].includes(state))return 'complete';
  if(['error','failed'].includes(state))return 'error';
  if(['canceled','cancelled','terminated','interrupted','stopped','killed'].includes(state))return 'interrupted';
  // DEAD / unspecified do not prove successful completion.
  return 'unknown';
}
export function mergeSubagent(rows,event,now=Date.now()){
  if(typeof event.id!=='string'||!event.id)return false;
  let row=rows.find(item=>item.id===event.id);
  const update=JSON.parse(redact(JSON.stringify(event)));delete update.type;
  for(const key of Object.keys(update))if(update[key]===undefined)delete update[key];
  if(!row){row={id:update.id,startedAt:update.startedAt??now,status:'running'};rows.push(row);}
  if(row&&update.updatedAt!=null&&update.updatedAt<row.updatedAt)return false;
  // Duplicate start events must not restart the clock or revive a finished child.
  if(terminal.has(row.status)&&update.status==='running'){
    if((update.updatedAt??0)<=(row.endedAt??row.updatedAt))delete update.status;
    else delete row.endedAt;
  }
  const before=JSON.stringify(row);
  const start=row.startedAt;Object.assign(row,update);row.startedAt=Math.min(start,update.startedAt??start);
  row.updatedAt=update.updatedAt??row.updatedAt??now;
  if(terminal.has(row.status))row.endedAt=row.endedAt??row.updatedAt;
  return before!==JSON.stringify(row);
}
export function settleSubagents(rows,status,now=Date.now()){
  for(const row of rows)if(!terminal.has(row.status)){
    row.status=status==='interrupted'?'interrupted':'unknown';
    row.endedAt=row.endedAt??now;
  }
}

// Read only the beginning (assignment) and end (recent operations). Never retain or expose
// hidden reasoning or unrelated conversations. Native summary rows supply the
// execution state: ALIVE alone only means the agent has not been killed.
export class AntigravitySubagents {
  constructor(brain=join(homedir(),'.gemini','antigravity-cli','brain')){this.brain=brain;this.summaryFile=join(brain,'..','conversation_summaries.db');this.cache=new Map();}
  async transcript(id){
    const file=join(this.brain,id,'.system_generated','logs','transcript.jsonl');
    let info;try{info=await stat(file);}catch{return [];}
    const cached=this.cache.get(id),signature=`${info.size}:${info.mtimeMs}`;
    if(cached?.signature===signature)return cached.rows;
    const handle=await open(file,'r'),limit=512*1024;
    const read=async(start,length)=>{const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,start);return buffer.subarray(0,bytesRead).toString('utf8');};
    let text;
    try{
      const head=await read(0,Math.min(info.size,limit));
      if(info.size<=limit)text=head;
      else {
        const start=Math.max(limit,info.size-limit),tail=await read(start,info.size-start);
        text=head.slice(0,head.lastIndexOf('\n')+1)+tail.slice(tail.indexOf('\n')+1);
      }
    }finally{await handle.close();}
    const rows=[];
    // Ignore the incomplete last line; it will be read again when the file grows.
    for(const line of text.slice(0,text.lastIndexOf('\n')+1).split('\n'))try{
      const raw=JSON.parse(line);
      rows.push({index:raw.step_index,at:time(raw.created_at),type:raw.type,status:raw.status,
        assignment:raw.step_index===0?clean(raw.content,32000):'',
        calls:(raw.tool_calls||[]).map(call=>({name:clean(call.name,200),args:call.args||{}}))});
    }catch{}
    this.cache.set(id,{signature,rows});
    if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);
    return rows;
  }
  async snapshot(session,{since=0,until=Infinity}={}){
    if(!validId(session))return [];
    const result=[],visited=new Set([session]);
    let database;
    try{database=new DatabaseSync(this.summaryFile,{readOnly:true});}catch{}
    const summaries=parent=>{
      try{return new Map(database.prepare('SELECT conversation_id,status,not_fully_idle,killed,step_count,last_modified_time FROM conversation_summaries WHERE parent_conversation_id=?').all(parent).map(row=>[row.conversation_id,row]));}catch{return new Map();}
    };
    const visit=async(parent,depth)=>{
      if(depth>6||visited.size>128)return;
      const directory=join(this.brain,parent,'.system_generated','subagents');
      let files;try{files=await readdir(directory);}catch{return;}
      const native=summaries(parent);
      for(const name of files){
        if(!name.endsWith('.json')||!validId(name.slice(0,-5)))continue;
        let meta;try{meta=JSON.parse(await readFile(join(directory,name),'utf8'));}catch{continue;}
        const id=meta.conversationId;
        if(!validId(id)||id!==name.slice(0,-5)||visited.has(id))continue;
        visited.add(id);
        const rows=await this.transcript(id),first=rows.find(row=>row.at!=null),last=rows.at(-1);
        const startedAt=first?.at;
        // Persisted metadata includes children from earlier turns. Only attach
        // those spawned in this turn, or still working during this turn.
        let status=nativeSubagentStatus(meta.state);
        const summary=native.get(id),summaryAt=time(summary?.last_modified_time);
        const currentSummary=summary&&summaryAt!=null&&summary.step_count>=(last?.index??0)+1&&summaryAt<=until;
        if(currentSummary){
          if(summary.killed||status==='interrupted')status='interrupted';
          else if(summary.status==='CASCADE_RUN_STATUS_IDLE'&&!summary.not_fully_idle)status=last?.status==='ERROR'?'error':'complete';
          else if(summary.status==='CASCADE_RUN_STATUS_RUNNING'||summary.not_fully_idle)status='running';
        }
        if(startedAt==null||startedAt>until||startedAt<since-2000&&!(status==='running'&&last?.at>=since&&last.at<=until))continue;
        const visible=rows.filter(row=>row.at<=until),latest=visible.at(-1);
        const call=[...visible].reverse().find(row=>row.calls.length)?.calls.at(-1);
        const initial=first.assignment;
        const assignment=initial.match(/\[Message\][\s\S]*? content=([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/)?.[1]||'';
        const activity=call?clean(decode(call.args.toolAction)||decode(call.args.toolSummary)||call.name,500):'';
        const updatedAt=Math.max(latest?.at??startedAt,currentSummary?summaryAt??0:0);
        if(last?.at>until)status='unknown';
        const row={id,parentId:parent,depth,name:clean(meta.subagentDescriptor?.role,300)||'Subagent',
          agentType:clean(meta.subagentDescriptor?.typeName,100),task:clean(assignment),status,startedAt,updatedAt,
          activity,tool:call?.name||'',step:latest?.index??null,source:'antigravity-transcript'};
        if(terminal.has(status))row.endedAt=updatedAt;
        result.push(row);
        await visit(id,depth+1);
      }
    };
    try{await visit(session,0);}finally{database?.close();}
    return result.sort((a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id));
  }
}

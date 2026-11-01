import { existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { capText, toolResult } from '../antigravity-history.mjs';

// agy's stream-json leaves out what its own transcript keeps: the thought summary of each response
// step, and whole tool results where the stream only says "12 lines, 480 bytes". While a turn runs,
// the records agy appends are read and matched to the stream's steps by step index (agy:<index>).
const SESSION=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILES=['transcript_full.jsonl','transcript.jsonl'];
// A read result can be a whole source file; the file itself stays one click away.
const OUTPUT_LIMIT=8000;
const SUMMARY=/^\d+ lines?, \d+ bytes?$/;
const CHUNK=4*1024*1024;

export const antigravityHome=()=>join(homedir(),'.gemini','antigravity-cli');

export class AntigravityTranscript {
  // resumed: the conversation this turn continues; its transcript so far belongs to earlier turns.
  constructor({home=antigravityHome(),resumed=null}={}){
    this.home=home;this.session=null;this.file=null;this.offset=0;this.partial='';this.decoder=new StringDecoder('utf8');
    this.resumed=SESSION.test(resumed||'')?{id:resumed,sizes:this.sizes(resumed)}:null;
  }
  logs(id){return join(this.home,'brain',id,'.system_generated','logs');}
  sizes(id){
    const sizes={};
    for(const name of FILES)try{sizes[name]=statSync(join(this.logs(id),name)).size;}catch{}
    return sizes;
  }
  attach(id){
    if(this.file||this.session===id||!SESSION.test(id||''))return;
    this.session=id;
  }
  // What agy appended since the last call, reduced to what the stream lacks:
  // {step,thinking} for a response step, {step,output} for a tool result.
  async entries(){
    if(!this.session)return [];
    if(!this.file){
      const name=FILES.find(name=>existsSync(join(this.logs(this.session),name)));
      if(!name)return [];
      this.file=join(this.logs(this.session),name);
      this.offset=this.resumed?.id===this.session?this.resumed.sizes[name]||0:0;
    }
    const entries=[];let handle;
    try{handle=await open(this.file,'r');}catch{return entries;}
    try{
      const {size}=await handle.stat();
      while(this.offset<size){
        const buffer=Buffer.alloc(Math.min(size-this.offset,CHUNK));
        const {bytesRead}=await handle.read(buffer,0,buffer.length,this.offset);
        if(!bytesRead)break;
        this.offset+=bytesRead;
        const text=this.partial+this.decoder.write(buffer.subarray(0,bytesRead)),end=text.lastIndexOf('\n');
        // The last line may still be half written; it is completed by the next read.
        this.partial=text.slice(end+1);
        for(const line of text.slice(0,Math.max(end,0)).split('\n')){
          let record;try{record=JSON.parse(line);}catch{continue;}
          const entry=transcriptEntry(record);if(entry)entries.push(entry);
        }
      }
    }finally{await handle.close();}
    return entries;
  }
}

export function transcriptEntry(record){
  const step=record?.step_index;
  if(!Number.isInteger(step))return null;
  if(record.type==='PLANNER_RESPONSE'&&typeof record.thinking==='string'&&record.thinking.trim())return {step,thinking:capText(record.thinking.trim())};
  if(record.type==='GENERIC'){const {output}=toolResult(record,OUTPUT_LIMIT);return output?{step,output}:null;}
  return null;
}

// An entry waits for the stream's own record of its step: a thought goes in front of the response
// step it belongs to, a result onto a tool step the stream has finished (or any of this turn's tool
// steps once agy has exited). A step the stream never named is not this turn's.
export function transcriptReady(entry,seen,tools,final=false){
  const id='agy:'+entry.step;
  return entry.thinking?seen.has(id):tools.has(id)&&(final||!!tools.get(id).done);
}

// tools: what the stream has said about each tool step, {output,done}. A whole result replaces only
// a missing one or the stream's line-and-byte count, and only once the stream has finished that
// step, so a later stream update cannot put the count back.
export function transcriptEvents(entry,tools){
  const id='agy:'+entry.step;
  if(entry.thinking)return [{type:'activity',before:id,item:{id:id+':thinking',kind:'thinking',nativeType:'thinking',status:'complete',text:entry.thinking}}];
  const tool=tools.get(id);
  if(!tool||(tool.output!=null&&!SUMMARY.test(String(tool.output).trim())))return [];
  tool.output=entry.output;
  return [{type:'tool',id,output:entry.output}];
}

// Exams: a paper folder is copied into a fresh seat folder for each examinee, who answers blind on a
// desk of its own. Afterwards each seat is checked against the paper's hashes, and its tool calls are
// searched for places outside the seat. Nothing here stops a tool from reading elsewhere; the seats
// simply never learn where the conversation keeps its files, and any attempt shows up in the check.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fail, clip } from './common.mjs';

export const KNOWLEDGE='知识库';
export const EXAM_MINUTES=[0,30,60,120,240,480],DEFAULT_EXAM_MINUTES=120;
export const EXAM_LIMITS={files:10000,bytes:2*1024**3,seats:8,sources:20};
// Version history and Starport's own archive never go into a seat.
const SKIP=new Set(['.git','.starport']);

export const safeName=value=>String(value||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').replace(/\s+/g,' ').replace(/[. ]+$/,'').trim().slice(0,40)||'考生';
// "考位" keeps a seat's folder name from matching ordinary words when tool output is searched.
export const seatFolder=(index,name)=>`考位${index+1}-${safeName(name)}`;
export const sizeText=bytes=>bytes<1024?bytes+' B':bytes<1024**2?(bytes/1024).toFixed(1)+' KB':bytes<1024**3?(bytes/1024**2).toFixed(1)+' MB':(bytes/1024**3).toFixed(2)+' GB';
const caseless=process.platform==='win32';
const key=path=>{const value=resolve(path).replace(/\\/g,'/').replace(/\/+$/,'');return caseless?value.toLowerCase():value;};

export function examMinutes(value){
  if(value===undefined||value===null)return DEFAULT_EXAM_MINUTES;
  if(!Number.isInteger(value)||value<0||value>1440)throw fail('考试时限应为 0–1440 分钟（0 为不限）');
  return value;
}

// Every file under a folder, without following links. Past `cap` names are no longer kept, only
// counted; past `stop` files or bytes the walk gives up, so a huge folder is refused quickly.
async function walk(path,{exclude=[],cap=Infinity,stop={files:Infinity,bytes:Infinity}}={}){
  const files=[],skip=new Set(exclude.map(key)),stack=[''];let bytes=0,count=0;
  while(stack.length){
    const dir=stack.pop(),abs=dir?join(path,dir):path;
    let entries;
    try{entries=await readdir(abs,{withFileTypes:true});}catch{throw fail(`没有权限读取 ${abs}`);}
    for(const entry of entries){
      const rel=dir?join(dir,entry.name):entry.name;
      if(entry.isDirectory()){if(!SKIP.has(entry.name)&&!skip.has(key(join(path,rel))))stack.push(rel);continue;}
      if(!entry.isFile())continue;
      const size=(await lstat(join(path,rel))).size;
      count++;bytes+=size;
      if(count<=cap)files.push({rel:rel.split(sep).join('/'),size});
      if(count>stop.files||bytes>stop.bytes)return {files,bytes,count,stopped:true};
    }
  }
  files.sort((a,b)=>a.rel.localeCompare(b.rel));
  return {files,bytes,count,stopped:false};
}

// A paper or knowledge source: a folder, or for knowledge also a single file.
export async function examSource(path,{label,folderOnly=false,exclude=[]}){
  const info=await lstat(path).catch(()=>null);
  if(!info)throw fail(`${label}不存在：${path}`);
  if(info.isSymbolicLink())throw fail(`${label}是一个链接，请给出它指向的实际位置：${path}`);
  if(info.isFile()&&!folderOnly)return {path,kind:'file',files:[{rel:basename(path),size:info.size}],bytes:info.size};
  if(!info.isDirectory())throw fail(`${label}应是一个文件夹：${path}`);
  const listed=await walk(path,{exclude,stop:EXAM_LIMITS});
  if(listed.count>EXAM_LIMITS.files)throw fail(`${label}超过 ${EXAM_LIMITS.files} 个文件，请只放考生需要的材料：${path}`);
  if(listed.bytes>EXAM_LIMITS.bytes)throw fail(`${label}超过 ${sizeText(EXAM_LIMITS.bytes)}，请只放考生需要的材料：${path}`);
  return {path,kind:'dir',files:listed.files,bytes:listed.bytes};
}
export const resolveSource=(value,workspace,label)=>{
  if(typeof value!=='string'||!value.trim()||value.length>2000||value.includes('\0'))throw fail(`请给出${label}的路径`);
  return isAbsolute(value.trim())?resolve(value.trim()):resolve(workspace,value.trim());
};
// Where each source lands inside a seat: the paper at the top, knowledge under 知识库/<name>.
export function placements(paper,knowledge){
  const rows=[];
  for(const file of paper.files)rows.push({from:paper.kind==='file'?paper.path:join(paper.path,file.rel),to:file.rel,size:file.size,source:'paper'});
  for(const item of knowledge)for(const file of item.files)
    rows.push({from:item.kind==='file'?item.path:join(item.path,file.rel),to:item.kind==='file'?`${KNOWLEDGE}/${item.name}`:`${KNOWLEDGE}/${item.name}/${file.rel}`,size:file.size,source:'knowledge'});
  return rows;
}

// A new folder for one exam under the exams folder, named by local time and the exam's name.
export async function freshFolder(root,name,time=new Date()){
  const pad=value=>String(value).padStart(2,'0');
  const base=`${time.getFullYear()}-${pad(time.getMonth()+1)}-${pad(time.getDate())} ${pad(time.getHours())}${pad(time.getMinutes())} ${safeName(name)}`;
  await mkdir(root,{recursive:true});
  for(let n=1;;n++){
    const path=join(root,n===1?base:`${base} (${n})`);
    try{await mkdir(path);return path;}catch(error){if(error.code!=='EEXIST')throw error;}
  }
}

const hashFile=path=>new Promise((done,reject)=>{
  const hash=createHash('sha256');
  createReadStream(path).on('error',reject).on('data',chunk=>hash.update(chunk)).on('end',()=>done(hash.digest('hex')));
});

// Hashes each source file once, then copies it into every seat that gets it. The hashes are the
// baseline every seat is checked against afterwards.
export async function prepareSeats(rows,seats){
  const manifest={};
  for(const row of rows)manifest[row.to]={size:row.size,hash:await hashFile(row.from),source:row.source};
  for(const seat of seats){
    await mkdir(seat.dir,{recursive:true});
    for(const row of rows){
      if(row.source==='knowledge'&&!seat.knowledge)continue;
      const target=join(seat.dir,...row.to.split('/'));
      await mkdir(dirname(target),{recursive:true});await copyFile(row.from,target);
    }
  }
  return manifest;
}

// Which paper (and knowledge) files a seat changed or removed, and how many files it added.
export async function auditSeat(dir,manifest,{knowledge=false}={}){
  const expected=Object.entries(manifest).filter(([,file])=>knowledge||file.source==='paper');
  const modified=[],deleted=[];
  for(const [rel,file] of expected){
    const path=join(dir,...rel.split('/')),info=await lstat(path).catch(()=>null);
    if(!info?.isFile()){deleted.push(rel);continue;}
    if(info.size!==file.size||await hashFile(path)!==file.hash)modified.push(rel);
  }
  const known=new Set(expected.map(([rel])=>caseless?rel.toLowerCase():rel)),listed=await walk(dir,{cap:20000});
  const added=listed.files.filter(file=>!known.has(caseless?file.rel.toLowerCase():file.rel)).map(file=>file.rel);
  const more=Math.max(0,listed.count-listed.files.length);
  return {modified:modified.slice(0,200),deleted:deleted.slice(0,200),changed:modified.length+deleted.length,added:added.length+more,addedSample:added.slice(0,30)};
}

// Tool calls that named a place the seat should not reach: the conversation's workspace, the paper
// and knowledge sources, Starport's data, the exam folder or another seat. Paths are compared as
// written by Windows tools and by Git Bash (/c/...).
export function strayCalls(details,{seat,forbidden,siblings}){
  const forms=path=>{const value=key(path);const drive=value.match(/^([a-z]):\/(.*)$/i);return drive?[value,`/${drive[1].toLowerCase()}/${drive[2]}`]:[value];};
  const norm=value=>{const text=String(value??'').replace(/\\+/g,'/');return caseless?text.toLowerCase():text;};
  const own=forms(seat),zones=forbidden.filter(Boolean).flatMap(forms),names=siblings.map(name=>caseless?name.toLowerCase():name);
  // Tool calls only: the examinee's own commentary may mention a path without touching it.
  const rows=new Map();
  for(const item of [...(details?.activity||[]).filter(row=>row?.kind==='tool'),...(details?.tools||[]).filter(row=>row&&row.kind!=='step')])
    rows.set(item.id||Symbol(),{...rows.get(item.id),...item});
  const hits=[];
  for(const item of rows.values()){
    const parts=[item.input,item.arguments,item.command,item.cwd,item.changes,item.output,item.result].filter(value=>value!=null).map(value=>typeof value==='string'?value:JSON.stringify(value));
    let text=norm(parts.join('\n'));
    // The seat's own path sits inside the exam folder; take it out before looking for the folder.
    for(const form of own)text=text.split(form).join('<seat>');
    const zone=zones.find(form=>text.includes(form)),sibling=names.find(name=>text.includes(name));
    if(!zone&&!sibling)continue;
    const where=text.indexOf(zone||sibling);
    hits.push({tool:String(item.name||item.nativeType||'工具').slice(0,60),text:clip(text.slice(Math.max(0,where-60),where+120).replace(/\s+/g,' '),200)});
  }
  return {count:hits.length,samples:hits.slice(0,8)};
}

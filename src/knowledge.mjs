// Knowledge folders: local folders the user hangs on a room, a conversation or a companion as
// read-only reference material. Nothing is copied. A turn is told where the folders are, with a
// short index of each, and its tool is given read access where the tool can enforce it.
// A conversation's turn sees its room's folders and its own; a companion at work also sees its own.
// Writing into them is Starport's own job (save): only when the user asked for it in that turn.
import { createWriteStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const KNOWLEDGE_SCOPES=['room','chat','companion'];
const MAX_FOLDERS=12;
const INDEX_ENTRIES=20;
const DOWNLOAD_BYTES=500*1024*1024,DOWNLOAD_MS=10*60*1000,REDIRECTS=5;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const pathKey=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
export const insideFolder=(path,root)=>{const p=pathKey(path),r=pathKey(root);return p===r||p.startsWith(r.endsWith(sep)?r:r+sep);};
const clip=(text,length)=>text.length>length?text.slice(0,length-1)+'…':text;
// The user's own words this turn must ask for it; a model never decides to write here by itself.
export const knowledgeRequested=text=>/知识库|资料库|knowledge[\s-]*(?:base|folder)|reference\s+(?:material|folder)/i.test(String(text||''));

// A file name only: anything Windows refuses is replaced, reserved device names are escaped.
function fileName(raw){
  const name=String(raw||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').trim().slice(0,200);
  if(!name||/^\.+$/.test(name))return '';
  return /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(name)?'_'+name:name;
}
function dispositionName(header){
  const value=String(header||''),star=/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(value),plain=/filename\s*=\s*"?([^";]+)"?/i.exec(value);
  try{if(star)return decodeURIComponent(star[1].trim());}catch{}
  return plain?plain[1].trim():'';
}
function urlName(url){try{return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop()||'');}catch{return '';}}
// Downloads come from Starport's own process, so they may not reach this computer's own services.
function privateAddress(address){
  if(isIP(address)===4)return /^(?:127\.|0\.|169\.254\.)/.test(address);
  const lower=address.toLowerCase();
  return lower==='::'||lower==='::1'||/^fe[89ab]/.test(lower)||/^::ffff:(?:127\.|0\.|169\.254\.)/.test(lower);
}
async function publicHost(hostname){
  const host=hostname.replace(/^\[|\]$/g,'');
  if(/^localhost$|\.localhost$/i.test(host))throw fail('不能从本机地址下载');
  const addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true}).catch(()=>{throw fail('找不到下载地址的主机：'+host);});
  if(addresses.some(row=>privateAddress(row.address)))throw fail('不能从本机地址下载');
}

export class KnowledgeFolders {
  // dataDir holds every conversation and the tools' stored credentials, so it never becomes knowledge.
  constructor(store,{dataDir=null}={}){
    this.store=store;this.db=store.db;this.dataDir=dataDir;
    this.companionName=()=>null;
    this.checkHost=publicHost;
    this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_folders (id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner TEXT NOT NULL,
        path TEXT NOT NULL, canonical TEXT NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_owner ON knowledge_folders(scope,owner,created);
      CREATE TRIGGER IF NOT EXISTS knowledge_follow_room AFTER DELETE ON groups BEGIN
        DELETE FROM knowledge_folders WHERE scope='room' AND owner=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS knowledge_follow_chat AFTER DELETE ON chats BEGIN
        DELETE FROM knowledge_folders WHERE scope='chat' AND owner=OLD.id; END;`);
  }
  // Companions live in the workflows tables; the server tells this module how to name them.
  // Their folders are removed with them (Workflows.deleteCompanion).
  ownerName(scope,owner){
    if(scope==='room')return this.db.prepare('SELECT name FROM groups WHERE id=?').get(owner)?.name??null;
    if(scope==='chat'){const chat=this.store.chat(owner);return chat&&!chat.options?.desk?chat.title:null;}
    if(scope==='companion')return this.companionName(owner);
    return null;
  }
  canonical(path){
    if(typeof path!=='string'||!isAbsolute(path)||path.length>2000||path.includes('\0')||/^(?:\\\\|\/\/)/.test(path))throw fail('请选择本机文件夹的完整路径');
    const wholeDrive=folder=>folder===parse(folder).root;
    const driveError=()=>fail('不能把整个磁盘设为知识库，请选择具体的资料文件夹');
    if(wholeDrive(resolve(path)))throw driveError();
    let canonical;
    try{canonical=realpathSync.native(path);if(!statSync(canonical).isDirectory())throw Error();}
    catch{throw fail('文件夹不存在或无法访问');}
    if(wholeDrive(canonical))throw driveError();
    const home=homedir();
    if(insideFolder(home,canonical))throw fail('不能把用户主目录或包含它的文件夹设为知识库，请选择具体的资料文件夹');
    const guarded=[this.dataDir&&this.real(this.dataDir),...['.ssh','.aws','.codex','.claude','.gemini'].map(name=>join(home,name))].filter(Boolean);
    if(guarded.some(path=>insideFolder(canonical,path)||insideFolder(path,canonical)))throw fail('这个文件夹包含星港数据或登录凭据，不能设为知识库');
    return canonical;
  }
  list(scope,owner){
    if(!KNOWLEDGE_SCOPES.includes(scope)||typeof owner!=='string')return [];
    return this.db.prepare('SELECT * FROM knowledge_folders WHERE scope=? AND owner=? ORDER BY created,id').all(scope,owner).map(row=>({...row,missing:!this.exists(row.canonical)}));
  }
  exists(path){try{return statSync(path).isDirectory();}catch{return false;}}
  real(path){try{return realpathSync.native(path);}catch{return path;}}
  add(scope,owner,path){
    if(!KNOWLEDGE_SCOPES.includes(scope))throw fail('知识库位置无效');
    if(typeof owner!=='string'||this.ownerName(scope,owner)===null)throw fail(scope==='room'?'房间不存在':scope==='chat'?'对话不存在':'伙伴不存在',404);
    const canonical=this.canonical(path),rows=this.list(scope,owner);
    if(rows.some(row=>pathKey(row.canonical)===pathKey(canonical)))throw fail('这个文件夹已经在知识库里了');
    if(rows.length>=MAX_FOLDERS)throw fail(`每处最多挂 ${MAX_FOLDERS} 个知识库文件夹`);
    const row={id:randomUUID(),scope,owner,path:resolve(path),canonical,name:basename(canonical)||canonical,created:new Date().toISOString()};
    this.db.prepare('INSERT INTO knowledge_folders(id,scope,owner,path,canonical,name,created) VALUES(?,?,?,?,?,?,?)').run(row.id,row.scope,row.owner,row.path,row.canonical,row.name,row.created);
    return {...row,missing:false};
  }
  remove(id){
    const row=this.db.prepare('SELECT * FROM knowledge_folders WHERE id=?').get(id);if(!row)throw fail('这个知识库文件夹已经移除',404);
    this.db.prepare('DELETE FROM knowledge_folders WHERE id=?').run(id);return row;
  }
  removeOwner(scope,owner){this.db.prepare('DELETE FROM knowledge_folders WHERE scope=? AND owner=?').run(scope,owner);}

  // The folders one turn may read. An exam seat has only its own paper; Starport's own desks
  // (compaction, planning) have none. A desk working for a conversation sees that conversation's
  // room and conversation folders, then its companion's. A folder that holds the working folder
  // would make the work itself read-only, so it is left out with a notice.
  forRun(chat,{bare=false}={}){
    const empty={folders:[],notices:[]};
    if(bare||!chat)return empty;
    const desk=chat.options?.desk;let parent=chat,companionId=null;
    if(desk){
      if(!desk.companionId||desk.exam)return empty;
      parent=this.store.chat(desk.parentChatId);companionId=desk.companionId;
      if(!parent)return empty;
    }
    return this.collect([['room',parent.group_id],['chat',parent.id],['companion',companionId]],chat.workspace);
  }
  collect(sources,workspace){
    const seen=new Set(),folders=[],notices=[];
    for(const [scope,owner] of sources.filter(([,owner])=>owner)){
      const ownerName=this.ownerName(scope,owner);
      for(const row of this.list(scope,owner)){
        const key=pathKey(row.canonical);if(seen.has(key))continue;seen.add(key);
        if(row.missing){notices.push(`知识库文件夹找不到了，这一轮没有用它：${row.path}`);continue;}
        if(insideFolder(workspace,row.canonical)){notices.push(`知识库文件夹包含工作目录，这一轮没有用它：${row.path}`);continue;}
        folders.push({scope,owner,ownerName,name:row.name,path:row.path,canonical:row.canonical});
      }
    }
    return {folders,notices};
  }
  // Where a turn may save, when the user asks: the room's and the conversation's folders, and from
  // the conversation's own model also those of every companion in the room. A companion @-mentioned
  // in the conversation saves to the room's, the conversation's and its own. Called companions,
  // workflow steps, exam seats and Starport's own desks never save.
  writeTargets(chat){
    if(!chat)return [];
    const desk=chat.options?.desk;let parent=chat,companions=[];
    if(desk){
      if(!desk.persistent||!desk.companionId)return [];
      parent=this.store.chat(desk.parentChatId);companions=[desk.companionId];
      if(!parent)return [];
    }else if(parent.group_id){
      try{companions=this.db.prepare('SELECT companion_id FROM room_members WHERE group_id=? ORDER BY added').all(parent.group_id).map(row=>row.companion_id);}catch{}
    }
    return this.collect([['room',parent.group_id],['chat',parent.id],...companions.map(id=>['companion',id])],chat.workspace).folders;
  }
  // Saves one file into a knowledge folder: a download (url) or a copy of a file in the working
  // folder (path). Written beside the target first, then moved into place; never overwrites
  // unless asked to.
  async save(targets,{folder='',subfolder='',name='',url='',path='',overwrite=false}={},{workspace,signal}={}){
    if(!url===!path)throw fail('url 和 path 只能给一个：url 下载网络文件，path 复制工作目录里的文件');
    const wanted=String(folder||'').trim(),key=wanted&&isAbsolute(wanted)?pathKey(wanted):null;
    const matches=!wanted&&targets.length===1?targets:targets.filter(f=>key?pathKey(f.path)===key||pathKey(f.canonical)===key:f.name.toLowerCase()===wanted.toLowerCase());
    if(matches.length!==1)throw fail(`${matches.length?'有几个同名知识库，请写完整路径':'没有这个知识库'}。可以存到：${targets.map(f=>f.path).join('；')}`);
    const target=matches[0],sub=normalize(String(subfolder||'.'));
    if(isAbsolute(sub)||/^[a-z]:/i.test(sub)||sub.split(/[\\/]/).includes('..'))throw fail('subfolder 只能是知识库里的相对路径');
    if(/[\\/]/.test(String(name||'')))throw fail('name 只写文件名；子文件夹用 subfolder');
    const directory=resolve(target.canonical,sub);
    await mkdir(directory,{recursive:true});
    if(!insideFolder(realpathSync.native(directory),target.canonical))throw fail('子文件夹不在知识库里');
    const replace=overwrite===true||overwrite==='true',where=file=>{
      const saved=join(directory,file);
      if(!replace&&existsSync(saved))throw fail('知识库里已有同名文件，没有覆盖：'+saved+'。要覆盖请加 overwrite，或换个 name');
      return saved;
    };
    let saved,bytes;
    if(path){
      let source;
      try{source=realpathSync.native(resolve(workspace,String(path)));}catch{throw fail('path 必须是工作目录里的文件');}
      if(!insideFolder(source,realpathSync.native(workspace))||!(await stat(source)).isFile())throw fail('path 必须是工作目录里的文件');
      saved=where(fileName(name)||fileName(basename(source)));
      await copyFile(source,saved,replace?0:constants.COPYFILE_EXCL);bytes=(await stat(saved)).size;
    }else({saved,bytes}=await this.download(String(url),{directory,name:fileName(name),where,signal}));
    return {saved,bytes,knowledge:{scope:target.scope,owner:target.ownerName,folder:target.name},from:url||path};
  }
  async download(url,{directory,name,where,signal}){
    let address;try{address=new URL(url);}catch{throw fail('下载地址无效');}
    const timeout=AbortSignal.timeout(DOWNLOAD_MS),abort=signal?AbortSignal.any([signal,timeout]):timeout;
    let response;
    // Redirects are followed by hand, so none of them can lead to this computer's own services.
    for(let hop=0;;hop++){
      if(!['http:','https:'].includes(address.protocol))throw fail('只能下载 http/https 地址');
      await this.checkHost(address.hostname);
      try{response=await fetch(address,{redirect:'manual',signal:abort,headers:{'User-Agent':'Starport'}});}
      catch(error){throw fail(timeout.aborted?'下载超时':'下载失败：'+(error.cause?.message||error.message));}
      if(![301,302,303,307,308].includes(response.status))break;
      await response.body?.cancel().catch(()=>{});
      if(hop>=REDIRECTS||!response.headers.get('location'))throw fail('下载地址跳转太多次');
      address=new URL(response.headers.get('location'),address);
    }
    const refuse=async message=>{await response.body?.cancel().catch(()=>{});return fail(message);};
    if(!response.ok)throw await refuse(`下载失败：HTTP ${response.status}`);
    if(Number(response.headers.get('content-length'))>DOWNLOAD_BYTES)throw await refuse('文件超过 500 MB，没有下载');
    const saved=where(name||fileName(dispositionName(response.headers.get('content-disposition')))||fileName(urlName(address.href))||'download');
    const partial=join(directory,'.starport-download-'+randomUUID());let bytes=0;
    const limit=new Transform({transform(chunk,_,done){bytes+=chunk.length;done(bytes>DOWNLOAD_BYTES?fail('文件超过 500 MB，没有下载'):null,chunk);}});
    try{
      await pipeline(response.body?Readable.fromWeb(response.body):Readable.from([]),limit,createWriteStream(partial,{flags:'wx'}));
      where(basename(saved));await rename(partial,saved);
    }catch(error){await rm(partial,{force:true});throw error.status?error:fail(timeout.aborted?'下载超时':'下载失败：'+error.message);}
    return {saved,bytes};
  }
  fingerprint(folders,save=false){
    return folders.length?createHash('sha256').update(JSON.stringify(folders.map(f=>[f.scope,f.owner,pathKey(f.canonical)]))).digest('hex')+(save?':save':''):'';
  }
  // What the folder holds at its top level, so the model knows where to start looking.
  index(path){
    try{
      const entries=readdirSync(path,{withFileTypes:true}).filter(entry=>!entry.name.startsWith('.'));
      entries.sort((a,b)=>(b.isDirectory()-a.isDirectory())||a.name.localeCompare(b.name));
      const names=entries.slice(0,INDEX_ENTRIES).map(entry=>clip(entry.name,60)+(entry.isDirectory()?'/':''));
      if(!entries.length)return '目前是空的';
      return `顶层 ${entries.length} 项：${names.join('、')}${entries.length>names.length?'……':''}`;
    }catch{return '暂时无法列出内容';}
  }
  // save: this turn may save into knowledge folders when the user asks (starport_knowledge_save).
  prompt(folders,{save=false}={}){
    if(!folders.length)return '';
    const from={room:'房间',chat:'对话',companion:'伙伴'};
    const lines=folders.map(f=>`- ${f.name}：${f.path}（${from[f.scope]}「${clip(f.ownerName||'',40)}」）。${this.index(f.canonical)}`);
    return ['星港知识库（用户挂上的只读参考资料；需要时用读取和搜索工具查阅，引用时写出文件路径）：',...lines,
      save?'只读：不要用你自己的工具修改、移动或删除这些文件夹里的内容，也不要在里面新建文件。只有用户在这一轮明确要求把东西存进知识库时，才用 starport_knowledge_save 存；其余要写的东西放在工作目录。'
        :'只读：不要修改、移动或删除这些文件夹里的内容，也不要在里面新建文件；要写的东西放在工作目录。'].join('\n')+'\n';
  }
  // A resumed native session already has the list it was given; only a change is sent again.
  // prior: what the last turn of this native session recorded, or null for a fresh session.
  sessionPrompt(folders,prior,{save=false}={}){
    const fingerprint=this.fingerprint(folders,save);
    if(prior&&(prior.fingerprint||'')===fingerprint)return '';
    if(!folders.length)return prior?.fingerprint?'星港知识库更新：现在没有挂载的知识库文件夹，之前提到的那些不要再用。\n':'';
    return (prior?'星港知识库更新（以这份为准）：\n':'')+this.prompt(folders,{save});
  }
}

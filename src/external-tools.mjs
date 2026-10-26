import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { restrictToCurrentUser } from './process.mjs';

const fail=message=>Object.assign(new Error(message),{status:400});
export const toolPathKey=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
export const insideToolPath=(path,root)=>{const p=toolPathKey(path),r=toolPathKey(root);return p===r||p.startsWith(r.endsWith(sep)?r:r+sep);};
export function canonicalToolPath(path,directory=true){
  if(typeof path!=='string'||!isAbsolute(path)||path.length>2000||/[\0\r\n*?\[\]{}]/.test(path)||/^(?:\\\\|\/\/)/.test(path))throw fail('请选择本机的完整工具路径');
  let canonical;try{canonical=realpathSync.native(path);if(directory?!statSync(canonical).isDirectory():!statSync(canonical).isFile())throw Error();}
  catch{throw fail('工具路径不存在或无法访问');}
  return canonical;
}

// Recheck physical targets before every launch/command. A retargeted junction
// cannot turn an earlier grant into permission for a different directory.
function validateToolPaths(tool){
  if(toolPathKey(canonicalToolPath(tool.directory))!==toolPathKey(tool.canonical))throw fail('工具路径已变化，请重新添加');
  if(tool.executable&&(!insideToolPath(canonicalToolPath(tool.executable,false),tool.canonical)||
    toolPathKey(canonicalToolPath(tool.executable,false))!==toolPathKey(tool.canonicalExecutable)))throw fail('工具程序已变化，请重新添加');
}
export function validateToolSnapshot(snapshot,workspace){
  const current=canonicalToolPath(workspace);
  if(toolPathKey(current)!==toolPathKey(snapshot.workspace))throw fail('项目路径已变化，请重新配置开发工具');
  for(const tool of snapshot.tools)validateToolPaths(tool);
  return snapshot;
}
const catalogEntry=tool=>({id:tool.id,name:tool.name,directory:tool.directory,canonical:tool.canonical,
  executable:tool.executable||'',canonicalExecutable:tool.canonicalExecutable||''});

export class ExternalTools {
  constructor({dataDir,root}){this.dataDir=resolve(dataDir);this.root=resolve(root);this.file=join(this.dataDir,'external-tools.json');this.writes=Promise.resolve();}
  read(){
    if(!existsSync(this.file))return {version:1,projects:{},catalog:[]};
    let value;try{value=JSON.parse(readFileSync(this.file,'utf8'));}catch{throw fail('开发工具配置无法读取，请恢复本机备份');}
    if(value.version!==1||!value.projects||typeof value.projects!=='object'||Array.isArray(value.projects)||value.catalog!==undefined&&!Array.isArray(value.catalog))throw fail('开发工具配置无效');
    // Old configurations already contain the user's tool choices. Reading them
    // seeds the catalog without writing or changing any project's permissions.
    const entries=new Map();
    for(const tool of [...(value.catalog||[]),...Object.values(value.projects).flatMap(p=>p.tools||[])]){
      if(!tool||typeof tool.id!=='string'||typeof tool.name!=='string'||typeof tool.directory!=='string'||typeof tool.canonical!=='string')throw fail('开发工具配置无效');
      const key=toolPathKey(tool.canonical);if(!entries.has(key))entries.set(key,catalogEntry(tool));
    }
    return {...value,catalog:[...entries.values()]};
  }
  snapshot(workspace){
    const canonical=canonicalToolPath(workspace),saved=this.read().projects[toolPathKey(canonical)];
    return validateToolSnapshot({workspace:canonical,tools:saved?.tools||[]},workspace);
  }
  view(workspace){
    const canonical=canonicalToolPath(workspace),saved=this.read().projects[toolPathKey(canonical)];
    return {workspace:canonical,tools:(saved?.tools||[]).map(tool=>{let error='';try{validateToolSnapshot({workspace:canonical,tools:[tool]},workspace);}catch(e){error=e.message;}return {...tool,error};})};
  }
  catalog(){
    return this.read().catalog.map(tool=>{let error='';try{validateToolPaths(tool);}catch(e){error=e.message;}return {...tool,error};});
  }
  async use(workspace,id){
    const tool=this.read().catalog.find(tool=>tool.id===id);
    if(!tool)throw Object.assign(Error('工具不存在'),{status:404});
    validateToolPaths(tool);
    return this.add(workspace,tool);
  }
  async change(workspace,mutate){
    const perform=async()=>{
      const canonical=canonicalToolPath(workspace),all=this.read(),key=toolPathKey(canonical);
      const tools=mutate(all.projects[key]?.tools||[],all);
      if(tools.length)all.projects[key]={workspace:canonical,tools};else delete all.projects[key];
      await mkdir(this.dataDir,{recursive:true});const temporary=this.file+'.'+randomUUID()+'.tmp';
      try{await writeFile(temporary,'',{mode:0o600});await restrictToCurrentUser(temporary);await writeFile(temporary,JSON.stringify(all,null,2),{mode:0o600});await rename(temporary,this.file);}
      finally{await unlink(temporary).catch(()=>{});}
      return this.view(workspace);
    };
    const pending=this.writes.then(perform);this.writes=pending.catch(()=>{});return pending;
  }
  async add(workspace,input){
    if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw fail('请输入工具名称');
    const canonical=canonicalToolPath(input.directory),project=canonicalToolPath(workspace);
    const protectedRoots=[this.dataDir,this.root,homedir(),...['.ssh','.aws','.codex','.claude'].map(name=>join(homedir(),name))];
    if(canonical===parse(canonical).root||insideToolPath(project,canonical)||insideToolPath(canonical,project)||
      protectedRoots.some(path=>insideToolPath(path,canonical))||insideToolPath(canonical,this.dataDir)||
      protectedRoots.slice(3).some(path=>insideToolPath(canonical,path)))throw fail('请选择单独的工具安装文件夹');
    const executable=input.executable?.trim()?canonicalToolPath(input.executable,false):'';
    if(executable&&!insideToolPath(executable,canonical))throw fail('程序必须位于工具安装文件夹内');
    const tool={id:randomUUID(),name:input.name.trim(),directory:resolve(input.directory),canonical,
      executable:input.executable?.trim()?resolve(input.executable):'',canonicalExecutable:executable,access:'read'};
    return this.change(workspace,(tools,all)=>{
      if(tools.length>=12)throw fail('每个项目最多添加 12 个外部工具');
      if(tools.some(t=>toolPathKey(t.canonical)===toolPathKey(canonical)))throw fail('这个工具文件夹已经添加');
      const remembered=all.catalog.find(t=>toolPathKey(t.canonical)===toolPathKey(canonical));
      all.catalog=[{...catalogEntry(tool),id:remembered?.id||tool.id},...all.catalog.filter(t=>toolPathKey(t.canonical)!==toolPathKey(canonical))];
      return [...tools,tool];
    });
  }
  remove(workspace,id){return this.change(workspace,tools=>tools.filter(tool=>tool.id!==id));}
}

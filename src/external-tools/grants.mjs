// Per-project grants for installed tools (SDKs, engines, editors), plus a
// machine-wide catalog of previously added tools. Grants live in
// .data/external-tools.json, never inside the project.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writePrivateFile } from '../process.mjs';

const MAX_PROJECT_TOOLS=12;
// Part of the Claude session fingerprint. Change it when what a grant allows
// changes, so a session started under older rules is not resumed.
const EXECUTION_POLICY='managed-applications-v2';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const missingTool=()=>fail('工具不存在',404);

export const toolPathKey=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
export const insideToolPath=(path,root)=>{const p=toolPathKey(path),r=toolPathKey(root);return p===r||p.startsWith(r.endsWith(sep)?r:r+sep);};
// Only a configured .exe can be started on the host.
export const hostRunnable=tool=>/\.exe$/i.test(tool?.canonicalExecutable||'');
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
  if(!tool.executable)return;
  const executable=canonicalToolPath(tool.executable,false);
  if(!insideToolPath(executable,tool.canonical)||toolPathKey(executable)!==toolPathKey(tool.canonicalExecutable))throw fail('工具程序已变化，请重新添加');
}
export function validateToolSnapshot(snapshot,workspace){
  const current=canonicalToolPath(workspace);
  if(toolPathKey(current)!==toolPathKey(snapshot.workspace))throw fail('项目路径已变化，请重新配置开发工具');
  for(const tool of snapshot.tools)validateToolPaths(tool);
  return snapshot;
}
const withPathError=tool=>{try{validateToolPaths(tool);return {...tool,error:''};}catch(error){return {...tool,error:error.message};}};
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
  saved(workspace){
    const canonical=canonicalToolPath(workspace);
    return {workspace:canonical,tools:this.read().projects[toolPathKey(canonical)]?.tools||[]};
  }
  snapshot(workspace){return validateToolSnapshot(this.saved(workspace),workspace);}
  // Like snapshot, but reports a broken grant on the tool instead of throwing.
  view(workspace){const {workspace:canonical,tools}=this.saved(workspace);return {workspace:canonical,tools:tools.map(withPathError)};}
  catalog(){return this.read().catalog.map(withPathError);}
  // The grants a Claude run receives, or null when the project has none.
  runtimePolicy(workspace,sandboxExecutable){
    if(!existsSync(this.file)||!existsSync(workspace))return null;
    const policy=this.snapshot(workspace);
    return policy.tools.length?{...policy,executionPolicy:EXECUTION_POLICY,dataDir:this.dataDir,sandboxExecutable:sandboxExecutable()}:null;
  }
  async use(workspace,id){
    const tool=this.read().catalog.find(tool=>tool.id===id);
    if(!tool)throw missingTool();
    validateToolPaths(tool);
    return this.add(workspace,tool);
  }
  // Writes are serialized and atomic; the file is readable by the current user only.
  async change(workspace,mutate){
    const perform=async()=>{
      const canonical=canonicalToolPath(workspace),all=this.read(),key=toolPathKey(canonical);
      const tools=mutate(all.projects[key]?.tools||[],all);
      if(tools.length)all.projects[key]={workspace:canonical,tools};else delete all.projects[key];
      await mkdir(this.dataDir,{recursive:true});const temporary=this.file+'.'+randomUUID()+'.tmp';
      try{await writePrivateFile(temporary,JSON.stringify(all,null,2));await rename(temporary,this.file);}
      finally{await unlink(temporary).catch(()=>{});}
      return this.view(workspace);
    };
    const pending=this.writes.then(perform);this.writes=pending.catch(()=>{});return pending;
  }
  // A tool folder must be a separate installation: not a drive root, not
  // related to the project, and neither holding nor inside Starport data or
  // credential folders.
  allowedToolFolder(canonical,project){
    const home=homedir(),credentials=['.ssh','.aws','.codex','.claude'].map(name=>join(home,name));
    const holdsProtected=[this.dataDir,this.root,home,...credentials].some(path=>insideToolPath(path,canonical));
    const insideProtected=[this.dataDir,...credentials].some(path=>insideToolPath(canonical,path));
    return canonical!==parse(canonical).root&&!insideToolPath(project,canonical)&&!insideToolPath(canonical,project)&&!holdsProtected&&!insideProtected;
  }
  async add(workspace,input){
    if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw fail('请输入工具名称');
    const canonical=canonicalToolPath(input.directory),key=toolPathKey(canonical);
    if(!this.allowedToolFolder(canonical,canonicalToolPath(workspace)))throw fail('请选择单独的工具安装文件夹');
    const executable=input.executable?.trim()?canonicalToolPath(input.executable,false):'';
    if(executable&&!insideToolPath(executable,canonical))throw fail('程序必须位于工具安装文件夹内');
    const tool={id:randomUUID(),name:input.name.trim(),directory:resolve(input.directory),canonical,
      executable:input.executable?.trim()?resolve(input.executable):'',canonicalExecutable:executable,access:'read'};
    return this.change(workspace,(tools,all)=>{
      if(tools.length>=MAX_PROJECT_TOOLS)throw fail(`每个项目最多添加 ${MAX_PROJECT_TOOLS} 个外部工具`);
      if(tools.some(t=>toolPathKey(t.canonical)===key))throw fail('这个工具文件夹已经添加');
      // The catalog keeps one entry per installation, with its latest name.
      const remembered=all.catalog.find(t=>toolPathKey(t.canonical)===key);
      all.catalog=[{...catalogEntry(tool),id:remembered?.id||tool.id},...all.catalog.filter(t=>toolPathKey(t.canonical)!==key)];
      return [...tools,tool];
    });
  }
  setHostApproval(workspace,id,value){
    if(!['ask','always'].includes(value))throw fail('请选择有效的本机运行授权');
    return this.change(workspace,tools=>{
      const tool=tools.find(tool=>tool.id===id);if(!tool)throw missingTool();
      validateToolPaths(tool);
      if(value==='always'&&!hostRunnable(tool))throw fail('请先配置 .exe 程序路径');
      // Host consent is deliberately project-local, never part of the catalog.
      return tools.map(item=>item.id===id?{...item,hostApproval:value}:item);
    });
  }
  remove(workspace,id){return this.change(workspace,tools=>tools.filter(tool=>tool.id!==id));}
}

import { stat, realpath, readdir, lstat } from 'node:fs/promises';
import { dirname, extname, join, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const actions=new Set(['open','reveal','open-with']);
// Code and executable files go through the application picker, never their run association.
const documents=new Set('.md .mdx .txt .log .pdf .doc .docx .odt .rtf .xls .xlsx .ods .csv .ppt .pptx .odp .png .jpg .jpeg .gif .webp .bmp .svg .ico .mp3 .wav .mp4 .mov .mkv .html .htm .zip'.split(' '));
function referenceValue(reference,platform){
  if(typeof reference!=='string'||!reference.trim()||reference.length>8192||/[\x00-\x1f\x7f]/.test(reference))throw new Error('文件路径无效');
  let value=reference.trim();
  if(/^file:/i.test(value)){
    let url;try{url=new URL(value);}catch{throw new Error('文件路径无效');}
    if(url.hostname)throw new Error('暂不支持网络文件路径');
    url.hash='';url.search='';
    try{value=fileURLToPath(url,{windows:platform==='win32'});}catch{throw new Error('文件路径无效');}
  }else{
    // Markdown URLs encode spaces; line/column anchors do not belong to the disk path.
    value=value.replace(/#L?\d+(?:[-:]L?\d+)*$/i,'').replace(/:\d+(?::\d+)?$/,'');
    try{value=decodeURIComponent(value);}catch{}
  }
  if(/[\x00-\x1f\x7f]/.test(value)||/^[/\\]{2}/.test(value))throw new Error('暂不支持网络文件路径');
  if(platform==='win32'){
    if(/^\/[a-z]:\//i.test(value))value=value.slice(1);
    if(/[<>"|?*]/.test(value)||value.slice(/^[a-z]:/i.test(value)?2:0).includes(':')||/^[a-z]:(?![/\\])/i.test(value))throw new Error('文件路径无效');
  }else if(/^[a-z][\w+.-]*:/i.test(value))throw new Error('文件路径无效');
  return value;
}
export function localFilePath(reference,workspace,platform=process.platform){
  const paths=platform==='win32'?win32:posix,value=referenceValue(reference,platform);
  const path=paths.resolve(workspace,value);
  if(platform==='win32'&&!/^[a-z]:\\/i.test(path))throw new Error('暂不支持网络文件路径');
  return path;
}
export class FileActions{
  constructor({launch=launchWindowsFileAction,platform=process.platform,searchLimits={}}={}){
    this.launch=launch;this.platform=platform;
    this.searchLimits={maxEntries:50000,maxCandidates:50,timeoutMs:5000,...searchLimits};
  }
  async findInWorkspace(reference,workspace,missingPath){
    const paths=this.platform==='win32'?win32:posix,value=referenceValue(reference,this.platform);
    const inside=(root,path)=>{const relative=paths.relative(root,path);return relative!=='..'&&!relative.startsWith('..'+paths.sep)&&!paths.isAbsolute(relative);};
    // Explicit absolute paths and parent-directory references retain their meaning.
    if(paths.isAbsolute(value)||!inside(paths.resolve(workspace),missingPath))return null;
    const wanted=paths.relative(paths.resolve(workspace),missingPath),fold=text=>this.platform==='win32'?text.toLowerCase():text;
    let root;try{root=await realpath(workspace);}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error;}
    if(!(await stat(root)).isDirectory())return null;
    const directories=[root],visited=new Set(),candidates=[];
    const {maxEntries,maxCandidates,timeoutMs}=this.searchLimits,deadline=Date.now()+timeoutMs;
    let scanned=0,incomplete=false;
    scan:for(let index=0;index<directories.length;index++){
      if(scanned>=maxEntries||Date.now()>deadline){incomplete=true;break;}
      const directory=directories[index];let entries;
      try{
        // Recheck queued directories so junctions cannot extend the search scope.
        if((await lstat(directory)).isSymbolicLink())continue;
        const canonical=await realpath(directory);
        if(!inside(root,canonical)||visited.has(fold(canonical)))continue;
        visited.add(fold(canonical));entries=await readdir(canonical,{withFileTypes:true});
      }catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code)){incomplete=true;continue;}throw error;}
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      for(const entry of entries){
        if(++scanned>maxEntries||Date.now()>deadline){incomplete=true;break scan;}
        if(entry.isSymbolicLink())continue;
        const path=paths.join(directory,entry.name);
        if(entry.isDirectory()){directories.push(path);continue;}
        if(!entry.isFile())continue;
        const relative=paths.relative(root,path),suffix=fold(relative),target=fold(wanted);
        if(suffix!==target&&!suffix.endsWith(paths.sep+target))continue;
        try{
          const canonical=await realpath(path);
          if(!inside(root,canonical)||(await lstat(path)).isSymbolicLink()||!(await stat(canonical)).isFile())continue;
          localFilePath(canonical,workspace,this.platform);
          candidates.push({path:canonical,name:paths.basename(canonical),relativePath:paths.relative(root,canonical)});
          if(candidates.length>=maxCandidates){incomplete=true;break scan;}
        }catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code)){incomplete=true;continue;}throw error;}
      }
    }
    candidates.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
    return {candidates,incomplete};
  }
  async resolve(reference,workspace){
    const path=localFilePath(reference,workspace,this.platform);
    try{
      const canonical=await realpath(path),info=await stat(canonical);
      if(!info.isFile())throw new Error('请选择一个文件');
      // Also validate the destination of any filesystem link before giving it to the Shell.
      localFilePath(canonical,workspace,this.platform);
      return {path:canonical,name:(this.platform==='win32'?win32.basename: p=>p.split('/').pop())(canonical)};
    }catch(error){
      if(['ENOENT','ENOTDIR'].includes(error.code)){
        const found=await this.findInWorkspace(reference,workspace,path);
        if(found?.candidates.length===1&&!found.incomplete)return {...found.candidates[0],foundInSubfolder:true};
        if(found?.candidates.length)return {ambiguous:true,reference,candidates:found.candidates,searchIncomplete:found.incomplete};
        if(found?.incomplete)throw Object.assign(new Error('工作目录较大或有无法访问的文件夹，请使用完整路径。'),{status:409});
        throw Object.assign(new Error(found?'文件不存在，已在当前工作目录及其子文件夹中查找。':'文件不存在，可能已移动或删除；相对路径按当前对话的工作目录查找。'),{status:404});
      }
      throw error;
    }
  }
  async perform(action,reference,workspace){
    if(!actions.has(action))throw new Error('文件操作无效');
    const file=await this.resolve(reference,workspace);
    if(file.ambiguous)return file;
    const nativeAction=action==='open'&&!documents.has(extname(file.path).toLowerCase())?'open-with':action;
    const result=await this.launch(nativeAction,file.path);
    return {...file,action:nativeAction,...result};
  }
  // The caller validates the folder; Explorer opens it like a double-click would.
  async openFolder(path){return {path,...await this.launch('open-folder',path)};}
}
export function launchWindowsFileAction(action,path){
  if(process.platform!=='win32')throw Object.assign(new Error('本机文件打开功能目前仅支持 Windows'),{status:501});
  if(!actions.has(action)&&action!=='open-folder')throw new Error('文件操作无效');
  const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const helper=fileURLToPath(new URL('../scripts/windows-file-action.ps1',import.meta.url));
  return new Promise((ok,fail)=>{
    // File names travel as data through stdin. Never interpolate them into shell code.
    const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',helper],{cwd:dirname(helper),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let output='',errors='';
    child.stdout.on('data',chunk=>output=(output+chunk.toString('utf8')).slice(-16000));
    child.stderr.on('data',chunk=>errors=(errors+chunk.toString('utf8')).slice(-4000));
    child.once('error',fail);child.stdin.on('error',()=>{});
    child.once('close',code=>{
      if(code!==0){fail(new Error('Windows 文件操作失败：'+(errors.trim()||String(code))));return;}
      try{ok(JSON.parse(output.trim()));}catch{fail(new Error('Windows 未返回文件操作结果'));}
    });
    child.stdin.end(Buffer.from(JSON.stringify({action,path}),'utf8').toString('base64'));
  });
}

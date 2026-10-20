import { mkdir, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export async function directoryPath(value) {
  if(typeof value!=='string'||!value.trim()||value.length>2000||value.includes('\0')||!isAbsolute(value))throw new Error('请输入文件夹的完整路径');
  const path=resolve(value);
  try{if(!(await stat(path)).isDirectory())throw new Error('not-directory');}
  catch(error){throw new Error(['EACCES','EPERM'].includes(error.code)?'没有权限打开这个文件夹':'文件夹不存在或无法访问');}
  return path;
}

// Desktop, Documents and Downloads can be redirected (for example into OneDrive), so ask Windows instead of guessing.
// The script is constant and prints base64 UTF-8 JSON, keeping non-ASCII folder names intact across code pages.
const shellFolderScript="$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';$p=Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue;"+
  "$v=@{Desktop=[Environment]::GetFolderPath('Desktop');Documents=[Environment]::GetFolderPath('MyDocuments');Downloads=[Environment]::ExpandEnvironmentVariables([string]$p.'{374DE290-123F-4565-9164-39C4925E467B}')};"+
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Compress)))";
function windowsShellFolders(){
  const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise(done=>execFile(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',shellFolderScript],{windowsHide:true,timeout:5000},(error,stdout)=>{
    try{done(error?{}:JSON.parse(Buffer.from(String(stdout).trim(),'base64').toString('utf8')));}catch{done({});}
  }));
}
let shellFolders;
export function userFolders(){
  shellFolders??=(process.platform==='win32'?windowsShellFolders():Promise.resolve({})).then(found=>
    [['桌面','Desktop'],['文档','Documents'],['下载','Downloads']].map(([label,key])=>({label,path:typeof found[key]==='string'&&isAbsolute(found[key])?found[key]:join(homedir(),key)})));
  return shellFolders;
}
async function existing(places){
  return (await Promise.all(places.map(async place=>{try{return(await stat(place.path)).isDirectory()?place:null;}catch{return null;}}))).filter(Boolean);
}

export async function browseFolders(value,defaultPath,places=userFolders) {
  const path=await directoryPath(value||defaultPath);let entries;
  try{entries=await readdir(path,{withFileTypes:true});}
  catch{throw new Error('没有权限打开这个文件夹');}
  const folders=(await Promise.all(entries.map(async entry=>{
    const child=join(path,entry.name);
    let directory=entry.isDirectory();
    if(entry.isSymbolicLink())try{directory=(await stat(child)).isDirectory();}catch{}
    return directory?{name:entry.name,path:child}:null;
  }))).filter(Boolean).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  const roots=[...(await existing(await places())).map(place=>({...place,kind:'place'})),{label:'主目录',path:homedir(),kind:'place'},{label:'默认工作目录',path:defaultPath,kind:'place'}];
  if(process.platform==='win32'){
    const drives=await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async drive=>{
      const path=drive+':\\';try{return(await stat(path)).isDirectory()?{label:drive+':',path,kind:'drive'}:null;}catch{return null;}
    }));roots.push(...drives.filter(Boolean));
  }else roots.push({label:'/',path:'/',kind:'drive'});
  return {path,parent:dirname(path)===path?null:dirname(path),folders,roots};
}

// Windows rejects these names in every folder; trailing dots would be silently dropped.
const reservedName=/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
export function folderName(name) {
  const clean=typeof name==='string'?name.trim():'';
  if(!clean||clean.length>255||/[<>:"/\\|?*\x00-\x1f]/.test(clean)||clean.endsWith('.')||reservedName.test(clean))throw new Error('文件夹名称无效，不能包含 \\ / : * ? " < > |，也不能以句点结尾');
  return clean;
}
export async function createFolder(parent,name) {
  const base=await directoryPath(parent),clean=folderName(name);
  const path=join(base,clean);
  try{await mkdir(path);}
  catch(error){
    if(error.code==='EEXIST')throw Object.assign(new Error('已存在同名的文件夹或文件'),{status:409});
    throw new Error(['EACCES','EPERM'].includes(error.code)?'没有权限在这里新建文件夹':'无法新建文件夹');
  }
  return {name:clean,path};
}

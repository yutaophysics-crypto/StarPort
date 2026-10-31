import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname,resolve,join,relative,sep,basename,parse} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {get} from 'node:http';
import {ExternalApplicationManager,isLive} from '../external-tools/applications.mjs';
import {canonicalToolPath,insideToolPath,toolPathKey} from '../external-tools/grants.mjs';
import {redact} from '../process.mjs';

const ENTRY=fileURLToPath(new URL('../../scripts/preview-server.mjs',import.meta.url));
const SERVER=fileURLToPath(new URL('./static-server.mjs',import.meta.url));
const KIND='starport-static-preview-v1',wait=ms=>new Promise(ok=>setTimeout(ok,ms));
const canceled=()=>Error('预览启动已取消');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
async function json(path){try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}}
function health(port,nonce){
  return new Promise(ok=>{
    const req=get({hostname:'127.0.0.1',port,path:'/.starport-preview-health',agent:false,timeout:800},res=>{
      let text='';res.on('data',d=>{text+=d;if(text.length>2048)req.destroy();});
      res.on('end',()=>{try{ok(res.statusCode===200&&JSON.parse(text).nonce===nonce);}catch{ok(false);}});
      res.on('error',()=>ok(false));
    });req.on('error',()=>ok(false));req.on('timeout',()=>{req.destroy();ok(false);});
  });
}
export function previewFolder(workspace,directory='.'){
  workspace=canonicalToolPath(workspace);
  if(typeof directory!=='string'||!directory||directory.length>2000||/[\0\r\n]/.test(directory))throw fail('请选择项目内的预览文件夹');
  const requested=resolve(workspace,directory);
  if(!insideToolPath(requested,workspace))throw fail('预览文件夹必须位于当前项目内');
  const root=canonicalToolPath(requested);
  if(!insideToolPath(root,workspace))throw fail('预览文件夹必须位于当前项目内');
  if(root===parse(root).root||insideToolPath(homedir(),root)||['.data','.git','.ssh','.aws','.claude','.codex'].includes(basename(root).toLowerCase()))throw fail('请选择具体的项目预览文件夹');
  if(relative(workspace,requested).split(sep).some(part=>part.startsWith('.'))||relative(workspace,root).split(sep).some(part=>part.startsWith('.')))throw fail('私有配置文件夹不能作为预览目录');
  return {workspace,root,directory};
}
export function previewLaunch({workspace,root,directory,port,nonce,sandboxExecutable,dataDir}){
  if(process.platform!=='win32'||!sandboxExecutable||!existsSync(sandboxExecutable))throw fail('预览服务需要已注册的 Windows 隔离终端');
  const filesystem={':root':'deny',':minimal':'read',[root]:'read',[dirname(process.execPath)]:'read',[ENTRY]:'read',[SERVER]:'read'};
  if(dataDir&&insideToolPath(root,dataDir))throw fail('星港私有配置不能作为预览目录');
  if(dataDir&&insideToolPath(dataDir,root))filesystem[resolve(dataDir)]='deny';
  const encoded='{ '+Object.entries(filesystem).map(([path,access])=>JSON.stringify(path)+' = '+JSON.stringify(access)).join(', ')+' }';
  const policy=`permissions.starport_preview={ filesystem=${encoded}, network={ enabled=true }, workspace_roots={} }`;
  return {toolId:KIND,tool:'Project static preview',executable:sandboxExecutable,cwd:root,persistent:true,successExitCodes:[0],
    preview:{kind:KIND,workspace,root,directory,port,nonce},
    args:['sandbox','-c','windows.sandbox="mxc"','-c',policy,'-c','features.network_proxy=false','-P','starport_preview','-C',root,'--',process.execPath,'--preserve-symlinks','--preserve-symlinks-main',ENTRY,JSON.stringify({root,port,nonce,blockedPaths:dataDir?[resolve(dataDir)]:[]})]};
}
export class PreviewManager {
  constructor(dataDir){this.dataDir=resolve(dataDir);this.apps=new ExternalApplicationManager(join(dataDir,'previews'));this.queue=Promise.resolve();}
  async rows(workspace){
    const rows=await this.apps.list(workspace);
    return (await Promise.all(rows.filter(row=>row.toolId===KIND).map(async row=>{
      const directory=this.apps.directory(row.id),saved=await json(join(directory,'request.json')),spec=saved?.preview;
      if(spec?.kind!==KIND||toolPathKey(spec.workspace)!==toolPathKey(workspace))return null;
      let ready;try{const lines=(await readFile(join(directory,'stdout.log'),'utf8')).split(/\r?\n/);
        for(const line of lines)try{const value=JSON.parse(line);if(value.event==='starport-preview-ready'&&value.nonce===spec.nonce&&Number.isInteger(value.port)&&value.port>0&&value.port<=65535)ready=value;}catch{}
      }catch{}
      let state=row.state,error=row.error||'';
      if(isLive(row)){
        try{const current=previewFolder(workspace,spec.directory);if(toolPathKey(current.root)!==toolPathKey(spec.root))throw Error('预览文件夹已变化');}
        catch(e){state='unknown';error=e.message;}
        if(!error)state=ready?(await health(ready.port,spec.nonce)?'running':'unknown'):'starting';
      }
      return {id:row.id,root:spec.root,directory:spec.directory,port:ready?.port||spec.port,state,url:state==='running'?`http://127.0.0.1:${ready.port}/`:null,createdAt:row.createdAt,...error?{error}:{},_spec:spec};
    }))).filter(Boolean);
  }
  async list(workspace){workspace=canonicalToolPath(workspace);return (await this.rows(workspace)).map(({_spec,...row})=>row);}
  async stop(workspace,id){
    workspace=canonicalToolPath(workspace);
    if(!(await this.rows(workspace)).some(row=>row.id===id))throw fail('当前项目没有这个预览服务',404);
    await this.apps.stop(workspace,id);return {id,state:'stopped'};
  }
  async start({workspace,directory='.',port=0,sandboxExecutable,signal}){
    const perform=async()=>{
      const folder=previewFolder(workspace,directory);workspace=folder.workspace;
      if(!Number.isInteger(port)||port!==0&&(port<1024||port>65535))throw fail('预览端口应为 0 或 1024～65535');
      if(signal?.aborted)throw canceled();
      const rows=await this.rows(workspace),existing=rows.find(row=>['running','starting','unknown'].includes(row.state)&&toolPathKey(row.root)===toolPathKey(folder.root)&&(port===0||row.port===port));
      if(existing){const {_spec,...row}=existing;if(row.state!=='running')throw fail('现有预览尚未就绪，请查看状态或停止后重试',409);return {...row,ok:true,reused:true};}
      const request=previewLaunch({...folder,port,sandboxExecutable,dataDir:this.dataDir,nonce:randomBytes(16).toString('hex')});
      const launched=await this.apps.start(request,{workspace,signal});
      if(!launched.ok)throw fail('预览启动失败：'+redact(launched.stderr||launched.stdout||'进程已退出').slice(-1600));
      const id=launched.application.id;let ready=false;
      try{
        for(let i=0;i<60;i++){
          if(signal?.aborted)throw canceled();
          const row=(await this.list(workspace)).find(row=>row.id===id);
          if(row?.state==='running'){ready=true;return {...row,ok:true,reused:false};}
          if(row&&['exited','error','stopped'].includes(row.state))break;
          await wait(100);
        }
        const logs=await readFile(join(this.apps.directory(id),'stderr.log'),'utf8').catch(()=>'');
        throw fail('预览没有通过本机连接检查：'+redact(logs).slice(-1600));
      }finally{if(!ready)await this.apps.stop(workspace,id);}
    };
    const pending=this.queue.then(perform);this.queue=pending.catch(()=>{});return pending;
  }
}
const managers=new Map();
export function previewManager(dataDir){const key=toolPathKey(dataDir);if(!managers.has(key))managers.set(key,new PreviewManager(dataDir));return managers.get(key);}

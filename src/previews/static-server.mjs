// Fixed static-file service. It also runs inside a read-only MXC filesystem
// sandbox, so a project cannot turn a junction race into access outside its root.
import {createServer} from 'node:http';
import {open,realpath,stat as statPath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep,extname} from 'node:path';

const HEALTH='/.starport-preview-health';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.mp4':'video/mp4','.webm':'video/webm','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'};
const key=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
const inside=(value,root)=>{const r=relative(key(root),key(value));return !r||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
function fileParts(value){
  const path=decodeURIComponent(value.split(/[?#]/)[0]);
  if(/[\\\0\x00-\x1f<>:"|?*]/.test(path))throw Object.assign(Error('Forbidden path'),{status:403});
  const parts=path.split('/').filter(Boolean);
  if(parts.some(part=>part.startsWith('.')||/[. ]$/.test(part)||/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)))throw Object.assign(Error('Forbidden path'),{status:403});
  return {path,parts};
}
export async function createStaticPreview({root,port=0,nonce,blockedPaths=[]}){
  const canonical=await realpath(root);
  if(key(canonical)!==key(root)||typeof nonce!=='string'||!/^[a-f0-9]{32}$/.test(nonce)||!Array.isArray(blockedPaths)||blockedPaths.some(path=>typeof path!=='string'||!isAbsolute(path)||inside(canonical,path)))throw Error('Invalid preview specification');
  const server=createServer((req,res)=>void handle(req,res));
  server.headersTimeout=10000;server.requestTimeout=10000;server.keepAliveTimeout=1000;
  const send=(req,res,status,text,headers={})=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(req.method==='HEAD'?undefined:text);};
  async function handle(req,res){
    let file;
    try{
      const actualPort=server.address().port,origins=[`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`];
      if(!origins.includes('http://'+req.headers.host)||req.headers.origin&&!origins.includes(req.headers.origin)){send(req,res,403,'Forbidden');return;}
      if(!['GET','HEAD'].includes(req.method)){send(req,res,405,'Method not allowed',{Allow:'GET, HEAD'});return;}
      if(req.url===HEALTH){send(req,res,200,JSON.stringify({nonce}),{'Content-Type':'application/json'});return;}
      if(key(await realpath(root))!==key(canonical)){send(req,res,403,'Preview folder changed');return;}
      const {path,parts}=fileParts(req.url||'/');
      let target=await realpath(resolve(root,...parts));
      if(!inside(target,canonical)||blockedPaths.some(path=>inside(target,path))){send(req,res,403,'Forbidden');return;}
      let stat=await statPath(target);
      if(stat.isDirectory()){
        if(!path.endsWith('/')){send(req,res,308,'',{'Location':encodeURI(path+'/')+((req.url||'').includes('?')?'?'+req.url.split('?')[1]:'')});return;}
        target=await realpath(resolve(target,'index.html'));
        if(!inside(target,canonical)||blockedPaths.some(path=>inside(target,path))){send(req,res,403,'Forbidden');return;}
      }
      file=await open(target,'r');stat=await file.stat();
      if(!stat.isFile()){send(req,res,404,'Not found');return;}
      let start=0,end=stat.size-1,status=200;
      const headers={'Content-Type':MIME[extname(target).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
      if(req.headers.range){
        const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if(!match||!match[1]&&!match[2]||!stat.size){send(req,res,416,'Invalid range',{'Content-Range':'bytes */'+stat.size});return;}
        if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}
        else start=Math.max(0,stat.size-Number(match[2]));
        if(start>end||start>=stat.size||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)){send(req,res,416,'Invalid range',{'Content-Range':'bytes */'+stat.size});return;}
        status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length']=String(Math.max(0,end-start+1));res.writeHead(status,headers);
      if(req.method==='HEAD'||stat.size===0){res.end();return;}
      const stream=file.createReadStream({start,end,autoClose:true});file=null;
      stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
    }catch(error){
      if(!res.headersSent)send(req,res,error.status||(['ENOENT','ENOTDIR','EISDIR'].includes(error.code)?404:['EACCES','EPERM'].includes(error.code)?403:400),'Preview request failed');
      else res.destroy();
    }finally{await file?.close().catch(()=>{});}
  }
  await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',no);ok();});});
  return server;
}

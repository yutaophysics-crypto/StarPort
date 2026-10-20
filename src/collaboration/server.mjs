import { createServer,request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollaborationStore,fail } from './store.mjs';
import { accountUrl,AccountVerifier } from '../accounts/protocol.mjs';

const ROOT=resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function collaborationUrl(value){let url;try{url=new URL(value);}catch{throw fail('群聊服务地址无效');}if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['http:','https:'].includes(url.protocol))throw fail('服务地址应为不含路径和密码的 HTTP(S) 地址');if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw fail('远程群聊服务必须使用 HTTPS');return url.origin;}
const cookieToken=req=>String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('starport_session='))?.slice(17)||'';
async function body(req,max=60000){let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>max)throw fail('请求内容过长',413);chunks.push(chunk);}let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail('请求格式无效');}if(!result||typeof result!=='object'||Array.isArray(result))throw fail('请求格式无效');return result;}
const assetTypes={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
export function createCollaborationHub({root=ROOT,dataDir=join(root,'.data/collaboration'),host='127.0.0.1',port=3218,publicUrl=null,allowRegistration=true,eventsTransport='sse',clock,accountCenter=null,accountBackend=null,verifier:customVerifier}={}){
  if(publicUrl)publicUrl=collaborationUrl(publicUrl);
  if(!['sse','poll'].includes(eventsTransport))throw Error('STARPORT_COLLAB_EVENTS must be sse or poll');
  if(!['127.0.0.1','localhost','::1'].includes(host)&&!publicUrl?.startsWith('https://'))throw Error('A public listener requires an explicit HTTPS STARPORT_PUBLIC_URL');
  const store=new CollaborationStore(join(dataDir,'collaboration.sqlite'),{clock}),clients=new Set(),limits=new Map();
  if(accountCenter)accountCenter=accountUrl(accountCenter);
  if(accountBackend){const backend=new URL(accountBackend);if(backend.protocol!=='http:'||backend.hostname!=='127.0.0.1'||backend.pathname!=='/'||backend.search||backend.hash||backend.username||backend.password)throw Error('账号中心转发仅支持已配置的本机服务');accountBackend=backend.origin;}
  const verifier=accountCenter?(customVerifier||new AccountVerifier(accountCenter,{clock})):null;
  const origin=()=>publicUrl||`http://127.0.0.1:${server.address()?.port||port}`;
  const notify=()=>{for(const client of clients){if(client.writableLength>128000){client.destroy();clients.delete(client);}else client.write('event: change\ndata: {}\n\n');}};
  const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const rate=(key,max,window=60000)=>{const time=Date.now(),old=limits.get(key);if(!old||old.expires<time)limits.set(key,{count:1,expires:time+window});else if(++old.count>max)throw fail('操作过于频繁，请稍后再试',429);if(limits.size>10000)for(const [key,value] of limits)if(value.expires<time)limits.delete(key);};
  const setSession=(res,result)=>res.setHeader('Set-Cookie',`starport_session=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${origin().startsWith('https:')?'; Secure':''}`);
  const selectGroup=async(user,roomId)=>{store.member(user.id,roomId);const token=store.selectionToken(user);if(!accountCenter||!token)return {synced:false};const issuer=new URL(accountCenter),payload=JSON.stringify({userId:user.id,server:origin(),roomId}),headers={Origin:issuer.origin,Authorization:'Bearer '+token,'Content-Type':'application/json'};
    try{let status;if(accountBackend){status=await new Promise((ok,no)=>{const req=httpRequest(accountBackend+issuer.pathname+'/api/last-group',{method:'PUT',headers:{...headers,Host:issuer.host},timeout:8000},reply=>{reply.resume();reply.on('end',()=>ok(reply.statusCode));});req.on('error',no);req.on('timeout',()=>req.destroy(Error('Selection timeout')));req.end(payload);});}else{const reply=await fetch(accountCenter+'/api/last-group',{method:'PUT',headers,body:payload,redirect:'error',signal:AbortSignal.timeout(8000)});status=reply.status;await reply.arrayBuffer();}return {synced:status===200};}catch{return {synced:false};}};
  const centralRequest=async(path,input,token)=>new Promise((ok,no)=>{const issuer=new URL(accountCenter),payload=JSON.stringify(input),request=httpRequest(accountBackend+issuer.pathname+'/api/'+path,{method:'POST',headers:{Host:issuer.host,Origin:issuer.origin,'X-Starport-Native':'1','Content-Type':'application/json',...token?{Authorization:'Bearer '+token}:{}},timeout:12000},reply=>{const chunks=[];let size=0;reply.on('data',part=>{size+=part.length;if(size>16000)request.destroy(fail('账号服务器响应过大',502));else chunks.push(part);});reply.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString());if(reply.statusCode<200||reply.statusCode>=300)throw fail(data.error||'账号登录失败',reply.statusCode);ok(data);}catch(e){no(e);}});reply.on('error',no);});request.on('error',no);request.on('timeout',()=>request.destroy(fail('账号服务器连接超时',504)));request.end(payload);});
  const localAccounts=()=>!!accountBackend&&accountCenter===origin()+'/account';
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      const expected=new URL(origin()),local=`127.0.0.1:${server.address()?.port||port}`;
      if(req.headers.host!==expected.host&&!(req.url==='/health'&&req.headers.host===local)&&!(expected.hostname==='127.0.0.1'&&req.headers.host===`localhost:${expected.port}`))throw fail('服务地址不匹配',403);
      const url=new URL(req.url,origin()),path=url.pathname;
      if(path==='/health'&&req.method==='GET'){json(res,{app:'starport-collaboration',version:'0.3.0',origin:origin(),accountCenter});return;}
      if(accountBackend&&(path==='/account'||path.startsWith('/account/'))){
        const upstream=httpRequest(accountBackend+req.url,{method:req.method,headers:{host:expected.host,...req.headers.cookie?{cookie:req.headers.cookie}:{},...req.headers.origin?{origin:req.headers.origin}:{},...req.headers.authorization?{authorization:req.headers.authorization}:{},...req.headers['content-type']?{'content-type':req.headers['content-type']}:{},...req.headers['x-starport-csrf']?{'x-starport-csrf':req.headers['x-starport-csrf']}:{},...req.headers['x-starport-native']?{'x-starport-native':req.headers['x-starport-native']}:{}},timeout:15000},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)json(res,{error:'账号中心暂时不可用'},503);else res.destroy();});req.pipe(upstream);return;
      }
      if(path.startsWith('/api/')){
        if(req.headers.origin&&req.headers.origin!==origin()&&!(expected.hostname==='127.0.0.1'&&req.headers.origin===`http://localhost:${expected.port}`))throw fail('请求来源无效',403);
        const loginRoute=/^\/api\/auth\/(login|register)$/.exec(path);
        if(path==='/api/auth/config'&&req.method==='GET'){json(res,{accountCenter,localAccounts:localAccounts(),server:origin()});return;}
        if(path==='/api/auth/challenge'&&req.method==='POST'&&verifier){if(req.headers.origin!==origin())throw fail('登录请求需要同源来源',403);rate('challenge:'+req.socket.remoteAddress,30);const challenge=store.challenge();res.setHeader('Set-Cookie',`starport_login=${challenge.client}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=300${origin().startsWith('https:')?'; Secure':''}`);json(res,{nonce:challenge.nonce,accountCenter,server:origin()});return;}
        if(path==='/api/auth/federation'&&req.method==='POST'&&verifier){if(req.headers.origin!==origin())throw fail('登录请求需要同源来源',403);rate('federation:'+req.socket.remoteAddress,30);const {grant}=await body(req,12000),client=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('starport_login='))?.slice(15);const claims=await verifier.verify(grant,origin()),result=store.federationSession(claims,client);setSession(res,result);json(res,{user:result.user,csrf:result.csrf,eventsTransport});return;}
        if(path==='/api/auth/window'&&req.method==='POST'){if(req.headers.origin!==origin())throw fail('窗口请求需要同源来源',403);rate('window:'+req.socket.remoteAddress,30);const {token}=await body(req,1024),result=store.redeemWindow(token,cookieToken(req));setSession(res,result);json(res,{user:result.user,csrf:result.csrf,eventsTransport});return;}
        if(loginRoute&&req.method==='POST'){
          if(verifier&&!localAccounts())throw fail('请在星港账号中心登录；群聊服务器不接收账号密码',409);
          if(!req.headers.origin)throw fail('登录请求需要同源来源',403);rate('auth:'+req.socket.remoteAddress,12);
          if(loginRoute[1]==='register'&&!allowRegistration)throw fail('此服务已关闭新账号注册',403);
          let result;if(localAccounts()){const input=await body(req,4096),identity=await centralRequest(loginRoute[1],input),challenge=store.challenge();try{const proof=await centralRequest('grant',{audience:origin(),nonce:challenge.nonce},identity.token),claims=await verifier.verify(proof.grant,origin());result=store.federationSession(claims,challenge.client);}catch(error){await centralRequest('logout',{},identity.token).catch(()=>{});throw error;}}else result=await store[loginRoute[1]](await body(req,4096));setSession(res,result);json(res,{user:result.user,csrf:result.csrf,eventsTransport},loginRoute[1]==='register'?201:200);return;
        }
        if(path.startsWith('/api/device/')){
          const device=store.device(/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1]);
          rate('device:'+device.id,600);
          if(req.method!=='POST')throw fail('接口方法无效',405);
          if(path==='/api/device/disconnect'){store.revokeDevice(device.user_id,device.id);json(res,{ok:true});notify();return;}
          if(path==='/api/device/poll'){const result=store.poll(device,await body(req,150000));json(res,result);if(result.job)notify();return;}
          const route=/^\/api\/device\/jobs\/([\w-]+)\/(start|updates|actions\/([\w-]+))$/.exec(path);
          if(route){const[,jobId,action,actionId]=route,data=await body(req,action==='updates'?3000000:30000);json(res,action==='start'?store.start(device,jobId,data):action==='updates'?store.update(device,jobId,data):store.acknowledge(device,jobId,actionId,data));notify();return;}
          throw fail('接口不存在',404);
        }
        const token=cookieToken(req),user=store.session(token);
        rate('requests:'+user.id,600);
        if(!['GET','HEAD'].includes(req.method)){if(!req.headers.origin)throw fail('操作需要同源来源',403);store.checkCsrf(user,req.headers['x-starport-csrf']);rate('mutations:'+user.id,120);}
        if(path==='/api/auth/session'&&req.method==='GET'){json(res,{user:{id:user.id,username:user.username,name:user.name},csrf:store.csrf(token),eventsTransport});return;}
        if(path==='/api/auth/logout'&&req.method==='POST'){store.logout(user);res.setHeader('Set-Cookie','starport_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');json(res,{ok:true});return;}
        if(path==='/api/auth/window-ticket'&&req.method==='POST'){const input=await body(req,2048);json(res,store.windowTicket(user.id,input.selectionToken??store.selectionToken(user)));return;}
        if(path==='/api/events'&&req.method==='GET'){
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': connected\n\n');clients.add(res);
          const timer=setInterval(()=>{try{store.session(token);res.write(': keepalive\n\n');}catch{res.destroy();}},15000);timer.unref();res.on('close',()=>{clearInterval(timer);clients.delete(res);});return;
        }
        if(path==='/api/state'&&req.method==='GET'){json(res,{...store.state(user),csrf:store.csrf(token)});return;}
        let result,status=200;
        if(path==='/api/rooms'&&req.method==='POST'){result=store.createRoom(user.id,await body(req));status=201;}
        else if(path==='/api/rooms/join'&&req.method==='POST')result=store.join(user.id,await body(req));
        else if(path==='/api/devices'&&req.method==='POST'){result=store.registerDevice(user.id,await body(req));status=201;}
        else if(path==='/api/binding'&&req.method==='PUT')result=store.bind(user.id,await body(req));
        else{
          const room=/^\/api\/rooms\/([\w-]+)(?:\/(messages|invites|invoke|restore|select|members\/([\w-]+)))?$/.exec(path);
          const job=/^\/api\/jobs\/([\w-]+)(?:\/(actions))?$/.exec(path),device=/^\/api\/devices\/([\w-]+)$/.exec(path);
          if(room){const[,roomId,action,target]=room;
            if(!action&&req.method==='GET'){json(res,store.room(user.id,roomId));return;}
            if(action==='messages'&&req.method==='GET'){json(res,store.messagePage(user.id,roomId,{after:url.searchParams.get('after')||0,before:url.searchParams.get('before')||0,limit:url.searchParams.get('limit')||100}));return;}
            if(!action&&req.method==='PUT')result=store.updateRoom(user.id,roomId,await body(req,16000));
            else if(!action&&req.method==='DELETE')result=store.dissolveRoom(user.id,roomId,await body(req,1024));
            else if(action==='restore'&&req.method==='POST')result=store.restoreRoom(user.id,roomId);
            else if(action==='select'&&req.method==='POST'){json(res,await selectGroup(user,roomId));return;}
            else if(action==='messages'&&req.method==='POST')result=store.send(user.id,roomId,await body(req,150000));
            else if(action==='invoke'&&req.method==='POST'){result=store.invoke(user.id,roomId,await body(req,150000));status=202;}
            else if(action==='invites'&&req.method==='POST'){result=store.invite(user.id,roomId);result.url=origin()+'/?invite='+encodeURIComponent(result.token);}
            else if(action==='invites'&&(req.method==='GET'||req.method==='PUT')){result=store.invitePolicy(user.id,roomId,req.method==='PUT'?await body(req,4096):undefined);result.server=origin();result.url=result.token?origin()+'/?invite='+encodeURIComponent(result.token):null;}
            else if(action==='invites'&&req.method==='DELETE'){store.revokeInvites(user.id,roomId);result={ok:true};}
            else if(target&&req.method==='DELETE'){store.removeMember(user.id,roomId,target);result={ok:true};}
          }else if(job){if(!job[2]&&req.method==='GET'){json(res,store.job(user.id,job[1]));return;}if(job[2]&&req.method==='POST'){result=store.action(user.id,job[1],await body(req));status=202;}}
          else if(device&&req.method==='DELETE'){store.revokeDevice(user.id,device[1]);result={ok:true};}
        }
        if(result===undefined)throw fail('接口不存在',404);json(res,result,status);notify();return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw fail('接口方法无效',405);
      const assets={
        '/':['index.html','text/html; charset=utf-8'],
        '/manifest.webmanifest':['manifest.webmanifest',assetTypes['.webmanifest']],
        '/sw.js':['sw.js',assetTypes['.js']],
        '/mobile/app.js':['app.js',assetTypes['.js']],
        '/mobile/invitation.js':['invitation.js',assetTypes['.js']],
        '/mobile/composer.js':['composer.js',assetTypes['.js']],
        '/mobile/style.css':['style.css',assetTypes['.css']],
        '/mobile/icon.svg':['icon.svg',assetTypes['.svg']],
        '/mobile/icon-192.png':['icon-192.png',assetTypes['.png']],
        '/mobile/icon-512.png':['icon-512.png',assetTypes['.png']],
        '/mobile/icon-180.png':['icon-180.png',assetTypes['.png']],
      };
      if(path==='/vendor/marked.min.js'||path==='/vendor/purify.min.js'){
        const file=path.includes('marked')?join(root,'public/vendor/marked.min.js'):join(root,'node_modules/dompurify/dist/purify.min.js');res.writeHead(200,{'Content-Type':assetTypes['.js'],'Cache-Control':'no-cache'});res.end(await readFile(file));return;
      }
      const asset=assets[path];if(!asset)throw fail('页面不存在',404);
      const content=await readFile(join(root,'public/mobile',asset[0]));res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache',...path==='/sw.js'?{'Service-Worker-Allowed':'/'}:{}});res.end(req.method==='HEAD'?undefined:content);
    }catch(error){if(!res.headersSent)json(res,{error:error.status?error.message:'服务暂时不可用，请稍后重试'},error.status||500);else res.destroy();}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  const janitor=setInterval(()=>{store.expire();notify();},15000);janitor.unref();
  return {server,store,origin,notify,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});return server.address().port;},async close(){clearInterval(janitor);for(const client of clients)client.destroy();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const hub=createCollaborationHub({host:process.env.STARPORT_COLLAB_HOST||'127.0.0.1',port:Number(process.env.STARPORT_COLLAB_PORT||3218),publicUrl:process.env.STARPORT_PUBLIC_URL||null,dataDir:process.env.STARPORT_COLLAB_DATA||join(ROOT,'.data/collaboration'),allowRegistration:process.env.STARPORT_ALLOW_REGISTRATION!=='false',eventsTransport:process.env.STARPORT_COLLAB_EVENTS||'sse',accountCenter:process.env.STARPORT_ACCOUNT_URL||null,accountBackend:process.env.STARPORT_ACCOUNT_BACKEND||null,...process.env.STARPORT_ACCOUNT_PUBLIC_KEY?{verifier:new AccountVerifier(process.env.STARPORT_ACCOUNT_URL,{publicKeyFile:process.env.STARPORT_ACCOUNT_PUBLIC_KEY})}:{}});
  hub.listen().then(()=>console.log('Starport group service: '+hub.origin())).catch(error=>{console.error(error.message);process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>hub.close().then(()=>process.exit(0)));
}

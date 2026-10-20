import { createServer } from 'node:http';
import { writeFileSync,readFileSync,existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createPublicKey,timingSafeEqual } from 'node:crypto';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountStore } from './store.mjs';
import { accountUrl,signingKey,loginGrant } from './protocol.mjs';
import { collaborationUrl } from '../collaboration/server.mjs';
import { fail } from '../collaboration/store.mjs';
const ROOT=resolve(import.meta.dirname,'../..');
export async function jsonBody(req,max=8192){let size=0;const parts=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw fail('请求内容过长',413);parts.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(parts).toString()||'{}');}catch{throw fail('请求格式无效');}if(!value||typeof value!=='object'||Array.isArray(value))throw fail('请求格式无效');return value;}
const equal=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);};
export function createAccountHub({root=ROOT,dataDir=join(root,'.data/accounts'),host='127.0.0.1',port=3217,publicUrl=null,allowRegistration=true,clock=Date.now}={}){
  if(publicUrl)publicUrl=accountUrl(publicUrl);if(!['127.0.0.1','localhost','::1'].includes(host)&&!publicUrl?.startsWith('https://'))throw Error('账号中心公开监听需要 HTTPS 地址');
  const store=new AccountStore(join(dataDir,'accounts.sqlite'),{clock}),key=signingKey(join(dataDir,'signing-key.pem')),limits=new Map();
  writeFileSync(join(dataDir,'public-key.pem'),createPublicKey(key).export({format:'pem',type:'spki'}),{mode:0o600});
  const registrationAllowed=()=>{const file=join(dataDir,'server-policy.json');if(!existsSync(file))return allowRegistration;try{return JSON.parse(readFileSync(file,'utf8')).allowRegistration===true;}catch{return false;}};
  const origin=()=>publicUrl||'http://127.0.0.1:'+server.address()?.port+'/account';
  const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const rate=(who)=>{const time=Date.now(),old=limits.get(who);if(!old||old.until<=time)limits.set(who,{n:1,until:time+60000});else if(++old.n>12)throw fail('登录操作过于频繁，请稍后再试',429);if(limits.size>10000)for(const [k,v] of limits)if(v.until<=time)limits.delete(k);};
  const server=createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{const base=new URL(origin()),path=new URL(req.url,base).pathname,local='127.0.0.1:'+server.address()?.port;if(req.headers.host!==base.host&&!(path==='/health'&&req.headers.host===local))throw fail('账号中心地址不匹配',403);
      if(path==='/health'&&req.method==='GET'){json(res,{app:'starport-accounts',issuer:origin()});return;}
      if(path==='/account/public-key'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'public, max-age=300'});res.end(createPublicKey(key).export({format:'pem',type:'spki'}));return;}
      if(path.startsWith('/account/api/')){if(req.headers.origin&&req.headers.origin!==base.origin)throw fail('账号请求来源无效',403);const action=path.slice('/account/api/'.length),native=req.headers['x-starport-native']==='1';
        if(action==='last-group'&&req.method==='PUT'){if(req.headers.origin!==base.origin)throw fail('访问记录请求来源无效',403);const scopedToken=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];if(!scopedToken)throw fail('访问记录授权无效',401);const input=await jsonBody(req,2048);json(res,store.selectGroup(scopedToken,{...input,server:collaborationUrl(input.server)}));return;}
        if(['login','register'].includes(action)&&req.method==='POST'){if(req.headers.origin!==base.origin)throw fail('登录请求需要同源来源',403);rate(req.socket.remoteAddress);if(action==='register'&&!registrationAllowed())throw fail('账号中心已关闭新账号注册',403);const result=await store[action](await jsonBody(req));
          res.setHeader('Set-Cookie',`starport_account=${result.token}; HttpOnly; SameSite=Lax; Path=/account; Max-Age=2592000${base.protocol==='https:'?'; Secure':''}`);
          json(res,{user:result.user,csrf:result.csrf,...native?{token:result.token}:{}},action==='register'?201:200);return;}
        const bearer=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1],cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('starport_account='))?.slice(17),token=native?bearer:cookie,user=store.session(token);
        if(req.method!=='GET'){if(req.headers.origin!==base.origin)throw fail('账号操作需要同源来源',403);if(!native&&!equal(req.headers['x-starport-csrf'],store.csrf(token)))throw fail('请求已失效，请刷新后重试',403);}
        if(action==='session'&&req.method==='GET'){json(res,{user:{id:user.id,username:user.username,name:user.name},csrf:store.csrf(token)});return;}
        if(action==='servers'&&req.method==='GET'){json(res,{servers:store.db.prepare('SELECT origin AS server FROM servers WHERE user_id=? ORDER BY created').all(user.id)});return;}
        if(action==='last-group'&&req.method==='GET'){json(res,{lastGroup:store.lastGroup(user.id)});return;}
        if(action==='selection-token'&&req.method==='POST'){const {server}=await jsonBody(req,1024);json(res,{selectionToken:store.selectionToken(user,collaborationUrl(server))});return;}
        if(action==='logout'&&req.method==='POST'){store.logout(user);res.setHeader('Set-Cookie',`starport_account=; HttpOnly; SameSite=Lax; Path=/account; Max-Age=0${base.protocol==='https:'?'; Secure':''}`);json(res,{ok:true});return;}
        if(action==='grant'&&req.method==='POST'){const {audience,nonce}=await jsonBody(req);const serverOrigin=collaborationUrl(audience);if(!/^[A-Za-z0-9_-]{43}$/.test(nonce||''))throw fail('登录验证无效');if(store.db.prepare('SELECT count(*) AS n FROM servers WHERE user_id=?').get(user.id).n>=100&&!store.db.prepare('SELECT 1 FROM servers WHERE user_id=? AND origin=?').get(user.id,serverOrigin))throw fail('最多连接 100 个群聊服务器');store.db.prepare('INSERT OR IGNORE INTO servers VALUES(?,?,?)').run(user.id,serverOrigin,clock());json(res,{grant:loginGrant(key,{issuer:origin(),audience:serverOrigin,user,nonce,selectionToken:store.selectionToken(user,serverOrigin),clock})});return;}
        throw fail('账号接口不存在',404);
      }
      if(!['GET','HEAD'].includes(req.method))throw fail('接口方法无效',405);
      const assets={'/account':['index.html','text/html; charset=utf-8'],'/account/':['index.html','text/html; charset=utf-8'],'/account/app.js':['app.js','text/javascript; charset=utf-8'],'/account/style.css':['style.css','text/css; charset=utf-8'],'/account/icon.svg':['../mobile/icon.svg','image/svg+xml']},asset=assets[path];if(!asset)throw fail('页面不存在',404);
      res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:await readFile(join(root,'public/account',asset[0])));
    }catch(e){if(!res.headersSent)json(res,{error:e.status?e.message:'账号中心暂时不可用，请稍后重试'},e.status||500);else res.destroy();}
  });server.requestTimeout=30000;server.headersTimeout=15000;const timer=setInterval(()=>store.expire(),60000);timer.unref();
  return {server,store,key,origin,async listen(){await new Promise((ok,no)=>{server.once('error',no);server.listen(port,host,ok);});return server.address().port;},async close(){clearInterval(timer);server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const hub=createAccountHub({port:Number(process.env.STARPORT_ACCOUNT_PORT||3217),publicUrl:process.env.STARPORT_ACCOUNT_URL||null,dataDir:process.env.STARPORT_ACCOUNT_DATA||join(ROOT,'.data/accounts'),allowRegistration:process.env.STARPORT_ALLOW_REGISTRATION!=='false'});hub.listen().then(()=>console.log('Starport account center: '+hub.origin())).catch(e=>{console.error(e.message);process.exitCode=1;});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>hub.close().then(()=>process.exit(0)));}

import { randomBytes,timingSafeEqual } from 'node:crypto';
import { readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { savePrivateJSON } from './collaboration/desktop.mjs';
import { fail } from './collaboration/store.mjs';
const secret=()=>randomBytes(32).toString('base64url'),equal=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);};
export class GroupWindows {
  constructor({dataDir,profiles,root,defaultServer=()=>''}){Object.assign(this,{profiles,root,defaultServer});this.file=join(dataDir,'group-windows.json');this.windows=new Map();if(existsSync(this.file)){try{for(const w of JSON.parse(readFileSync(this.file,'utf8')).windows||[])if(/^[A-Za-z0-9_-]{43}$/.test(w.id)&&/^[A-Za-z0-9_-]{43}$/.test(w.key))this.windows.set(w.id,w);}catch{}}}
  async save(){const value={windows:[...this.windows.values()].slice(-200)};this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>savePrivateJSON(this.file,value));await this.saving;}
  view(id){const w=this.windows.get(id);if(!w)throw fail('群聊窗口已失效，请从星港重新打开',404);return w;}
  async create(profileId){if(profileId&&!this.profiles.profiles.has(profileId))throw fail('请先登录这个服务器账号',401);const w={id:secret(),key:secret(),profileId:profileId||null,created:Date.now()};this.windows.set(w.id,w);await this.save();return {windowId:w.id};}
  async html(id){const w=this.view(id);let html=readFileSync(join(this.root,'public/mobile/index.html'),'utf8');const meta=Buffer.from(JSON.stringify({id:w.id,key:w.key,base:'/group-windows/'+w.id+'/api'})).toString('base64');return html.replace('<head>','<head>\n<meta name="starport-group-window" content="'+meta+'">');}
  async api(id,key,path,method,body){const w=this.view(id);if(!equal(key,w.key))throw fail('群聊窗口凭证无效',401);const p=w.profileId&&this.profiles.profiles.get(w.profileId);
    if(path==='/auth/config'&&method==='GET')return {desktopWindow:true,accountCenter:null,server:p?.server||w.server||this.defaultServer()||'',username:p?.username||w.username||''};
    if(['/auth/login','/auth/register'].includes(path)&&method==='POST'){const auth=await this.profiles.login(body,path==='/auth/register');w.profileId=auth.profileId;w.server=auth.server;w.username=auth.user.username;await this.save();return {...await this.profiles.auth(w.profileId),csrf:w.key};}
    if(path==='/auth/logout'&&method==='POST'){w.server=p?.server||w.server;w.username=p?.username||w.username;w.profileId=null;await this.save();return {ok:true};}
    if(path==='/windows'&&method==='POST'){const result=await this.create(body?.blank?null:w.profileId);if(body?.blank){this.view(result.windowId).server=p?.server||w.server||'';await this.save();}return result;}
    if(!w.profileId||!p)throw fail('请登录这个窗口的服务器账号',401);
    if(path==='/auth/session'&&method==='GET')return {...await this.profiles.auth(w.profileId),csrf:w.key};
    if(path==='/desktop/info'&&method==='GET'){const client=this.profiles.client(w.profileId);client.requireAccount();const {id,username,name}=client.profile.user;return {user:{id,username,name},server:p.server};}
    if(path==='/desktop/bind'&&method==='POST')return this.profiles.bind(w.profileId,body);
    if(path==='/desktop/connection'&&method==='GET'){const client=this.profiles.client(w.profileId);return {connection:client.desktopLink.connection(p.server)};}
    if(path==='/desktop/disconnect'&&method==='POST')return this.profiles.client(w.profileId).desktopLink.disconnect(p.server);
    if(!/^\/(?:state|rooms(?:\/[\w-]+(?:\/(?:messages|select|invites|invoke|restore|members\/[\w-]+))?)?|devices(?:\/[\w-]+)?|binding|jobs(?:\/[\w-]+(?:\/actions)?)?)?(?:\?.*)?$/.test(path))throw fail('这个接口不能从群聊窗口访问',404);
    const data=await this.profiles.group(w.profileId,path,method,body);if(data&&typeof data==='object'&&!Array.isArray(data)&&data.csrf)data.csrf=w.key;return data;
  }
}

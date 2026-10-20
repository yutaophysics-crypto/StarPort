import { existsSync,readFileSync,mkdirSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { accountUrl } from './protocol.mjs';
import { collaborationUrl } from '../collaboration/server.mjs';
import { savePrivateJSON } from '../collaboration/desktop.mjs';
import { fail } from '../collaboration/store.mjs';

export async function serviceRequest(base,path,{method='GET',body,cookie,csrf,token,native=false}={}){
  let response;
  try{
    response=await fetch(base+path,{method,redirect:'error',signal:AbortSignal.timeout(12000),headers:{Origin:new URL(base).origin,...cookie?{Cookie:cookie}:{},...csrf?{'X-Starport-CSRF':csrf}:{},...token?{Authorization:'Bearer '+token}:{},...native?{'X-Starport-Native':'1'}:{},...body!==undefined?{'Content-Type':'application/json'}:{}},body:body===undefined?undefined:JSON.stringify(body)});
  }catch(error){
    const origin=(()=>{try{return new URL(base).origin;}catch{return base;}})();
    if(error?.name==='TimeoutError'||error?.name==='AbortError')throw fail(`连接服务器超时（${origin}），请检查网络或服务器状态`,504);
    throw fail(`无法连接到服务器（${origin}），请检查服务器地址是否有效且服务已启动`,502);
  }
  let data;try{data=await response.json();}catch{throw fail('服务返回了无法识别的内容',502);}if(!response.ok)throw fail(data.error||'连接失败',response.status);return {data,response};
}
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
export class DesktopAccount {
  constructor({issuer,dataDir,desktopLink,request=serviceRequest}){this.request=request;this.issuer=issuer?accountUrl(issuer):null;this.dataDir=dataDir;this.desktopLink=desktopLink;this.file=join(dataDir,'account-session.json');this.groupFile=join(dataDir,'account-groups.json');const profile=read(this.file);this.profile=profile?.issuer===this.issuer?profile:null;this.entries=new Map((read(this.groupFile)?.entries||[]).filter(e=>e.issuer===this.issuer&&e.user?.id===this.profile?.user?.id).map(e=>[e.server,e]));this.busy=false;}
  status(){return {enabled:!!this.issuer,url:this.issuer,user:this.profile?.user||null};}
  async account(path,method='GET',body){if(!this.issuer)throw fail('尚未配置星港账号中心');return this.request(this.issuer,'/api/'+path,{method,body,token:this.profile?.token,native:true});}
  async login(input,register=false){if(this.busy)throw fail('正在登录，请稍后再试');this.busy=true;try{const {data}=await this.account(register?'register':'login','POST',input);const profile={issuer:this.issuer,user:data.user,token:data.token};if(!profile.token)throw fail('账号中心没有返回有效登录凭证',502);mkdirSync(this.dataDir,{recursive:true});await savePrivateJSON(this.file,profile);if((this.profile&&this.profile.user.id!==profile.user.id)||[...this.desktopLink.links.values()].some(l=>l.user.id!==profile.user.id)){await this.desktopLink.disconnectAll();this.entries.clear();}this.profile=profile;await this.saveGroups();return this.status();}finally{this.busy=false;}}
  async logout(){if(this.profile)await this.account('logout','POST',{}).catch(()=>{});await this.desktopLink.disconnectAll();if(existsSync(this.file))unlinkSync(this.file);if(existsSync(this.groupFile))unlinkSync(this.groupFile);this.profile=null;this.entries.clear();return this.status();}
  async saveGroups(){await savePrivateJSON(this.groupFile,{entries:[...this.entries.values()]});}
  requireAccount(){if(!this.profile)throw fail('请先登录星港账号',401);}
  async authorize(server){this.requireAccount();server=collaborationUrl(server);const {data:health}=await this.request(server,'/health');if(health.app!=='starport-collaboration'||health.origin!==server)throw fail('这不是所填写地址的星港群聊服务器');if(health.accountCenter!==this.issuer)throw fail('此群聊服务器尚未连接到你登录的星港账号中心');
    const challenge=await this.request(server,'/api/auth/challenge',{method:'POST',body:{}}),cookie=challenge.response.headers.getSetCookie().find(c=>c.startsWith('starport_login='))?.split(';')[0];if(!cookie)throw fail('群聊服务器未返回登录验证信息',502);
    const {data:proof}=await this.account('grant','POST',{audience:server,nonce:challenge.data.nonce});const login=await this.request(server,'/api/auth/federation',{method:'POST',body:{grant:proof.grant},cookie});const session=login.response.headers.getSetCookie().find(c=>c.startsWith('starport_session='))?.split(';')[0];if(!session||login.data.user.id!==this.profile.user.id)throw fail('群聊服务器返回的账号身份不匹配',502);
    const entry={issuer:this.issuer,server,cookie:session,csrf:login.data.csrf,user:login.data.user};this.entries.set(server,entry);await this.saveGroups();return entry;
  }
  async group(server,path,method='GET',body){this.requireAccount();server=collaborationUrl(server);let entry=this.entries.get(server)||await this.authorize(server);try{return (await this.request(server,'/api'+path,{method,body,cookie:entry.cookie,csrf:entry.csrf})).data;}catch(e){if(e.status!==401)throw e;entry=await this.authorize(server);return (await this.request(server,'/api'+path,{method,body,cookie:entry.cookie,csrf:entry.csrf})).data;}}
  async groups(){if(!this.profile)return [];let directory=[];try{directory=(await this.account('servers')).data.servers;}catch{}const known=new Set([...this.entries.keys(),...this.desktopLink.links.keys(),...directory.map(e=>e.server)]);return Promise.all([...known].map(async server=>{try{const result=await this.group(server,'/state');return {server,rooms:result.rooms,connected:this.desktopLink.connection(server),error:''};}catch(e){return {server,rooms:[],error:e.status===401?'账号登录已失效，请重新登录':e.message};}}));}
  async join({server,token}){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token.trim()))throw fail('请复制完整邀请码');const room=await this.group(server,'/rooms/join','POST',{token:token.trim()});return {server:collaborationUrl(server),room};}
  async create({server,name}){const room=await this.group(server,'/rooms','POST',{name});return {server:collaborationUrl(server),room};}
  async lastGroup(){this.requireAccount();return (await this.account('last-group')).data;}
  async window({server,roomId}){server=collaborationUrl(server);if(roomId){if(!/^[a-f0-9-]{36}$/.test(roomId))throw fail('群聊标识无效');await this.group(server,'/rooms/'+roomId);}else await this.group(server,'/auth/session');const {data:scope}=await this.account('selection-token','POST',{server});const result=await this.group(server,'/auth/window-ticket','POST',{selectionToken:scope.selectionToken});return {server,launchCode:result.token,...roomId?{roomId}:{}};}
  async invite({server,roomId,changes}){if(typeof roomId!=='string'||!/^[\w-]+$/.test(roomId))throw fail('群聊标识无效');return this.group(server,'/rooms/'+roomId+'/invites',changes===undefined?'GET':'PUT',changes);}
  async bind(input){this.requireAccount();const server=collaborationUrl(input.hubUrl);await this.group(server,'/state');return this.desktopLink.connectSession({...input,hubUrl:server,session:this.entries.get(server)});}
}

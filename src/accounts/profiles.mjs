import { createHash } from 'node:crypto';
import { existsSync,readFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopAccount,serviceRequest } from './desktop.mjs';
import { DesktopLink,savePrivateJSON } from '../collaboration/desktop.mjs';
import { collaborationUrl } from '../collaboration/server.mjs';
import { fail } from '../collaboration/store.mjs';
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
export class DesktopProfiles {
  constructor({dataDir,registry,implementations,onChange=()=>{},legacyLink,request=serviceRequest}) {
    Object.assign(this,{dataDir,registry,implementations,onChange,legacyLink,request});this.file=join(dataDir,'account-profiles.json');this.profiles=new Map();this.clients=new Map();this.busy=new Set();
    const saved=read(this.file);this.lastProfile=saved?.lastProfile||null;
    for(const p of saved?.profiles||[]){try{if(!/^[a-f0-9]{32}$/.test(p.id)||!p.username)continue;p.server=collaborationUrl(p.server);this.profiles.set(p.id,p);}catch{}}
  }
  key(server,username){return createHash('sha256').update(server+'\0'+username).digest('hex').slice(0,32);}
  client(id){const p=this.profiles.get(id);if(!p)throw fail('这个服务器账号尚未登录',401);if(this.clients.has(id))return this.clients.get(id);
    const directory=join(this.dataDir,'server-accounts',id);mkdirSync(directory,{recursive:true,mode:0o700});const bridge=p.legacy&&this.legacyLink?this.legacyLink:new DesktopLink({registry:this.registry,dataDir:directory,implementations:this.implementations,onChange:this.onChange,transport:(base,path,options)=>this.request(base,path,{method:'POST',...options})});
    const client=new DesktopAccount({issuer:p.server+'/account',dataDir:directory,desktopLink:bridge,request:this.request});this.clients.set(id,client);return client;
  }
  async save(){const value={lastProfile:this.lastProfile,profiles:[...this.profiles.values()].map(p=>({...p}))};this.saving=(this.saving||Promise.resolve()).catch(()=>{}).then(()=>savePrivateJSON(this.file,value));await this.saving;}
  async migrate(){if(existsSync(this.file))return;const old=read(join(this.dataDir,'account-session.json'));if(!old?.token||!old.user?.username||!old.issuer)return;
    const issuer=new URL(old.issuer);if(issuer.pathname!=='/account')return;const server=collaborationUrl(issuer.origin),id=this.key(server,old.user.username),p={id,server,username:old.user.username,user:old.user,legacy:true},directory=join(this.dataDir,'server-accounts',id);mkdirSync(directory,{recursive:true,mode:0o700});
    await savePrivateJSON(join(directory,'account-session.json'),old);const previous=read(join(this.dataDir,'account-groups.json'));await savePrivateJSON(join(directory,'account-groups.json'),{entries:(previous?.entries||[]).filter(e=>e.server===server&&e.user?.id===old.user.id)});this.profiles.set(id,p);this.lastProfile=id;await this.save();
  }
  async resume(){await this.migrate();for(const p of this.profiles.values()){const c=this.client(p.id);if(!p.legacy)c.desktopLink.resume().catch(()=>{});}}
  status(){return {lastProfile:this.lastProfile,profiles:[...this.profiles.values()].map(p=>({...p,legacy:undefined,connection:this.client(p.id).desktopLink.connection(p.server)}))};}
  async login({server,username,password,name},register=false){server=collaborationUrl(server);if(typeof username!=='string'||!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username.trim().toLowerCase()))throw fail('账号使用 3–64 位字母、数字、点、下划线或短横线');username=username.trim().toLowerCase();const id=this.key(server,username);if(this.busy.has(id))throw fail('这个账号正在登录，请稍后再试');this.busy.add(id);const existed=this.profiles.has(id);
    try{const {data:health}=await this.request(server,'/health');if(health.app!=='starport-collaboration'||health.origin!==server||health.accountCenter!==server+'/account')throw fail('请填写提供本服务器账号登录的星港服务器地址');
      if(!existed)this.profiles.set(id,{id,server,username});const c=this.client(id);await c.login({username,password,name},register);await c.group(server,'/auth/session');const p=this.profiles.get(id);p.user=c.profile.user;this.lastProfile=id;await this.save();return {profileId:id,server,user:p.user};
    }catch(error){if(!existed){await this.clients.get(id)?.desktopLink.close();this.clients.delete(id);this.profiles.delete(id);}throw error;}finally{this.busy.delete(id);}
  }
  async auth(id){const p=this.profiles.get(id),c=this.client(id);if(!c.profile)throw fail('请重新登录这个服务器账号',401);const state=await c.group(p.server,'/state');if(state.user.id!==p.user.id)throw fail('服务器账号身份不匹配',401);let recent=null;try{recent=(await c.lastGroup()).lastGroup;}catch{}return {user:state.user,server:p.server,profileId:id,eventsTransport:'poll',roomId:recent?.server===p.server&&state.rooms.some(r=>r.id===recent.roomId)?recent.roomId:null};}
  async group(id,path,method='GET',body){const p=this.profiles.get(id),client=this.client(id);let result=await client.group(p.server,path,method,body);if(method==='POST'&&/^\/rooms\/[\w-]+\/select$/.test(path)&&result.synced===false){await client.authorize(p.server);result=await client.group(p.server,path,method,body);}return result;}
  async bind(id,input){const p=this.profiles.get(id);return this.client(id).bind({...input,hubUrl:p.server});}
  async forget(id){const p=this.profiles.get(id);if(!p)throw fail('账号不存在',404);const c=this.client(id);if([...c.desktopLink.workers.values()].some(w=>w.active))throw fail('此账号仍有群聊任务，请等待结束后再退出');await c.desktopLink.disconnect(p.server);await c.account('logout','POST',{}).catch(()=>{});this.clients.delete(id);this.profiles.delete(id);if(this.lastProfile===id)this.lastProfile=[...this.profiles.keys()].at(-1)||null;await this.save();return this.status();}
  async close(){for(const c of this.clients.values())if(c.desktopLink!==this.legacyLink)await c.desktopLink.close();}
}

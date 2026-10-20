import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import {parseVideoReference} from './videos.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
export class EdgeBridge {
  constructor(store){this.store=store;this.pending=new Map();this.queue=[];this.lastSeen=0;this.waiter=null;}
  status(){return {paired:!!this.store.setting('edge-bridge'),connected:Date.now()-this.lastSeen<60000};}
  createPair(){this.pair={code:randomBytes(16).toString('hex'),expires:Date.now()+300000};return {code:this.pair.code,expires:this.pair.expires};}
  pairClient(code,extensionId){
    if(!this.pair||Date.now()>this.pair.expires||!equal(code,this.pair.code)||!this.validId(extensionId))throw new Error('配对码无效或已过期');
    const key=randomBytes(32).toString('hex');this.store.setSetting('edge-bridge',{extensionId,keyHash:hash(key)});this.pair=null;this.lastSeen=Date.now();return {key};
  }
  validId(id){return typeof id==='string'&&/^[a-p]{32}$/.test(id);}
  authorize(key,id){const config=this.store.setting('edge-bridge');return this.validId(id)&&config?.extensionId===id&&typeof key==='string'&&equal(hash(key),config.keyHash);}
  async poll(){
    this.lastSeen=Date.now();
    if(!this.queue.length)await new Promise(resolve=>{this.waiter?.();const timer=setTimeout(done,20000),self=this;function done(){clearTimeout(timer);if(self.waiter===done)self.waiter=null;resolve();}this.waiter=done;});
    const commands=this.queue.splice(0).filter(cmd=>this.pending.has(cmd.id));return {commands};
  }
  request(action,args={},timeout=30000){
    if(!this.status().connected)throw new Error('Edge 尚未连接，请先在扩展中连接星港');
    if(this.pending.size>=4)throw new Error('浏览器正在处理请求，请稍后重试');
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{this.pending.delete(id);this.queue=this.queue.filter(c=>c.id!==id);reject(new Error('Edge 响应超时，请检查扩展连接'));},timeout);
      this.pending.set(id,{resolve,reject,timer});this.queue.push({id,action,...args});this.waiter?.();
    });
  }
  result({id,result,error}){this.lastSeen=Date.now();const pending=this.pending.get(id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(id);error?pending.reject(new Error(String(error).slice(0,1000))):pending.resolve(result);}
  async tabs(){
    const result=await this.request('tabs');if(!Array.isArray(result))throw new Error('浏览器返回的标签页无效');
    return {tabs:result.filter(tab=>Number.isSafeInteger(tab.id)&&/^https?:\/\//.test(tab.url||'')).slice(0,150).map(tab=>({id:tab.id,title:String(tab.title||'').slice(0,240),url:String(tab.url).slice(0,4000)}))};
  }
  async capture(tabId){if(!Number.isSafeInteger(tabId)||tabId<0)throw new Error('请选择一个浏览器标签页');return this.request('capture',{tabId});}
  async video(reference){const {bvid,part}=parseVideoReference(reference);return this.request('video',{bvid,part},60000);}
  close(){this.waiter?.();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('连接已关闭'));}this.pending.clear();}
}

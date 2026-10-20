import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
  constructor(tag){Object.assign(this,{tag,children:[],value:'',open:false,style:{setProperty(){}}});}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];}
  setAttribute(name,value){this[name]=value;}
  addEventListener(name,handler){this['on'+name]=handler;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  querySelector(selector){return descendants(this).find(e=>selector==='button[type=submit]'&&e.tag==='button'&&e.type==='submit');}
  get childNodes(){return this.children;}
}
function descendants(element){return [element,...element.children.flatMap(descendants)];}
function fixture({mode='browser',native=true,profileId='profile-one',fail=false,wait}={}){
 const body=new Element('body'),calls=[],messages=[],popups=[],notices=[],nodes=Object.fromEntries(['collaboration','group-account-settings','settings-dialog'].map(id=>[id,new Element('button')])),url='http://127.0.0.1:3210/group-windows/'+'W'.repeat(43);
 const context={document:{body,createElement:tag=>new Element(tag),getElementById:id=>nodes[id]||null},StarportI18n:{language:'zh'},navigator:{platform:mode==='windows'?'Win32':'MacIntel'},confirm:()=>true,toast:text=>notices.push(text),window:{open(){const p={opener:{},close(){this.closed=true;},location:{replace(value){p.url=value;}}};popups.push(p);return p;}},api:async(path,method,payload)=>{calls.push({path,method,payload});if(path==='/collaboration/windows'){if(wait)await wait;if(fail)throw Error('Cannot create window');return {url,windowId:'W'.repeat(43),windowMode:mode};}if(path==='/collaboration/profiles')return {windowMode:mode,lastProfile:profileId,profiles:profileId?[{id:profileId,server:'https://server.example',username:'alice',user:{name:'Alice'}}]:[]};return {opened:true};},...native?{webkit:{messageHandlers:{starportDesktop:{postMessage:message=>messages.push(message)}}}}:{}};
 for(const file of ['group-account.js','collaboration.js'])runInNewContext(readFileSync(new URL('../public/'+file,import.meta.url),'utf8'),context);return {context,body,calls,messages,popups,notices,nodes,url};
}
test('Mac entry always directly opens a local independent group context, signed in or signed out',async()=>{for(const profileId of ['profile-one',null]){const f=fixture({profileId});await f.context.StarportDesktop.open();assert.equal(f.body.children.length,0);assert.equal(Object.keys(f.calls[0].payload).length,0);assert.equal(f.messages[0].action,'openGroup');assert.equal(f.messages[0].url,f.url);assert.equal(f.messages[0].launchCode,undefined);}});
test('Windows entry requests an application window for its unique local window ID',async()=>{const f=fixture({mode:'windows',native:false});await f.context.StarportDesktop.open();assert.equal(f.popups.length,0);assert.equal(f.calls[1].path,'/collaboration/window');assert.equal(f.calls[1].payload.windowId,'W'.repeat(43));assert.equal(f.body.children.length,0);});
test('browser entry reserves before awaiting creation and closes the popup on failure',async()=>{let release;const wait=new Promise(r=>release=r),f=fixture({native:false,wait});const pending=f.context.StarportDesktop.open();assert.equal(f.popups.length,1);assert.equal(f.popups[0].opener,null);release();await pending;assert.equal(f.popups[0].url,f.url);const bad=fixture({native:false,fail:true});await bad.context.StarportDesktop.open();assert.equal(bad.popups[0].closed,true);assert.deepEqual(bad.notices,['Cannot create window']);});
test('connection management opens a selected profile or a fresh blank login without changing the other profiles',async()=>{const f=fixture();await f.context.StarportDesktop.manage();const list=descendants(f.body),open=list.find(e=>e.textContent==='打开群聊');await open.onclick();assert.equal(f.calls.find(c=>c.path==='/collaboration/windows').payload.profileId,'profile-one');await f.context.StarportDesktop.manage();const fresh=descendants(f.body).find(e=>e.textContent==='登录另一个服务器或账号');await fresh.onclick();assert.equal(f.calls.filter(c=>c.path==='/collaboration/windows').at(-1).payload.profileId,null);});
test('repeated clicks create only one context and restore the entry control',async()=>{let release;const wait=new Promise(r=>release=r),f=fixture({wait}),first=f.context.StarportDesktop.open();await f.context.StarportDesktop.open();assert.equal(f.nodes.collaboration.disabled,true);release();await first;assert.equal(f.messages.length,1);assert.equal(f.nodes.collaboration.disabled,false);});

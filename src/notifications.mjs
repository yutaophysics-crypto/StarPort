import { randomUUID } from 'node:crypto';

// Task-finished notifications. This module decides whether to notify and what
// the popup says; the notifier (notifier-windows.mjs on Windows) draws the
// popup, plays the chime and flashes the taskbar button.
const OPEN_WINDOW_MS=60000,THEMES=['sea','port','deep-space'];
const TEXT={
  zh:{app:'星港',complete:'已完成',error:'出错了',passed:'验收通过',done:'已完成',failed:'运行失败','verify-failed':'验收未通过',
    testTitle:'通知测试',testBody:'任务做完时，星港会这样提醒你。点这里回到对话。',code:'[代码]',formula:'[公式]',errorBody:'任务没有完成'},
  en:{app:'Starport',complete:'Done',error:'Failed',passed:'Verified',done:'Done',failed:'Run failed','verify-failed':'Verification failed',
    testTitle:'Test notification',testBody:'This is how Starport tells you a task is done. Click here to return to the conversation.',code:'[code]',formula:'[formula]',errorBody:'The task did not finish'}
};
const TEX={'\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ','\\epsilon':'ϵ','\\varepsilon':'ε','\\lambda':'λ','\\mu':'μ','\\pi':'π','\\sigma':'σ',
  '\\tau':'τ','\\phi':'φ','\\omega':'ω','\\Delta':'Δ','\\Sigma':'Σ','\\Omega':'Ω','\\times':'×','\\cdot':'·','\\approx':'≈','\\leq':'≤','\\geq':'≥','\\le':'≤','\\ge':'≥','\\neq':'≠','\\to':'→','\\infty':'∞','\\pm':'±'};
const SUPERSCRIPT={'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻','+':'⁺',n:'ⁿ'};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

// A plain-text summary of a Markdown reply, short enough for two popup lines.
export function excerpt(text,limit=120,language='en'){
  const words=TEXT[language]||TEXT.en;
  const plain=String(text||'')
    .replace(/```[\s\S]*?(?:```|$)/g,` ${words.code} `)
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g,` ${words.formula} `)
    .replace(/\$([^$\n]+)\$/g,'$1')
    .replace(/\\[a-zA-Z]+/g,command=>TEX[command]??'')
    .replace(/\^(?:\{([-+]?[0-9n]+)\}|([0-9n]))/g,(_,group,single)=>[...group??single].map(c=>SUPERSCRIPT[c]).join(''))
    .replace(/[{}]/g,'')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/`([^`\n]*)`/g,'$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm,'')
    .replace(/(\*\*|__|~~)(.+?)\1/g,'$2').replace(/\*([^*\n]+)\*/g,'$1')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ').trim();
  const chars=[...plain];
  return chars.length>limit?chars.slice(0,limit-1).join('').trimEnd()+'…':plain;
}

// A soft two-note chime: 16-bit mono WAV, about half a second, well below full scale.
export function chimeWav(rate=44100){
  const notes=[[783.99,0],[1046.5,0.11]],length=Math.round(rate*0.62),data=Buffer.alloc(length*2);
  for(let i=0;i<length;i++){
    const t=i/rate;let value=0;
    for(const[frequency,start]of notes){
      const local=t-start;if(local<0)continue;
      const attack=Math.min(1,local/0.006),decay=Math.exp(-local/0.16);
      value+=attack*decay*(Math.sin(2*Math.PI*frequency*local)+0.18*Math.sin(4*Math.PI*frequency*local));
    }
    const fade=Math.min(1,(length-i)/(rate*0.04));
    data.writeInt16LE(Math.round(Math.max(-1,Math.min(1,value*0.2*fade))*32767),i*2);
  }
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+data.length,4);header.write('WAVE',8);
  header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(data.length,40);
  return Buffer.concat([header,data]);
}

export class Notifications{
  constructor({store,notifier=null,broadcast=()=>{},now=Date.now}){
    Object.assign(this,{store,notifier,broadcast,now});
    this.pages=new Map();this.pending=null;
    const look=store.setting('notifications-look',{})||{};
    this.look={theme:THEMES.includes(look.theme)?look.theme:'sea',language:look.language==='zh'?'zh':'en'};
    if(notifier)notifier.onOpen=event=>this.opened(event);
  }
  get native(){return !!this.notifier?.available;}
  settings(){const saved=this.store.setting('notifications',{})||{};return {enabled:saved.enabled!==false,sound:saved.sound!==false};}
  status(){return {...this.settings(),native:this.native};}
  update(input={}){
    if(!input||typeof input!=='object')throw fail('通知设置无效');
    const next=this.settings();
    for(const key of ['enabled','sound'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='boolean')throw fail('通知设置无效');next[key]=input[key];}
    this.store.setSetting('notifications',next);
    if(!next.enabled)this.notifier?.dismiss?.();
    const status={...next,native:this.native};this.broadcast('notifications',status);
    return status;
  }
  // Pages are counted while their event stream is open, so a closed window
  // never keeps notifications quiet. Reports say what the page is showing.
  connect(client){if(!this.validClient(client))return;const page=this.page(client);page.streams++;}
  disconnect(client){const page=this.pages.get(client);if(page&&--page.streams<=0)this.pages.delete(client);}
  report(client,input={}){
    if(!this.validClient(client))throw fail('页面标识无效');
    const page=this.page(client);
    Object.assign(page,{focused:input.focused===true,visible:input.visible!==false,chatId:typeof input.chatId==='string'&&input.chatId?input.chatId:null,at:this.now()});
    const look={theme:THEMES.includes(input.theme)?input.theme:this.look.theme,language:input.language==='en'?'en':input.language==='zh'?'zh':this.look.language};
    if(look.theme!==this.look.theme||look.language!==this.look.language){this.look=look;this.store.setSetting('notifications-look',look);}
    return {ok:true};
  }
  validClient(client){return typeof client==='string'&&/^[A-Za-z0-9_-]{8,64}$/.test(client);}
  page(client){let page=this.pages.get(client);if(!page){page={streams:0,focused:false,visible:false,chatId:null,at:0};this.pages.set(client,page);}return page;}
  live(){return [...this.pages.values()].filter(page=>page.streams>0);}
  watching(chatId){return this.live().some(page=>page.focused&&page.visible&&page.chatId===chatId);}
  focused(){return this.live().some(page=>page.focused&&page.visible);}
  // Called by the runner and workflows when a task ends on its own.
  finished({chatId,status='complete',kind='chat',text='',label=''}={}){
    const settings=this.settings();
    if(!settings.enabled||!chatId||this.watching(chatId))return null;
    const chat=this.store.chat(chatId);if(!chat||chat.options?.desk)return null;
    const words=TEXT[this.look.language],failed=status==='error'||status==='failed'||status==='verify-failed';
    const summary=excerpt(text,120,this.look.language)||(failed?words.errorBody:'');
    const room=chat.group_id?this.store.db.prepare('SELECT name FROM groups WHERE id=?').get(chat.group_id)?.name:'';
    return this.deliver({chatId,kind,tone:failed?'error':'complete',
      source:room?`${words.app} · ${room}`:words.app,state:words[status]||words[failed?'error':'complete'],
      title:excerpt(chat.title,60,this.look.language),body:label?`${label}${summary?(this.look.language==='en'?': ':'：')+summary:''}`:summary},
      {sound:settings.sound,flash:!this.focused()});
  }
  test(chatId=null){
    const settings=this.settings(),words=TEXT[this.look.language],chat=typeof chatId==='string'?this.store.chat(chatId):null;
    return this.deliver({chatId:chat&&!chat.options?.desk?chat.id:null,kind:'test',tone:'complete',source:words.app,state:words.complete,title:words.testTitle,body:words.testBody},
      {sound:settings.sound,flash:false});
  }
  deliver(item,{sound,flash}){
    const notification={id:randomUUID(),...item,theme:this.look.theme,language:this.look.language,at:this.now()};
    if(this.native)try{this.notifier.show({...notification,sound,flash});}catch{}
    // Without a native notifier the open pages show a browser notification instead.
    this.broadcast('notification',{...notification,sound,native:this.native});
    return notification;
  }
  // The popup body was clicked. The helper has already raised an open
  // Starport window, or started a new one that picks the chat up on boot.
  opened({chatId,raised}={}){
    if(typeof chatId!=='string'||!this.store.chat(chatId))return;
    if(raised&&this.live().length)this.broadcast('notification-open',{chatId});
    else this.pending={chatId,at:this.now()};
  }
  take(){const pending=this.pending;this.pending=null;return pending&&this.now()-pending.at<OPEN_WINDOW_MS?pending.chatId:null;}
  async handle(method,path,read){
    if(path==='/api/notifications'&&method==='GET')return {data:{...this.status(),open:this.take()}};
    if(path==='/api/notifications'&&method==='PUT')return {data:this.update(await read())};
    if(path==='/api/notifications/test'&&method==='POST'){const input=await read();return {data:{ok:true,notification:this.test(input.chatId)}};}
    if(path==='/api/presence'&&method==='POST'){const input=await read();return {data:this.report(input.client,input)};}
    return null;
  }
  close(){this.notifier?.close?.();}
}

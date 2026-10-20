'use strict';
importScripts('video-reader.js');
let polling=false;
async function captureVideo(request){
  if(!/^BV[0-9A-Za-z]{10}$/.test(request.bvid)||!Number.isSafeInteger(request.part)||request.part<1||request.part>1000)throw Error('视频请求无效');
  if(!await chrome.permissions.contains({origins:['https://www.bilibili.com/*']}))throw Error('请在星港 Edge 扩展中允许读取 B 站网页');
  const url=`https://www.bilibili.com/video/${request.bvid}/`+(request.part===1?'':`?p=${request.part}`);
  const matches=(await chrome.tabs.query({url:'https://www.bilibili.com/video/*'})).filter(tab=>{try{const page=new URL(tab.url);return page.pathname.replace(/\/$/,'')===`/video/${request.bvid}`&&Number(page.searchParams.get('p')||1)===request.part;}catch{return false;}});
  let tab=matches[0],created=false;
  try{
    if(!tab){tab=await chrome.tabs.create({url,active:false});created=true;}
    const deadline=Date.now()+15000;
    while(tab.status!=='complete'){
      if(Date.now()>deadline)throw Error('B 站页面加载超时，请在 Edge 中打开视频后重试');
      await new Promise(resolve=>setTimeout(resolve,200));tab=await chrome.tabs.get(tab.id);
    }
    if(new URL(tab.url).hostname!=='www.bilibili.com')throw Error('B 站页面发生跳转，请在 Edge 中检查视频');
    const [capture]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:readBiliVideo,args:[{bvid:request.bvid,part:request.part}]});
    if(!capture?.result)throw Error('浏览器未返回字幕，请刷新 B 站页面后重试');
    return capture.result;
  }finally{if(created&&tab?.id)await chrome.tabs.remove(tab.id).catch(()=>{});}
}
async function call(connection,path,data){const response=await fetch(connection.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Starport-Key':connection.key,'X-Starport-Extension':chrome.runtime.id},body:JSON.stringify(data||{}),signal:AbortSignal.timeout(25000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Connection failed');return result;}
async function command(request){
  if(request.action==='video')return captureVideo(request);
  if(request.action==='tabs')return(await chrome.tabs.query({})).filter(tab=>/^https?:\/\//.test(tab.url||'')&&!tab.url.startsWith('http://127.0.0.1:3210')).map(tab=>({id:tab.id,title:tab.title,url:tab.url}));
  if(request.action==='capture'){
    const [capture]=await chrome.scripting.executeScript({target:{tabId:request.tabId},func:()=>{
      // Read visible text without changing the page or including editable fields.
      const parts=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node,total=0;
      while(node=walker.nextNode()){
        const parent=node.parentElement;if(!parent||parent.closest('script,style,noscript,input,textarea,select,[contenteditable],iframe'))continue;
        if(!parent.getClientRects().length||getComputedStyle(parent).visibility!=='visible')continue;
        const text=node.textContent.trim();if(text){parts.push(text);total+=text.length+1;}if(total>90000)break;
      }
      return{title:document.title,url:location.href,text:parts.join('\n').slice(0,90000)};
    }});return capture.result;
  }
  throw Error('Unsupported browser action');
}
async function poll(){
  if(polling)return;polling=true;
  try{for(;;){const {connection}=await chrome.storage.local.get('connection');if(!connection)break;
    const {commands}=await call(connection,'/bridge/poll');
    for(const request of commands){let result,error;try{result=await command(request);}catch(e){error=e.message;}await call(connection,'/bridge/result',{id:request.id,result,error});}
  }}catch{}finally{polling=false;}
}
chrome.runtime.onMessage.addListener(message=>{if(message.type==='connect')poll();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='starport')poll();});
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('starport',{periodInMinutes:0.5});poll();});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create('starport',{periodInMinutes:0.5});poll();});
poll();

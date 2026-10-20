'use strict';
const status=document.querySelector('#status'),connect=document.querySelector('#connect');
chrome.storage.local.get('connection').then(({connection})=>{if(connection){document.querySelector('#url').value=connection.url;status.textContent='已配对 / Paired';}});
connect.onclick=async()=>{
  connect.disabled=true;
  try{
    const url=new URL(document.querySelector('#url').value);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.username||url.password)throw Error('仅支持本机星港 / Local Starport only');
    const origins=document.querySelector('#all-sites').checked?['http://*/*','https://*/*']:['https://www.bilibili.com/*'];
    const granted=await chrome.permissions.request({origins});if(!granted)throw Error('需要 B 站网页访问权限才能读取字幕 / Bilibili access is required');
    const response=await fetch(url.origin+'/bridge/pair',{method:'POST',headers:{'Content-Type':'application/json','X-Starport-Extension':chrome.runtime.id},body:JSON.stringify({code:document.querySelector('#code').value.trim()})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Pairing failed');
    await chrome.storage.local.set({connection:{url:url.origin,key:data.key}});await chrome.runtime.sendMessage({type:'connect'});status.textContent='已连接。回到星港刷新标签页列表。 / Connected. Refresh tabs in Starport.';document.querySelector('#code').value='';
  }catch(error){status.textContent=error.message;}finally{connect.disabled=false;}
};
document.querySelector('#disconnect').onclick=async()=>{await chrome.storage.local.remove('connection');await chrome.permissions.remove({origins:['http://*/*','https://*/*']});status.textContent='已断开 / Disconnected';};

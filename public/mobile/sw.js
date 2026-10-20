'use strict';
const CACHE='starport-mobile-shell-v12-account-server';
const SHELL=['/','/mobile/app.js','/mobile/invitation.js','/mobile/composer.js','/mobile/style.css','/mobile/icon.svg','/mobile/icon-180.png','/mobile/icon-192.png','/mobile/icon-512.png','/manifest.webmanifest','/vendor/marked.min.js','/vendor/purify.min.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('starport-mobile-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  // Never cache account APIs, chats, cookies, model outputs, or POSTs.
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.search||!SHELL.includes(url.pathname))return;
  event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,copy)));}return response;}).catch(()=>caches.match(request).then(response=>response||Response.error())));
});

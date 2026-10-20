import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createCollaborationHub,collaborationUrl } from '../src/collaboration/server.mjs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('install assets have real matching icons and the group server exposes only its public shell',async t=>{
  const manifest=JSON.parse(await readFile('public/mobile/manifest.webmanifest','utf8'));assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
  for(const size of [192,512]){const icon=manifest.icons.find(x=>x.sizes===`${size}x${size}`);assert.ok(icon);const bytes=await readFile('public'+icon.src);assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);}
  const hub=createCollaborationHub({port:0,dataDir:await mkdtemp(join(tmpdir(),'starport-pwa-'))});await hub.listen();t.after(()=>hub.close());
  for(const path of ['/','/sw.js','/manifest.webmanifest','/mobile/app.js','/mobile/invitation.js','/mobile/composer.js','/vendor/marked.min.js','/vendor/purify.min.js']){const response=await fetch(hub.origin()+path);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);}
  for(const path of ['/.data/hub.sqlite','/src/server.mjs','/api/state'])assert.ok((await fetch(hub.origin()+path)).status>=400);
  assert.throws(()=>collaborationUrl('http://192.168.1.2:3218'),/HTTPS/);assert.throws(()=>createCollaborationHub({host:'0.0.0.0'}),/HTTPS/);
});

test('service worker caches only the shell, excludes account APIs and mutations, and serves offline shell',async()=>{
  const listeners={},saved=new Map(),waits=[];let offline=false,claimed=false;
  const cache={addAll:async paths=>{for(const path of paths)saved.set(path,new Response('shell '+path));},put:async(request,response)=>saved.set(new URL(request.url).pathname,response),keys:async()=>[...saved.keys()].map(path=>new Request('https://groups.example'+path))};
  const caches={open:async()=>cache,keys:async()=>['starport-mobile-shell-v1'],delete:async()=>true,match:async request=>saved.get(new URL(request.url).pathname)?.clone()};
  const self={location:{origin:'https://groups.example'},addEventListener:(name,handler)=>listeners[name]=handler,skipWaiting(){},clients:{claim:async()=>claimed=true}};
  const fetch=async request=>{if(offline)throw Error('offline');return new Response('network '+new URL(request.url).pathname);};
  runInNewContext(await readFile('public/mobile/sw.js','utf8'),{self,caches,fetch,URL,Response});
  const install=[];listeners.install({waitUntil:p=>install.push(p)});await Promise.all(install);assert.ok(saved.has('/'));assert.ok([...saved.keys()].every(path=>!path.startsWith('/api/')));
  const activation=[];listeners.activate({waitUntil:p=>activation.push(p)});await Promise.all(activation);assert.equal(claimed,true);
  const dispatch=async(path,method='GET')=>{let promise;listeners.fetch({request:new Request('https://groups.example'+path,{method}),waitUntil:p=>waits.push(p),respondWith:p=>promise=p});const response=promise&&await promise;await Promise.all(waits.splice(0));return response;};
  for(const path of ['/api/auth/session','/api/state','/api/rooms/room/messages','/mobile/app.js?account=secret','/private'])assert.equal(await dispatch(path),undefined);
  assert.equal(await dispatch('/','POST'),undefined);
  assert.equal(await (await dispatch('/mobile/app.js')).text(),'network /mobile/app.js');offline=true;assert.equal(await (await dispatch('/')).text(),'shell /');
  assert.ok([...saved.keys()].every(path=>!path.startsWith('/api/')));
});

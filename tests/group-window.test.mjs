import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GroupWindowLauncher,windowsAppCommand } from '../src/window-launcher.mjs';
import { createHub } from '../src/server.mjs';

test('Windows uses the same Edge application windows for local and remote StarPort pages',()=>{
  const executable=join('C:/Apps','Microsoft/Edge/Application/msedge.exe');
  const options={environment:{ProgramFiles:'C:/Apps'},fileExists:path=>path===executable};
  for(const url of ['http://127.0.0.1:3210','https://groups.example.com']){
    const command=windowsAppCommand(url,options);assert.equal(command.command,executable);assert.deepEqual(command.args,['--new-window','--app='+url]);
  }
  assert.equal(windowsAppCommand('https://groups.example.com',{fileExists:()=>false}),null);
  for(const url of ['http://192.168.1.10:3218','file:///tmp/private','https://user:password@example.com','https://groups.example.com/?invite=private'])assert.throws(()=>windowsAppCommand(url,options));
});

test('opening a group window requires local authentication and preserves server URL validation',async t=>{
  const launches=[];let unrefs=0;
  const launcher=new GroupWindowLauncher({platform:'win32',fileExists:()=>true,spawnProcess:(command,args,options)=>{
    launches.push({command,args,options});const child=new EventEmitter();child.unref=()=>unrefs++;queueMicrotask(()=>child.emit('spawn'));return child;
  }});
  const hub=createHub({port:0,dataDir:await mkdtemp(join(tmpdir(),'starport-group-window-')),registry:{list:async()=>[]},windowLauncher:launcher});
  const port=await hub.listen();t.after(()=>hub.close());const base='http://127.0.0.1:'+port;
  const send=(headers,url='https://groups.example.com')=>fetch(base+'/api/collaboration/window',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({hubUrl:url})});
  assert.equal((await send({})).status,401);
  assert.equal((await send({'X-Hub-Token':hub.token,Origin:'https://evil.example'})).status,403);
  assert.equal(launches.length,0);
  const headers={'X-Hub-Token':hub.token,Origin:base};
  const status=await (await fetch(base+'/api/collaboration/status',{headers})).json();assert.equal(status.windowMode,'windows');
  assert.equal((await send(headers,'http://192.168.1.2:3218')).status,400);assert.equal(launches.length,0);
  const result=await send(headers);assert.equal(result.status,200);assert.deepEqual(await result.json(),{opened:true});assert.equal(launches.length,1);assert.equal(unrefs,1);assert.deepEqual(launches[0].args,['--new-window','--app=https://groups.example.com']);
});

test('a missing Edge executable or failed spawn reports an error without a browser fallback',async()=>{
  await assert.rejects(()=>new GroupWindowLauncher({platform:'win32',fileExists:()=>false}).open('https://groups.example.com'),/Edge/);
  const launcher=new GroupWindowLauncher({platform:'win32',fileExists:()=>true,spawnProcess:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('launch failed')));return child;}});
  await assert.rejects(()=>launcher.open('https://groups.example.com'),/launch failed/);
});

test('Windows local contexts retain their full path and reject remote or arbitrary private routes',async()=>{const launches=[],launcher=new GroupWindowLauncher({platform:'win32',fileExists:()=>true,spawnProcess:(command,args)=>{launches.push(args);const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>c.emit('spawn'));return c;}}),url='http://127.0.0.1:3210/group-windows/'+'Z'.repeat(43);await launcher.openLocal(url);assert.equal(launches[0][1],'--app='+url);for(const value of ['https://server.example/group-windows/'+'Z'.repeat(43),'http://127.0.0.1:3210/api/state',url+'?token=x'])await assert.rejects(launcher.openLocal(value),/地址无效/);});

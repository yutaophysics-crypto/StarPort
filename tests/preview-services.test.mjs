import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createStaticPreview} from '../src/previews/static-server.mjs';
import {PreviewManager,previewFolder,previewLaunch,previewManager} from '../src/previews/manager.mjs';
import {externalToolServers} from '../src/external-tools/claude-tools.mjs';
import {createHub} from '../src/server.mjs';
import {exec} from '../src/process.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const windows={skip:process.platform!=='win32'},nonce='1234567890abcdef1234567890abcdef';
async function fixture(){
  const root=realpathSync.native(await mkdtemp(join(tmpdir(),'starport-preview-'))),workspace=join(root,'项目 & preview'),data=join(root,'hub-data');
  await mkdir(workspace);await mkdir(data);await writeFile(join(workspace,'index.html'),'<h1>preview fixture</h1>');
  // Emulate Codex's argv contract for process-lifecycle tests. Native MXC
  // filesystem enforcement is separately exercised in the local smoke test.
  await writeFile(join(workspace,'sandbox'),"const a=process.argv.slice(2),i=a.indexOf('--');if(i<0)process.exit(1);const c=require('node:child_process').spawn(a[i+1],a.slice(i+2),{stdio:'inherit',windowsHide:true});c.on('exit',n=>process.exit(n??1));");
  return {root,workspace,data};
}
async function staticFixture(t){const f=await fixture(),server=await createStaticPreview({root:f.workspace,nonce});t.after(()=>{server.closeAllConnections();return new Promise(ok=>server.close(ok));});return {...f,server,base:'http://127.0.0.1:'+server.address().port};}
async function raw(base,path,headers={},method='GET'){
  return new Promise((ok,no)=>{const url=new URL(base),r=request({hostname:'127.0.0.1',port:url.port,path,method,headers},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>ok({status:res.statusCode,headers:res.headers,body}));});r.on('error',no);r.end();});
}
async function clean(manager,workspace){for(const row of await manager.list(workspace))if(['running','starting','unknown'].includes(row.state))await manager.stop(workspace,row.id);}

test('static previews serve built assets, Unicode paths, directory redirects, HEAD and audio ranges',async t=>{
  const f=await staticFixture(t);await mkdir(join(f.workspace,'pages'));await writeFile(join(f.workspace,'pages','index.html'),'nested');
  await writeFile(join(f.workspace,'中文.js'),'export const value=1');await writeFile(join(f.workspace,'sound.wav'),'0123456789');await writeFile(join(f.workspace,'engine.wasm'),Buffer.from([0,97,115,109]));
  let r=await raw(f.base,'/');assert.equal(r.status,200);assert.equal(r.body,'<h1>preview fixture</h1>');assert.match(r.headers['content-type'],/^text\/html/);
  r=await raw(f.base,'/pages?x=1');assert.equal(r.status,308);assert.equal(r.headers.location,'/pages/?x=1');
  assert.equal((await raw(f.base,'/pages/')).body,'nested');
  assert.match((await raw(f.base,'/'+encodeURIComponent('中文.js'))).headers['content-type'],/^text\/javascript/);
  assert.equal((await raw(f.base,'/engine.wasm')).headers['content-type'],'application/wasm');
  r=await raw(f.base,'/sound.wav',{Range:'bytes=2-5'});assert.equal(r.status,206);assert.equal(r.body,'2345');assert.equal(r.headers['content-range'],'bytes 2-5/10');
  assert.equal((await raw(f.base,'/sound.wav',{Range:'bytes=-3'})).body,'789');
  assert.equal((await raw(f.base,'/sound.wav',{Range:'bytes=90-'})).status,416);
  r=await raw(f.base,'/',{},'HEAD');assert.equal(r.status,200);assert.equal(r.body,'');assert.equal(r.headers['content-length'],String(Buffer.byteLength('<h1>preview fixture</h1>')));
  assert.equal(JSON.parse((await raw(f.base,'/.starport-preview-health')).body).nonce,nonce);
});
test('static previews reject traversal, private files, foreign origins, writes and escaping junctions',async t=>{
  const f=await staticFixture(t),outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'secret.txt'),'must-not-leak');
  await writeFile(join(f.workspace,'.env'),'must-not-leak');await mkdir(join(f.workspace,'.git'));await writeFile(join(f.workspace,'.git','config'),'must-not-leak');
  await symlink(outside,join(f.workspace,'escape'),process.platform==='win32'?'junction':'dir');
  for(const path of ['/.env','/.git/config','/%2e%2e/outside/secret.txt','/escape/secret.txt','/index.html%3Astream','/%5c..%5coutside']){
    const r=await raw(f.base,path);assert.equal(r.status,403,path);assert.ok(!r.body.includes('must-not-leak'));
  }
  assert.equal((await raw(f.base,'/',{Host:'evil.invalid'})).status,403);
  assert.equal((await raw(f.base,'/',{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await raw(f.base,'/',{},'POST')).status,405);
  assert.equal(await readFile(join(f.workspace,'index.html'),'utf8'),'<h1>preview fixture</h1>');
});
test('custom non-dot private data inside a project remains unavailable to previews',async t=>{
  const f=await fixture(),privateDir=join(f.workspace,'private-hub-data');await mkdir(privateDir);await writeFile(join(privateDir,'hub.sqlite'),'must-not-leak');
  const server=await createStaticPreview({root:f.workspace,nonce,blockedPaths:[privateDir]});t.after(()=>{server.closeAllConnections();return new Promise(ok=>server.close(ok));});
  assert.equal((await raw('http://127.0.0.1:'+server.address().port,'/private-hub-data/hub.sqlite')).status,403);
  await assert.rejects(createStaticPreview({root:privateDir,nonce,blockedPaths:[privateDir]}),/Invalid preview/);
});
test('preview launch accepts only a project folder and a fixed readonly sandbox command',windows,async()=>{
  const f=await fixture(),outside=join(f.root,'elsewhere');await mkdir(outside);await mkdir(join(f.workspace,'.data'));
  for(const directory of ['..',outside,'.data'])assert.throws(()=>previewFolder(f.workspace,directory));
  await symlink(outside,join(f.workspace,'link'),'junction');assert.throws(()=>previewFolder(f.workspace,'link'),/项目内/);
  const launch=previewLaunch({...previewFolder(f.workspace),port:0,nonce,sandboxExecutable:process.execPath,dataDir:f.data});
  assert.equal(launch.executable,process.execPath);assert.equal(launch.persistent,true);assert.ok(launch.args.includes('starport_preview'));
  const policy=launch.args.find(arg=>arg.startsWith('permissions.'));assert.match(policy,/"\:root" = "deny"/);assert.match(policy,/network=\{ enabled=true \}/);assert.ok(!policy.includes('"write"'));
});
test('preview survives its launcher, can be reattached and reused, and stops only within its project',windows,async t=>{
  const f=await fixture(),manager=new PreviewManager(f.data),other=join(f.root,'other');await mkdir(other);t.after(()=>clean(manager,f.workspace));
  const module=new URL('../src/previews/manager.mjs',import.meta.url).href;
  const code=`import {PreviewManager} from ${JSON.stringify(module)};const r=await new PreviewManager(${JSON.stringify(f.data)}).start({workspace:${JSON.stringify(f.workspace)},sandboxExecutable:process.execPath});console.log(JSON.stringify(r));`;
  const result=JSON.parse((await exec(process.execPath,['--input-type=module','-e',code],{timeout:25000,windowsHide:true})).stdout);
  assert.equal(result.ok,true);assert.equal((await fetch(result.url)).status,200);
  const reattached=new PreviewManager(f.data);assert.equal((await reattached.list(f.workspace))[0].url,result.url);
  assert.deepEqual(await reattached.list(other),[]);await assert.rejects(reattached.stop(other,result.id),e=>e.status===404);
  const reused=await reattached.start({workspace:f.workspace,sandboxExecutable:process.execPath});assert.equal(reused.id,result.id);assert.equal(reused.reused,true);
  await reattached.stop(f.workspace,result.id);await assert.rejects(fetch(result.url));assert.equal((await manager.list(f.workspace))[0].state,'stopped');
});
test('concurrent starts reuse one preview and occupied ports leave existing listeners intact',windows,async t=>{
  const f=await fixture(),manager=new PreviewManager(f.data);t.after(()=>clean(manager,f.workspace));
  const [a,b]=await Promise.all([manager.start({workspace:f.workspace,sandboxExecutable:process.execPath}),manager.start({workspace:f.workspace,sandboxExecutable:process.execPath})]);
  assert.equal(a.id,b.id);assert.deepEqual([a.reused,b.reused],[false,true]);
  const other=join(f.workspace,'other');await mkdir(other);await writeFile(join(other,'sandbox'),await readFile(join(f.workspace,'sandbox')));
  await assert.rejects(manager.start({workspace:f.workspace,directory:'other',port:a.port,sandboxExecutable:process.execPath}),/预览启动失败|连接检查/);
  assert.equal((await fetch(a.url)).status,200,'port conflict must not close the existing service');
});
test('cancellation during startup leaves no live preview',windows,async()=>{
  const f=await fixture(),manager=new PreviewManager(f.data),controller=new AbortController();
  const start=manager.start({workspace:f.workspace,sandboxExecutable:process.execPath,signal:controller.signal});setTimeout(()=>controller.abort(),70);
  await assert.rejects(start,/取消/);assert.ok((await manager.list(f.workspace)).every(row=>!['running','starting','unknown'].includes(row.state)));
});
test('Claude receives persistent preview tools even without external application grants',windows,async t=>{
  const f=await fixture(),controller=new AbortController(),pending=new Set();
  const runtime={externalTools:{workspace:f.workspace,tools:[],dataDir:f.data},workspaceTerminal:{normalPolicy:{},sandboxExecutable:process.execPath}};
  const servers=externalToolServers({runtime,cwd:f.workspace,signal:controller.signal,canUseTool:()=>assert.fail('readonly static previews require no host executable grant'),emit(){}});
  const manager=previewManager(f.data);t.after(()=>clean(manager,f.workspace));
  const server=servers.servers.starport_preview.instance,client=new Client({name:'preview-test',version:'1.0.0'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(b);await client.connect(a);const tools=(await client.listTools()).tools;assert.deepEqual(tools.map(t=>t.name),['start','list','stop']);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(),['directory','port']);
    const reply=await client.callTool({name:'start',arguments:{}}),started=JSON.parse(reply.content[0].text);assert.equal(reply.isError,undefined);assert.equal(started.ok,true);
    const listed=JSON.parse((await client.callTool({name:'list',arguments:{}})).content[0].text);assert.equal(listed.previews[0].id,started.id);
    await client.close();await server.close();await servers.settled();assert.equal((await fetch(started.url)).status,200,'preview outlives MCP session');
    await manager.stop(f.workspace,started.id);
  }finally{await client.close();await server.close();}
});
test('preview HTTP controls require owner authentication, preserve project scope and allow use during a task',windows,async t=>{
  const f=await fixture(),registry={resolve:id=>id==='claude'?{normalPolicy:{}}:{command:process.execPath},list:async()=>[],record(){}};
  const hub=createHub({port:0,dataDir:f.data,registry});await hub.listen();const manager=previewManager(f.data);t.after(async()=>{await clean(manager,f.workspace);await hub.close();});
  const project=hub.store.addProject('Preview fixture',f.workspace),base='http://127.0.0.1:'+hub.server.address().port,path='/api/projects/'+project.id+'/previews';
  const headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+path)).status,401);assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify({directory:'..'})})).status,400);
  const chat=hub.store.newChat({provider:'claude',workspace:f.workspace});hub.runner.active.set(chat.id,{});
  let started;try{const response=await fetch(base+path,{method:'POST',headers,body:'{}'});assert.equal(response.status,201);started=await response.json();}finally{hub.runner.active.delete(chat.id);}
  assert.equal(started.ok,true);assert.equal((await(await fetch(base+path,{headers})).json()).previews[0].id,started.id);
  const other=join(f.root,'other-project');await mkdir(other);const otherProject=hub.store.addProject('Other',other);
  assert.equal((await fetch(base+'/api/projects/'+otherProject.id+'/previews/'+started.id+'/stop',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(base+path+'/'+started.id+'/stop',{method:'POST',headers,body:'{}'})).status,200);await assert.rejects(fetch(started.url));
});

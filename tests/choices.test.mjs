import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { browseFolders, createFolder, directoryPath, userFolders } from '../src/folders.mjs';
import { FileActions } from '../src/files.mjs';
import { ModelCatalog, codexModels, parseAntigravityModels, deepseekConfiguredModels } from '../src/models.mjs';
import { createHub } from '../src/server.mjs';
import { claudeModels,claudeModelCatalog } from '../src/claude-models.mjs';

test('Claude native names show resolved versions while preserving selectable aliases and custom deployments',()=>{
  const result=claudeModelCatalog([{value:'default',displayName:'Default',resolvedModel:'claude-sonnet-5'},
    {value:'sonnet',displayName:'Sonnet',resolvedModel:'claude-sonnet-5'},
    {value:'opus',displayName:'Opus',resolvedModel:'claude-opus-5-5'},
    {value:'haiku',displayName:'Haiku',resolvedModel:'claude-haiku-4-5-20251001'},
    {value:'opus[1m]',displayName:'Opus (1M context)',resolvedModel:'claude-opus-5-5[1m]'},
    {value:'company',displayName:'Company model',resolvedModel:'custom-deployment'}]);
  assert.ok(result.models.every(m=>m.id!=='default'));
  assert.deepEqual(result.models.slice(0,4).map(m=>[m.id,m.label]),[['sonnet','Claude Sonnet 5'],['opus','Claude Opus 5.5'],['haiku','Claude Haiku 4.5'],['opus[1m]','Claude Opus 5.5 · 1M']]);
  assert.equal(result.models[4].label,'Company model · custom-deployment');assert.equal(result.models.at(-1).id,'opusplan');assert.match(result.models.at(-1).label,/Opus 5\.5 → Claude Sonnet 5/);
  assert.equal(claudeModelCatalog([{value:'haiku',displayName:'Haiku'}]).models.length,1);
});
test('Claude catalog initialization sends no prompt and closes on success, failure and timeout',async()=>{
  for(const mode of ['success','failure','timeout']){
    let closed=false,request;const result=await claudeModels({command:process.execPath,prefixArgs:[]},process.cwd(),input=>{
      request=input;assert.deepEqual(input.options.tools,[]);assert.equal(input.options.settings.disableAllHooks,true);assert.equal(input.options.persistSession,false);assert.equal(input.options.strictMcpConfig,true);
      return {supportedModels:async()=>{if(mode==='failure')throw new Error('offline');if(mode==='timeout')await new Promise(()=>{});return [{value:'opus',displayName:'Opus',resolvedModel:'claude-opus-5'}];},close:()=>{closed=true;}};
    },20);
    assert.equal(closed,true);assert.deepEqual(await request.prompt.next(),{done:true,value:undefined});
    assert.equal(result.source,mode==='success'?'native':'aliases');
    if(mode!=='success')assert.ok(result.models.every(m=>!/5\.5/.test(m.label)));
  }
});

test('folder browser handles Unicode/spaces, returns directories only, parent and empty folders',async()=>{
  const root=await mkdtemp(join(tmpdir(),'starport-folders-')),child=join(root,'论文 & notes');
  await mkdir(child);await mkdir(join(root,'.hidden'));await writeFile(join(root,'not-a-folder.txt'),'secret');
  const result=await browseFolders(root,root);
  assert.deepEqual(result.folders.map(f=>f.name),['.hidden','论文 & notes']);
  assert.equal(result.parent,dirname(root));assert.ok(result.roots.some(r=>r.path===root));
  assert.equal((await browseFolders(child,root)).folders.length,0);
  await assert.rejects(()=>directoryPath('relative'),/完整路径/);
  await assert.rejects(()=>directoryPath(join(root,'missing')),/不存在/);
  await assert.rejects(()=>directoryPath(join(root,'not-a-folder.txt')),/不存在/);
});
test('native catalogs preserve model ids, follow Codex pagination and ignore CLI chatter',async()=>{
  const models=await codexModels({command:process.execPath,prefixArgs:[resolve('tests/fixtures/models-rpc.mjs')]},process.cwd());
  assert.deepEqual(models.models.map(m=>m.id),['first','second']);
  assert.deepEqual(parseAntigravityModels('Fetching available models...\n\x1b[32mgemini-test\tGemini Test\x1b[0m\nError: login needed'),[{id:'gemini-test',label:'Gemini Test'}]);
});
test('DeepSeek exposes only model metadata, keeping service identity and saved custom choices',()=>{
  const result=deepseekConfiguredModels({'llm-deepseek':{apiKey:'secret',models:[{id:'same',name:'Local'}]},'llm-pi-ai':{providers:{gateway:{apiKey:'secret',models:[{id:'same',name:'Gateway'}]}}},'agent-default-model':{provider:'other',model:'custom'}},[{id:'bundled'}]);
  assert.deepEqual(result,[{id:'same',label:'Local',provider:'deepseek-official'},{id:'same',label:'Gateway',provider:'gateway'},{id:'custom',label:'custom',provider:'other'}]);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('catalog coalesces requests, separates workspaces and retries failures on refresh',async()=>{
  let calls=0,fail=false;
  const catalog=new ModelCatalog('',async()=>{calls++;await new Promise(r=>setTimeout(r,10));if(fail)throw new Error('sensitive diagnostic');return {source:'native',models:[{id:'a',label:'A'},{id:'a',label:'duplicate'}]};});
  const [a,b]=await Promise.all([catalog.get('codex',{},'one'),catalog.get('codex',{},'one',true)]);
  assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.models.length,1);
  await catalog.get('codex',{},'two');assert.equal(calls,2);
  fail=true;assert.deepEqual(await catalog.get('codex',{},'one',true),{models:[],source:'unavailable'});
  fail=false;assert.equal((await catalog.get('codex',{},'one',true)).models.length,1);
});
test('folder and model APIs require authentication and reject cross-site/invalid paths',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'starport-choices-'));let received;
  const registry={models:async(...args)=>{received=args;return {source:'native',models:[{id:'selected',label:'Selected'}]};}};
  const hub=createHub({port:0,dataDir:dir,registry});const port=await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token};
  for(const path of ['/api/folders','/api/providers/codex/models']){
    assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetch(base+path,{headers:{...headers,Origin:'https://example.com'}})).status,403);
  }
  const folder=await(await fetch(base+'/api/folders?'+new URLSearchParams({path:dir}),{headers})).json();assert.equal(folder.path,dir);
  const models=await(await fetch(base+'/api/providers/codex/models?'+new URLSearchParams({workspace:dir,refresh:'1'}),{headers})).json();assert.equal(models.models[0].id,'selected');assert.deepEqual(received,['codex',dir,true]);
  assert.equal((await fetch(base+'/api/providers/codex/models?workspace=relative',{headers})).status,400);
});

// context-menu-folders-20261004: quick-access places, new folders and opening folders in Explorer.
test('folder browser lists existing quick-access places first and marks drives',async()=>{
  const root=await mkdtemp(join(tmpdir(),'starport-places-')),desktop=join(root,'桌面 Desktop');await mkdir(desktop);
  const result=await browseFolders(root,root,async()=>[{label:'桌面',path:desktop},{label:'下载',path:join(root,'missing')}]);
  assert.deepEqual(result.roots.filter(r=>r.kind==='place').map(r=>r.label),['桌面','主目录','默认工作目录']);
  assert.equal(result.roots[0].path,desktop);
  assert.ok(result.roots.some(r=>r.kind==='drive'));
  assert.ok(result.roots.every(r=>['place','drive'].includes(r.kind)));
});
test('user folders resolve to absolute paths, falling back to the home folder',async()=>{
  const places=await userFolders();
  assert.deepEqual(places.map(p=>p.label),['桌面','文档','下载']);
  assert.ok(places.every(p=>isAbsolute(p.path)));
});
test('new folders accept Unicode names and reject unsafe, reserved or duplicate names',async()=>{
  const root=await mkdtemp(join(tmpdir(),'starport-create-'));
  const created=await createFolder(root,'  论文 & notes (2) ');
  assert.deepEqual(created,{name:'论文 & notes (2)',path:join(root,'论文 & notes (2)')});
  assert.ok((await stat(created.path)).isDirectory());
  await assert.rejects(()=>createFolder(root,'论文 & notes (2)'),error=>error.status===409&&/已存在/.test(error.message));
  for(const name of ['','   ','a/b','a\\b','..','.','trailing.','CON','nul.txt','com1','a:b','a*b','a?b','a"b','a<b','a|b','x'.repeat(256),42,null])
    await assert.rejects(()=>createFolder(root,name),/文件夹名称无效/,String(name));
  await assert.rejects(()=>createFolder(join(root,'missing'),'child'),/不存在/);
  await assert.rejects(()=>createFolder('relative','child'),/完整路径/);
  assert.deepEqual(await readdir(root),['论文 & notes (2)']);
});
test('folder creation and opening are authenticated and only reach Explorer for real folders',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'starport-folder-api-')),opened=[];
  const fileActions=new FileActions({launch:async(action,path)=>{opened.push([action,path]);return {ok:true,canceled:false};}});
  const hub=createHub({port:0,dataDir:join(dir,'data'),registry:{models:async()=>({models:[]})},fileActions});const port=await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  for(const path of ['/api/folders','/api/folders/open']){
    assert.equal((await fetch(base+path,{method:'POST',body:'{}'})).status,401);
    assert.equal((await post(path,{parent:dir,name:'x',path:dir},{Origin:'https://example.com'})).status,403);
  }
  const response=await post('/api/folders',{parent:dir,name:'新项目'});assert.equal(response.status,201);
  const created=await response.json();assert.equal(created.path,join(dir,'新项目'));
  assert.equal((await post('/api/folders',{parent:dir,name:'新项目'})).status,409);
  assert.equal((await post('/api/folders',{parent:dir,name:'bad/name'})).status,400);
  assert.equal((await post('/api/folders/open',{path:created.path})).status,200);
  assert.deepEqual(opened,[['open-folder',created.path]]);
  for(const path of [join(dir,'missing'),'relative',join(dir,'data','hub.sqlite')])assert.equal((await post('/api/folders/open',{path})).status,400);
  assert.equal(opened.length,1);
});

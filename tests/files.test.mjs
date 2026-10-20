import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {localFilePath,FileActions} from '../src/files.mjs';
import {createHub} from '../src/server.mjs';

test('local paths preserve Unicode and punctuation, resolve against the conversation, and reject protocols/devices',()=>{
  const cwd='C:\\work\\project';
  assert.equal(localFilePath('file:///C:/work/%E6%8A%A5%E5%91%8A%20draft.md#L12',cwd,'win32'),'C:\\work\\报告 draft.md');
  assert.equal(localFilePath('notes/report.md:12:4',cwd,'win32'),'C:\\work\\project\\notes\\report.md');
  assert.equal(localFilePath('report.md#L12-L15',cwd,'win32'),'C:\\work\\project\\report.md');
  assert.equal(localFilePath('C:\\work\\报告 (a,b) & `$(test).md',cwd,'win32'),'C:\\work\\报告 (a,b) & `$(test).md');
  for(const bad of ['https://example.com/a.md','javascript:alert(1)','file://server/share/a.md','\\\\server\\share\\a.md','\\\\?\\C:\\a.md','C:relative.md','C:\\a.md:payload','C:\\a.md\nwhoami','file:///C:/a%00.md','%5C%5Cserver%5Cfile.md'])assert.throws(()=>localFilePath(bad,cwd,'win32'),undefined,bad);
});

test('file actions check existence and select an editor for code instead of executing its file association',async()=>{
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'starport-file-actions-'))),calls=[];
  const service=new FileActions({launch:async(action,path)=>{calls.push({action,path});return {ok:true};}});
  const file=join(dir,'报告 (a,b) & `$(test).md');writeFileSync(file,'synthetic document');
  writeFileSync(join(dir,'example.py'),'synthetic code');
  await service.perform('reveal',pathToFileURL(file).href,dir);
  await service.perform('open','报告 (a,b) & `$(test).md',dir);
  await service.perform('open-with',file,dir);
  await service.perform('open','example.py',dir);
  assert.deepEqual(calls.map(c=>c.action),['reveal','open','open-with','open-with']);
  assert.equal(calls[0].path,file);assert.equal(readFileSync(file,'utf8'),'synthetic document');
  await assert.rejects(service.perform('open','missing.md',dir),/文件不存在/);
  await assert.rejects(service.perform('reveal',dir,dir),/请选择一个文件/);
  await assert.rejects(service.perform('delete',file,dir),/操作无效/);
  assert.equal(calls.length,4);
});

test('file action HTTP requires same-origin authorization and uses the selected chat workspace',async t=>{
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'starport-file-api-'))),calls=[];
  writeFileSync(join(dir,'report.md'),'synthetic report');
  const registry={list:async()=>[],resolve:()=>({}),probe:async()=>({})};
  const hub=createHub({dataDir:dir,port:0,registry,fileActions:new FileActions({launch:async(action,path)=>{calls.push({action,path});return {ok:true};}})});
  const port=await hub.listen();t.after(()=>hub.close());
  const chat=hub.store.newChat({workspace:dir}),url='http://127.0.0.1:'+port+'/api/files/';
  const headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'},body=JSON.stringify({reference:'report.md',chatId:chat.id});
  assert.equal((await fetch(url+'reveal',{method:'POST',body})).status,401);
  assert.equal((await fetch(url+'reveal',{method:'POST',body,headers:{...headers,Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(url+'open',{headers})).status,404);
  const resolved=await fetch(url+'resolve',{method:'POST',body,headers});assert.equal(resolved.status,200);assert.equal((await resolved.json()).path,join(dir,'report.md'));assert.equal(calls.length,0);
  for(const action of ['open','reveal','open-with'])assert.equal((await fetch(url+action,{method:'POST',body,headers})).status,200);
  assert.deepEqual(calls.map(c=>c.action),['open','reveal','open-with']);
  assert.ok(calls.every(c=>c.path===join(dir,'report.md')));
  assert.equal((await fetch(url+'open',{method:'POST',headers,body:JSON.stringify({chatId:'missing',reference:'report.md'})})).status,404);
  assert.equal((await fetch(url+'open',{method:'POST',headers,body:JSON.stringify({chatId:chat.id,reference:'javascript:alert(1)'})})).status,400);
  assert.equal(calls.length,3);assert.equal(hub.store.list().chats.length,1);
});

function fileFixture(){
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'starport-file-search-'))),calls=[];
  const service=new FileActions({launch:async(action,path)=>{calls.push({action,path});return {ok:true};}});
  const add=relative=>{const file=join(dir,relative);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'synthetic file');return file;};
  return {dir,calls,service,add};
}

test('missing relative links find Unicode files and encoded anchored suffixes in workspace subfolders',async()=>{
  const f=fileFixture(),html=f.add('地下城自走棋/莉芙攻击预览-离线-v07.html');
  const note=f.add('地下城自走棋/notes/报告 draft.md');f.add('unrelated/报告 draft.md');
  assert.equal((await f.service.resolve('莉芙攻击预览-离线-v07.html',f.dir)).path,html);
  assert.equal((await f.service.resolve('notes/%E6%8A%A5%E5%91%8A%20draft.md#L12-L15',f.dir)).path,note);
  await f.service.perform('open','莉芙攻击预览-离线-v07.html',f.dir);assert.deepEqual(f.calls,[{action:'open',path:html}]);
  const script=f.add('地下城自走棋/打开预览.cmd');await f.service.perform('open','打开预览.cmd',f.dir);
  assert.deepEqual(f.calls.at(-1),{action:'open-with',path:script});
});

test('exact paths win and duplicate fallback results never launch an arbitrary file',async()=>{
  const f=fileFixture(),one=f.add('a/report.md'),two=f.add('b/report.md');
  const result=await f.service.perform('open','report.md',f.dir);
  assert.equal(result.ambiguous,true);assert.equal(result.searchIncomplete,false);
  assert.deepEqual(result.candidates.map(file=>file.path),[one,two]);assert.equal(f.calls.length,0);
  await f.service.perform('reveal',two,f.dir);assert.deepEqual(f.calls,[{action:'reveal',path:two}]);
  const direct=f.add('report.md');assert.equal((await f.service.resolve('report.md',f.dir)).path,direct);
  await assert.rejects(()=>f.service.resolve('missing/report.md',f.dir),/文件不存在/);
});

test('missing explicit and parent paths do not become workspace basename guesses',async()=>{
  const f=fileFixture();f.add('nested/report.md');
  const outside=realpathSync.native(mkdtempSync(join(tmpdir(),'starport-outside-files-')));
  for(const reference of [join(f.dir,'report.md'),join(outside,'report.md'),'../outside/report.md'])await assert.rejects(()=>f.service.perform('open',reference,f.dir),/文件不存在/);
  assert.equal(f.calls.length,0);
});

test('selected canonical paths preserve literal URL escapes and anchor-like filenames',async()=>{
  const f=fileFixture(),one=f.add('a/报告%20draft.md'),two=f.add('b/报告%20draft.md');f.add('b/报告 draft.md');
  const result=await f.service.perform('open','报告%2520draft.md',f.dir);
  assert.equal(result.ambiguous,true);assert.deepEqual(result.candidates.map(file=>file.path),[one,two]);
  await f.service.perform('open',encodeURIComponent(two),f.dir);assert.equal(f.calls.at(-1).path,two);
  const anchored=f.add('a/report.md#L12');await f.service.perform('open',encodeURIComponent(anchored),f.dir);
  assert.equal(f.calls.at(-1).path,anchored);
});

test('fallback excludes directory links, outside targets and cycles',async()=>{
  const f=fileFixture(),outside=realpathSync.native(mkdtempSync(join(tmpdir(),'starport-linked-files-')));
  writeFileSync(join(outside,'secret.md'),'outside workspace');
  symlinkSync(outside,join(f.dir,'external'),process.platform==='win32'?'junction':'dir');
  symlinkSync(f.dir,join(f.dir,'cycle'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>f.service.resolve('secret.md',f.dir),/文件不存在/);
  const inside=f.add('real/inside.md');assert.equal((await f.service.resolve('inside.md',f.dir)).path,inside);
});

test('a partial search does not auto-open a single candidate or report a definite absence',async()=>{
  const f=fileFixture();const found=f.add('a/report.md');mkdirSync(join(f.dir,'b'));
  const bounded=new FileActions({searchLimits:{maxEntries:3},launch:async()=>assert.fail('Partial search must ask for a choice')});
  const result=await bounded.perform('open','report.md',f.dir);
  assert.equal(result.ambiguous,true);assert.equal(result.searchIncomplete,true);assert.equal(result.candidates[0].path,found);
  await assert.rejects(()=>bounded.resolve('absent.md',f.dir),error=>error.status===409&&/完整路径/.test(error.message));
});

test('subfolder search and ambiguity stay bound to the selected chat through the file API',async t=>{
  const f=fileFixture(),one=f.add('a/report.md'),two=f.add('b/report.md'),unique=f.add('sub/preview.html');
  const registry={list:async()=>[],resolve:()=>({}),probe:async()=>({})};
  const hub=createHub({dataDir:join(f.dir,'data'),port:0,registry,fileActions:f.service});
  const port=await hub.listen();t.after(()=>hub.close());const chat=hub.store.newChat({workspace:f.dir});
  const other=f.add('other/preview.html'),otherChat=hub.store.newChat({workspace:join(f.dir,'other')});
  const request=(action,reference,chatId=chat.id)=>fetch('http://127.0.0.1:'+port+'/api/files/'+action,{method:'POST',headers:{'X-Hub-Token':hub.token,'Content-Type':'application/json'},body:JSON.stringify({reference,chatId})});
  assert.equal((await(await request('resolve','sub/preview.html')).json()).path,unique);
  const duplicate=await(await request('open','report.md')).json();assert.equal(duplicate.ambiguous,true);assert.equal(f.calls.length,0);
  assert.deepEqual(duplicate.candidates.map(file=>file.path),[one,two]);
  await request('open',two);assert.equal(f.calls[0].path,two);
  assert.equal((await(await request('resolve','preview.html',otherChat.id)).json()).path,other);
});

const runtime=vm.createContext({console:{warn(){},log(){}}});
for(const file of ['public/vendor/marked.min.js','public/vendor/katex.min.js','public/markdown.js','public/files.js'])vm.runInContext(readFileSync(new URL('../'+file,import.meta.url),'utf8'),runtime);
test('Markdown file links retain exact destinations without enabling arbitrary URL schemes or changing equations',()=>{
  const href='file:///C:/work/PROJECT_NOTES.md',references=[];
  const html=runtime.StarportMarkdown.render('[PROJECT_NOTES.md]('+href+') and $x_i^2$ and [site](https://example.com)',{localLink:ref=>{if(!runtime.StarportFiles.isReference(ref))return null;references.push(ref);return '#local-'+references.length;}});
  assert.deepEqual(references,[href]);assert.match(html,/href="#local-1"/);assert.match(html,/href="https:\/\/example.com"/);assert.match(html,/class="katex"/);
  for(const value of ['javascript:alert(1)','data:text/html,abc','https://example.com/file.md','mailto:me@example.com','#chapter'])assert.equal(runtime.StarportFiles.isReference(value),false,value);
});
test('plain file references are detected without turning web URLs or emails into local files',()=>{
  const find=text=>Array.from(runtime.StarportFiles.plainReferences(text),r=>r.reference);
  assert.deepEqual(find('👉 PROJECT_NOTES.md，见 notes/report.pdf。'),['PROJECT_NOTES.md','notes/report.pdf']);
  assert.deepEqual(find('https://example.com/report.md someone@report.md and report.md'),['report.md']);
  assert.deepEqual(find('文件 C:\\work\\报告 draft.md，完成。'),['C:\\work\\报告 draft.md']);
  assert.deepEqual(find('打开莉芙攻击预览-v07.cmd 与 scripts/build.ps1'),['打开莉芙攻击预览-v07.cmd','scripts/build.ps1']);
  assert.equal(runtime.StarportFiles.isReference('打开莉芙攻击预览-v07.cmd'),true);
});

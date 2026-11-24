import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import { runClaude } from '../src/adapters/claude.mjs';
import { cliArguments } from '../src/adapters/cli.mjs';
import { validateOptions } from '../src/providers.mjs';
import { workspaceFilesystem } from '../src/external-tools/terminal.mjs';
import { createHub } from '../src/server.mjs';

const folder=(name,files={})=>{
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'starport-knowledge-'+name+'-')));
  for(const [file,text] of Object.entries(files)){if(file.endsWith('/'))mkdirSync(join(dir,file));else writeFileSync(join(dir,file),text);}
  return dir;
};
function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'starport-knowledge-data-')),store=new Store(join(dataDir,'hub.sqlite'));
  store.knowledge.companionName=id=>id==='painter'?'画师':null;
  return {store,dataDir};
}

test('folders hang on a room, a conversation or a companion, and leave with them',()=>{
  const {store}=fixture();
  try{
    const papers=folder('papers'),notes=folder('notes'),room=store.group('对偶'),chat=store.newChat({group_id:room.id,workspace:folder('work')});
    const added=store.knowledge.add('room',room.id,papers);
    assert.equal(added.name,papers.split(/[\\/]/).pop());
    store.knowledge.add('chat',chat.id,notes);store.knowledge.add('companion','painter',notes);
    assert.deepEqual(store.knowledge.list('room',room.id).map(row=>row.canonical),[papers]);
    assert.throws(()=>store.knowledge.add('room',room.id,papers),/已经在知识库里/);
    assert.throws(()=>store.knowledge.add('room','missing',papers),e=>e.status===404);
    assert.throws(()=>store.knowledge.add('companion','nobody',papers),e=>e.status===404);
    assert.throws(()=>store.knowledge.add('project',room.id,papers),/位置无效/);
    // A companion's desk is Starport's own machinery, not a conversation of the user's.
    const desk=store.newChat({workspace:chat.workspace,options:{codex:{},desk:{parentChatId:chat.id,companionId:'painter'}}});
    assert.throws(()=>store.knowledge.add('chat',desk.id,papers),e=>e.status===404);
    store.knowledge.remove(added.id);assert.deepEqual(store.knowledge.list('room',room.id),[]);
    store.knowledge.add('room',room.id,papers);
    store.deleteChat(chat.id);assert.deepEqual(store.knowledge.list('chat',chat.id),[]);
    store.deleteGroup(room.id);assert.deepEqual(store.knowledge.list('room',room.id),[]);
    store.knowledge.removeOwner('companion','painter');assert.deepEqual(store.knowledge.list('companion','painter'),[]);
  }finally{store.close();}
});

test('a drive, the home folder, Starport data and missing paths cannot become knowledge',()=>{
  const {store,dataDir}=fixture();
  try{
    const room=store.group('Room');
    for(const [path,pattern] of [[process.platform==='win32'?'C:\\':'/',/整个磁盘/],[homedir(),/用户主目录/],[join(homedir(),'.ssh'),/凭据|不存在/],
      [realpathSync.native(dataDir),/星港数据/],[join(tmpdir(),'starport-no-such-folder'),/不存在/],['relative/path',/完整路径/]])
      assert.throws(()=>store.knowledge.add('room',room.id,path),pattern,path);
  }finally{store.close();}
});

test('a turn reads its room, conversation and working companion folders, and nothing in exam or Starport desks',()=>{
  const {store}=fixture();
  try{
    const outer=folder('outer',{'work/':''}),work=join(outer,'work'),room=store.group('Room'),chat=store.newChat({group_id:room.id,workspace:work,title:'Chat'});
    const shared=folder('shared'),own=folder('own'),skills=folder('skills');
    store.knowledge.add('room',room.id,shared);store.knowledge.add('chat',chat.id,own);store.knowledge.add('chat',chat.id,shared);
    store.knowledge.add('companion','painter',skills);
    assert.deepEqual(store.knowledge.forRun(chat).folders.map(f=>[f.scope,f.canonical]),[['room',shared],['chat',own]],'the same folder twice is read once');
    const desk=meta=>store.newChat({workspace:work,options:{codex:{},desk:{parentChatId:chat.id,...meta}}});
    assert.deepEqual(store.knowledge.forRun(desk({companionId:'painter'})).folders.map(f=>f.scope),['room','chat','companion']);
    for(const meta of [{companionId:'painter',exam:true},{planner:true},{}])assert.deepEqual(store.knowledge.forRun(desk(meta)).folders,[]);
    assert.deepEqual(store.knowledge.forRun(chat,{bare:true}).folders,[]);
    // A folder holding the working folder would make the work read-only; a deleted one is gone.
    store.knowledge.add('chat',chat.id,outer);rmSync(own,{recursive:true});
    const run=store.knowledge.forRun(chat);
    assert.deepEqual(run.folders.map(f=>f.canonical),[shared]);
    assert.equal(run.notices.length,2);assert.match(run.notices.join('\n'),/找不到了[\s\S]*包含工作目录/);
  }finally{store.close();}
});

test('the prompt lists each folder with its top level; a resumed session hears only of changes',()=>{
  const {store}=fixture();
  try{
    const papers=folder('papers',{'b.pdf':'','a.md':'','notes/':'','.hidden':''}),room=store.group('对偶'),chat=store.newChat({group_id:room.id,workspace:folder('work')});
    store.knowledge.add('room',room.id,papers);
    const {folders}=store.knowledge.forRun(chat),text=store.knowledge.sessionPrompt(folders,null);
    assert.match(text,/星港知识库/);assert.ok(text.includes(papers));assert.match(text,/房间「对偶」/);
    assert.match(text,/顶层 3 项：notes\/、a\.md、b\.pdf/);assert.doesNotMatch(text,/hidden/);assert.match(text,/只读/);
    const prior={fingerprint:store.knowledge.fingerprint(folders)};
    assert.equal(store.knowledge.sessionPrompt(folders,prior),'');
    assert.match(store.knowledge.sessionPrompt([],prior),/现在没有挂载的知识库/);
    assert.equal(store.knowledge.sessionPrompt([],{}),'');
    assert.match(store.knowledge.sessionPrompt(folders,{}),/^星港知识库更新/);
  }finally{store.close();}
});

test('the runner gives the tool the folders and the prompt, and repeats the list only when it changes',{timeout:15000},async()=>{
  const {store}=fixture(),calls=[];
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[],externalTools:{workspace:'x',tools:[]}}),probe:async()=>({}),record(){}};
  const runner=new Runner(store,registry,()=>{},{codex:async args=>{calls.push(args);args.emit({type:'session',id:'native-1'});args.emit({type:'replace',text:'ok'});args.emit({type:'final-answer',text:'ok'});}});
  try{
    const work=folder('work'),papers=folder('papers',{'a.md':''}),room=store.group('Room'),chat=store.newChat({group_id:room.id,workspace:work});
    store.knowledge.add('room',room.id,papers);
    const turn=async text=>{await runner.start(chat.id,text);await runner.active.get(chat.id)?.done;return calls.at(-1);};
    const first=await turn('one');
    assert.deepEqual(first.knowledgeDirs,[papers]);assert.deepEqual(first.runtime.externalTools.knowledge,[papers]);
    assert.ok(first.prompt.includes(papers));
    assert.equal(store.lastAssistant(chat.id).details.knowledge.folders[0].path,papers);
    const second=await turn('two');
    assert.equal(second.session,'native-1');assert.doesNotMatch(second.prompt,/星港知识库/);assert.deepEqual(second.knowledgeDirs,[papers]);
    const more=folder('more');store.knowledge.add('chat',chat.id,more);
    const third=await turn('three');
    assert.match(third.prompt,/星港知识库更新/);assert.ok(third.prompt.includes(more));assert.deepEqual(third.knowledgeDirs,[papers,more]);
  }finally{await runner.close();store.close();}
});

test('Claude may read knowledge folders but not edit them; agy adds them to its workspace; the terminal reads them',async()=>{
  const seen=[];
  const makeQuery=({prompt,options})=>({close(){},async *[Symbol.asyncIterator](){
    seen.push(options);await prompt[Symbol.asyncIterator]().next();
    yield {type:'system',subtype:'init',session_id:'s',model:'m'};
    yield {type:'result',subtype:'success',session_id:'s',result:'Done',num_turns:1,usage:{output_tokens:1}};
  }});
  const base={runtime:{command:process.execPath,prefixArgs:[]},options:{permissionMode:'acceptEdits'},prompt:'test',cwd:process.cwd(),emit:()=>{},setControl:()=>{},makeQuery};
  await runClaude({...base,knowledgeDirs:['D:\\Papers\\对偶']});
  assert.deepEqual(seen[0].additionalDirectories,['D:\\Papers\\对偶']);
  assert.deepEqual(seen[0].disallowedTools,['Edit(//d/Papers/对偶/**)']);
  await runClaude(base);
  assert.equal(seen[1].additionalDirectories,undefined);assert.equal(seen[1].disallowedTools,undefined);

  const args=cliArguments('antigravity',validateOptions('antigravity',{}),'conversation',['D:\\Papers','E:\\Notes']);
  assert.deepEqual(args.slice(args.indexOf('--add-dir'),args.indexOf('--add-dir')+4),['--add-dir','D:\\Papers','--add-dir','E:\\Notes']);
  assert.ok(args.indexOf('--add-dir')<args.indexOf('--conversation'));
  assert.equal(cliArguments('antigravity',validateOptions('antigravity',{})).includes('--add-dir'),false);

  const work=folder('terminal'),papers=folder('papers');
  const fs=workspaceFilesystem(work,{workspace:work,tools:[],knowledge:[papers]});
  assert.equal(fs[work],'write');assert.equal(fs[papers],'read');
});

test('HTTP lists a conversation with its room folders and manages companion folders',{timeout:15000},async t=>{
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),list:async()=>[],record:()=>{}};
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-knowledge-hub-')),registry});
  const port=await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+port+'/api/knowledge',headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  const call=(path,method='GET',body)=>fetch(base+path,{method,headers,...body?{body:JSON.stringify(body)}:{}});
  const room=hub.store.group('Room'),chat=hub.store.newChat({group_id:room.id,workspace:folder('work')}),papers=folder('papers');
  assert.equal((await fetch(base+'?scope=room&owner='+room.id)).status,401);
  assert.equal((await call('','POST',{scope:'room',owner:room.id,path:papers})).status,201);
  const listed=await (await call('?scope=chat&owner='+chat.id)).json();
  assert.deepEqual(listed.folders,[]);assert.equal(listed.inherited.name,'Room');assert.equal(listed.inherited.folders[0].canonical,papers);
  assert.equal((await call('','POST',{scope:'room',owner:room.id,path:'relative'})).status,400);
  assert.equal((await call('?scope=chat&owner=missing')).status,404);
  hub.workflows.createCompanion({name:'画师',provider:'codex'},{id:'painter'});
  const added=await (await call('','POST',{scope:'companion',owner:'painter',path:papers})).json();
  assert.equal((await (await call('?scope=companion&owner=painter')).json()).folders[0].id,added.id);
  assert.equal((await call('/'+added.id,'DELETE')).status,200);
  assert.equal((await call('/'+added.id,'DELETE')).status,404);
  hub.store.knowledge.add('companion','painter',papers);hub.workflows.deleteCompanion('painter');
  assert.deepEqual(hub.store.knowledge.list('companion','painter'),[]);
});

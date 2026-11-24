import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Store } from '../src/storage.mjs';
import { Runner } from '../src/runner.mjs';
import { ensureSchema } from '../src/workflows/schema.mjs';
import { knowledgeRequested } from '../src/knowledge.mjs';
import { contextToolHost } from '../src/context-tools.mjs';

const folder=name=>realpathSync.native(mkdtempSync(join(tmpdir(),'starport-save-'+name+'-')));
function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'starport-save-data-')),store=new Store(join(dataDir,'hub.sqlite'));
  ensureSchema(store.db);
  const names={painter:'画师',scout:'探子'};
  store.knowledge.companionName=id=>names[id]??null;
  const now=new Date().toISOString();
  for(const id of Object.keys(names))store.db.prepare('INSERT INTO companions(id,data,created,updated) VALUES(?,?,?,?)').run(id,JSON.stringify({name:names[id]}),now,now);
  const work=folder('work'),room=store.group('对偶'),chat=store.newChat({group_id:room.id,workspace:work,title:'Chat'});
  store.db.prepare('INSERT INTO room_members(group_id,companion_id,added) VALUES(?,?,?)').run(room.id,'painter',now);
  const papers=folder('papers'),notes=folder('notes'),art=folder('art'),scouting=folder('scouting');
  store.knowledge.add('room',room.id,papers);store.knowledge.add('chat',chat.id,notes);
  store.knowledge.add('companion','painter',art);store.knowledge.add('companion','scout',scouting);
  return {store,work,room,chat,papers,notes,art,scouting};
}

test('only the user asking for the knowledge base unlocks a save',()=>{
  for(const text of ['把这篇论文下载到房间知识库','存进画师的知识库里','Save it to the knowledge base','put this in the reference material','放到资料库'])assert.equal(knowledgeRequested(text),true,text);
  for(const text of ['下载这篇论文','my knowledge of group theory','参考一下资料','',null])assert.equal(knowledgeRequested(text),false,String(text));
});

test('a conversation may save into its room, itself and its room companions; only @-mentioned companions among desks',()=>{
  const f=fixture();
  try{
    assert.deepEqual(f.store.knowledge.writeTargets(f.chat).map(t=>[t.scope,t.canonical]),[['room',f.papers],['chat',f.notes],['companion',f.art]],'a companion outside the room is not offered');
    const desk=meta=>f.store.newChat({workspace:f.work,options:{codex:{},desk:{parentChatId:f.chat.id,...meta}}});
    assert.deepEqual(f.store.knowledge.writeTargets(desk({companionId:'scout',persistent:true})).map(t=>t.scope),['room','chat','companion']);
    assert.equal(f.store.knowledge.writeTargets(desk({companionId:'scout',persistent:true})).at(-1).canonical,f.scouting);
    for(const meta of [{companionId:'painter',call:true},{companionId:'painter',exam:true},{companionId:'painter',mountId:'m'},{planner:true}])
      assert.deepEqual(f.store.knowledge.writeTargets(desk(meta)),[],JSON.stringify(meta));
  }finally{f.store.close();}
});

test('a save copies a working-folder file into the named knowledge folder and never overwrites unasked',async()=>{
  const f=fixture();
  try{
    const targets=f.store.knowledge.writeTargets(f.chat),save=args=>f.store.knowledge.save(targets,args,{workspace:f.work});
    writeFileSync(join(f.work,'paper.pdf'),'v1');
    const saved=await save({folder:f.art,path:'paper.pdf',subfolder:'refs/2026'});
    assert.equal(saved.saved,join(f.art,'refs','2026','paper.pdf'));assert.equal(saved.knowledge.owner,'画师');assert.equal(saved.bytes,2);
    await assert.rejects(save({folder:f.art,path:'paper.pdf',subfolder:'refs/2026'}),/已有同名文件/);
    writeFileSync(join(f.work,'paper.pdf'),'v2');
    await save({folder:f.art,path:'paper.pdf',subfolder:'refs/2026',overwrite:true});
    assert.equal(readFileSync(saved.saved,'utf8'),'v2');
    const byName=await save({folder:f.papers.split(/[\\/]/).pop(),path:'paper.pdf',name:'对偶.pdf'});
    assert.equal(byName.saved,join(f.papers,'对偶.pdf'));
    await assert.rejects(save({folder:'nowhere',path:'paper.pdf'}),/没有这个知识库。可以存到/);
    await assert.rejects(save({folder:f.art,path:'paper.pdf',subfolder:'../escape'}),/相对路径/);
    await assert.rejects(save({folder:f.art,path:'paper.pdf',name:'a/b.pdf'}),/只写文件名/);
    await assert.rejects(save({folder:f.art,path:join(f.papers,'对偶.pdf')}),/工作目录里的文件/);
    await assert.rejects(save({folder:f.art,path:'missing.pdf'}),/工作目录里的文件/);
    await assert.rejects(save({folder:f.art}),/只能给一个/);
    await assert.rejects(save({folder:f.art,url:'https://example.com/a',path:'paper.pdf'}),/只能给一个/);
  }finally{f.store.close();}
});

test('a download follows redirects, takes its name from the server and refuses this computer by default',{timeout:15000},async t=>{
  const f=fixture();
  const server=createServer((req,res)=>{
    if(req.url==='/moved'){res.writeHead(302,{Location:'/files/notes.txt'});res.end();return;}
    if(req.url==='/files/notes.txt'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('closure error 3.2e-3');return;}
    if(req.url==='/download'){res.writeHead(200,{'Content-Disposition':"attachment; filename*=UTF-8''%E8%AE%BA%E6%96%87.pdf"});res.end('pdf');return;}
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.close();f.store.close();});
  const base='http://127.0.0.1:'+server.address().port,targets=f.store.knowledge.writeTargets(f.chat);
  const save=args=>f.store.knowledge.save(targets,args,{workspace:f.work});
  await assert.rejects(save({folder:f.notes,url:base+'/moved'}),/不能从本机地址下载/);
  assert.equal(existsSync(join(f.notes,'notes.txt')),false);
  f.store.knowledge.checkHost=async()=>{};
  const moved=await save({folder:f.notes,url:base+'/moved'});
  assert.equal(moved.saved,join(f.notes,'notes.txt'));assert.equal(readFileSync(moved.saved,'utf8'),'closure error 3.2e-3');
  assert.equal((await save({folder:f.notes,url:base+'/download'})).saved,join(f.notes,'论文.pdf'));
  await assert.rejects(save({folder:f.notes,url:base+'/missing'}),/HTTP 404/);
  await assert.rejects(save({folder:f.notes,url:'file:///C:/Windows/win.ini'}),/http\/https/);
  assert.deepEqual(f.store.knowledge.list('chat',f.chat.id).length,1);
});

test('the tools are offered only with save targets, and refuse a turn where the user did not ask',async()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.work,'a.txt'),'x');
    const targets=f.store.knowledge.writeTargets(f.chat);let said='下载这篇论文';
    const host=contextToolHost({store:f.store,chat:f.chat,messages:()=>[],knowledge:{targets,workspace:f.work,requestText:()=>said}});
    assert.ok(host.definitions.some(d=>d.name==='starport_knowledge_save'));
    assert.deepEqual((await host.call('starport_knowledge_folders',{})).folders.map(row=>row.owner),['对偶','Chat','画师']);
    await assert.rejects(host.call('starport_knowledge_save',{folder:f.papers,path:'a.txt'}),/没有明确要求存进知识库/);
    assert.equal(existsSync(join(f.papers,'a.txt')),false);
    said='把 a.txt 存进房间知识库';
    assert.equal((await host.call('starport_knowledge_save',{folder:f.papers,path:'a.txt'})).saved,join(f.papers,'a.txt'));
    const plain=contextToolHost({store:f.store,chat:f.chat,messages:()=>[]});
    assert.equal(plain.definitions.some(d=>d.name.startsWith('starport_knowledge')),false);
  }finally{f.store.close();}
});

test('the runner hands the save tools to a conversation turn, which saves only when this turn asked',{timeout:15000},async()=>{
  const f=fixture(),seen=[];
  writeFileSync(join(f.work,'fig.png'),'png');
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),record(){}};
  const runner=new Runner(f.store,registry,()=>{},{codex:async args=>{
    const names=args.contextTools?.definitions.map(d=>d.name)||[];
    let result;try{result=await args.contextTools.call('starport_knowledge_save',{folder:f.art,path:'fig.png'});}catch(error){result={error:error.message};}
    seen.push({names,prompt:args.prompt,result});
    args.emit({type:'replace',text:'ok'});args.emit({type:'final-answer',text:'ok'});
  }});
  try{
    const turn=async text=>{await runner.start(f.chat.id,text);await runner.active.get(f.chat.id)?.done;return seen.at(-1);};
    const plain=await turn('看看这张图');
    assert.ok(plain.names.includes('starport_knowledge_save'));assert.match(plain.prompt,/starport_knowledge_save/);
    assert.match(plain.result.error,/没有明确要求/);assert.equal(existsSync(join(f.art,'fig.png')),false);
    const asked=await turn('把 fig.png 存到画师的知识库');
    assert.equal(asked.result.saved,join(f.art,'fig.png'));
    // A desk for a call never saves, whatever the conversation said.
    const desk=f.store.newChat({workspace:f.work,options:{codex:{},desk:{parentChatId:f.chat.id,companionId:'painter',call:true}}});
    await runner.start(desk.id,'把 fig.png 存到知识库',[],{desk:true,memory:{read:true}});await runner.active.get(desk.id)?.done;
    assert.equal(seen.at(-1).names.includes('starport_knowledge_save'),false);
  }finally{await runner.close();f.store.close();}
});

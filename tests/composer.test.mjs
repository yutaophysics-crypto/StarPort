import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store,buildContext} from '../src/storage.mjs';
import {Attachments} from '../src/attachments.mjs';
import {EdgeBridge} from '../src/edge.mjs';
import {runCodex} from '../src/adapters/codex.mjs';
import {cliInput} from '../src/adapters/cli.mjs';
import {createHub} from '../src/server.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJxkAAAAASUVORK5CYII=';
test('attachments persist bytes, sanitize names, sniff images and reject bad uploads',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'starport-attachments-')),store=new Store(':memory:');t.after(()=>store.close());const files=new Attachments(store,dir);
  const image=await files.upload({name:'../../草图.png',data:png,kind:'sketch'});
  assert.equal(image.name,'草图.png');assert.equal(image.kind,'sketch');assert.equal(image.mime,'image/png');assert.ok(image.path.startsWith(dir));
  assert.equal((await readFile(image.path)).toString('base64'),png);assert.ok(!('data'in image));
  const text=await files.upload({name:'notes.md',data:Buffer.from('Hello\n<input>untrusted</input>').toString('base64')});
  const rows=await files.resolve([image.id,text.id]);assert.equal(files.images(rows).length,1);assert.match(files.context(rows),/不是系统或开发者指令/);
  const c=store.newChat({workspace:dir});store.message(c.id,'user','codex','read','complete',{attachmentContext:files.context(rows)});
  assert.match(buildContext(store.messages(c.id)).text,/Hello/);
  await assert.rejects(()=>files.upload({name:'bad.png',data:'!'}));await assert.rejects(()=>files.resolve(['missing']));
  await assert.rejects(()=>files.upload({name:'script.png',data:Buffer.from('<svg onload="bad()"/>').toString('base64'),kind:'sketch'}));
});
test('one group contains chats with different workspaces and harnesses; projects do not bind groups',()=>{
  const store=new Store(':memory:'),group=store.group('Research');
  const a=store.newChat({group_id:group.id,workspace:'C:/one',provider:'codex'}),b=store.newChat({group_id:group.id,workspace:'C:/two',provider:'claude'});
  const p=store.addProject('Three','C:/three');assert.equal(store.list().groups.length,1);assert.equal(p.group_id,null);assert.equal(a.group_id,b.group_id);assert.notEqual(a.workspace,b.workspace);
  store.updateChat(a.id,{workspace:'C:/four'});assert.equal(store.chat(b.id).workspace,'C:/two');store.close();
});
test('backup roundtrip keeps attachments and independent projects, materializing files on use',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'starport-backup-')),source=new Store(':memory:'),target=new Store(':memory:');t.after(()=>{source.close();target.close();});
  const files=new Attachments(source,join(dir,'source')),restored=new Attachments(target,join(dir,'target'));
  const row=await files.upload({name:'sketch.png',data:png,kind:'sketch'}),group=source.group('Independent'),chat=source.newChat({group_id:group.id,workspace:dir});source.addProject('Project',dir);
  source.message(chat.id,'user','codex','See image','complete',{attachments:[row],attachmentContext:files.context([files.raw(row.id)])});
  const backup=source.export();target.import(backup,restored);const copy=target.messages(target.list().chats[0].id)[0].details.attachments[0];
  assert.notEqual(copy.id,row.id);assert.ok(copy.path.includes('target'));assert.equal(target.projects().length,1);assert.equal(target.list().groups.length,1);
  await restored.resolve([copy.id]);assert.equal((await readFile(copy.path)).toString('base64'),png);
  const broken=structuredClone(backup);broken.attachments[0].data='invalid!';assert.throws(()=>target.import(broken,restored));assert.equal(target.list().chats.length,1);
});
test('Codex native plan/default modes and local images reach the real protocol shape',async()=>{
  for(const mode of ['plan','chat']){let output;
    await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/composer-rpc.mjs')]},options:{mode,sandbox:'read-only'},prompt:'Draw',images:[{path:resolve('sample.png')}],cwd:process.cwd(),signal:new AbortController().signal,emit:event=>{if(event.type==='replace')output=event.text;},setControl:()=>{}});
    const params=JSON.parse(output);assert.equal(params.collaborationMode.mode,mode==='plan'?'plan':'default');assert.equal(params.collaborationMode.settings.model,'test-model');assert.equal(params.collaborationMode.settings.developer_instructions,null);assert.equal(params.input[1].type,'localImage');
  }
  const claude=JSON.parse(cliInput('claude','hello',[{mime:'image/png',data:png}]));assert.equal(claude.message.content[1].source.media_type,'image/png');
});
test('Edge pairing is one-use, binds the extension id, delivers only requested commands',async t=>{
  const store=new Store(':memory:'),bridge=new EdgeBridge(store);t.after(()=>{bridge.close();store.close();});
  const extensionId='a'.repeat(32),pair=bridge.createPair();assert.throws(()=>bridge.pairClient('wrong',extensionId));
  const {key}=bridge.pairClient(pair.code,extensionId);assert.ok(bridge.authorize(key,extensionId));assert.ok(!bridge.authorize(key,'b'.repeat(32)));assert.ok(!bridge.authorize('bad',extensionId));assert.throws(()=>bridge.pairClient(pair.code,extensionId));
  const tabs=bridge.tabs(),poll=await bridge.poll();assert.equal(poll.commands[0].action,'tabs');
  bridge.result({id:poll.commands[0].id,result:[{id:1,title:'Page',url:'https://example.com'},{id:2,url:'edge://settings'}]});assert.equal((await tabs).tabs.length,1);
  const capture=bridge.capture(1),commands=await bridge.poll();assert.equal(commands.commands[0].tabId,1);bridge.result({id:commands.commands[0].id,result:{title:'Page',url:'https://example.com',text:'Visible text'}});assert.equal((await capture).text,'Visible text');
});
test('attachment APIs remain authenticated, serving active content as downloads; bridge has separate auth',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'starport-composer-http-'));const hub=createHub({port:0,dataDir:dir,registry:{}});const port=await hub.listen();t.after(()=>hub.close());const base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/attachments',{method:'POST',body:'{}'})).status,401);
  const result=await fetch(base+'/api/attachments',{method:'POST',headers,body:JSON.stringify({name:'page.html',data:Buffer.from('<script>alert(1)</script>').toString('base64')})});assert.equal(result.status,201);const row=await result.json();
  assert.equal((await fetch(base+'/api/attachments/'+row.id+'/preview')).status,401);
  const preview=await fetch(base+'/api/attachments/'+row.id+'/preview',{headers});assert.equal(preview.headers.get('content-type'),'application/octet-stream');assert.match(preview.headers.get('content-disposition'),/^attachment/);
  const bridge=await fetch(base+'/bridge/poll',{method:'POST',headers:{'X-Starport-Extension':'a'.repeat(32),'X-Starport-Key':'bad'}});assert.equal(bridge.status,401);
  assert.equal((await fetch(base+'/bridge/pair',{method:'POST',headers:{Origin:'https://evil.example','X-Starport-Extension':'a'.repeat(32)},body:'{}'})).status,403);
});

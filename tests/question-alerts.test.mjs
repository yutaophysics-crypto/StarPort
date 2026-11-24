import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createHub } from '../src/server.mjs';
import { chimeWav, QUESTION_CHIME } from '../src/notifications.mjs';
import { WindowsNotifier } from '../src/notifier-windows.mjs';

const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record(){},list:async()=>[]};
const until=async check=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture did not reach expected state');};
const questions=[{id:'scale',question:'先放大**粗粒化尺度**，还是先换成动量壳方案？',options:[{label:'放大尺度'},{label:'动量壳'}]},{id:'more',question:'第二个问题'}];

// The model asks (a question or a permission, by the prompt) and waits until it is answered.
async function fixture(){
  const dataDir=await mkdtemp(join(tmpdir(),'starport-ask-'));
  const notifier={available:true,shown:[],show(item){this.shown.push(item);},dismiss(){},close(){}};
  // Only the end of the prompt is the new message; Starport's own instructions come before it.
  const codex=async({emit,prompt:full,setControl,signal})=>{
    const prompt=full.slice(-30),kind=prompt.includes('批准')?'permission':prompt.includes('提问')?'question':null;
    if(kind){
      let answered;const waiting=new Promise(resolve=>answered=resolve);
      setControl({stop:async()=>answered(),answer:async id=>{emit({type:'approval-resolved',id});answered();}});
      emit({type:'approval',request:{id:'ask-1',provider:'codex',kind,method:'item/tool/requestUserInput',params:kind==='question'?{questions}:{command:'rm -rf build'}}});
      await waiting;if(signal.aborted)throw Object.assign(new Error('已停止'),{canceled:true});
    }
    emit({type:'replace',text:'好的，按你的选择继续。'});emit({type:'final-answer',text:'好的，按你的选择继续。'});
  };
  const hub=createHub({port:0,dataDir,registry,implementations:{codex},notifier});
  hub.notifications.report('fixture-language',{language:'zh'});
  await hub.listen();
  const room=hub.store.group('科研'),chat=hub.store.newChat({group_id:room.id,provider:'codex',workspace:dataDir,title:'计算衍生论'});
  return {hub,notifier,chat,dataDir,close:()=>hub.close()};
}

test('a model that stops to ask the user raises a question popup and marks its chat until answered',{timeout:15000},async()=>{
  const f=await fixture();
  try{
    const started=await f.hub.runner.start(f.chat.id,'请向我提问');
    await until(()=>f.notifier.shown.length===1);
    const item=f.notifier.shown[0];
    assert.equal(item.tone,'question');assert.equal(item.state,'等你回答');assert.equal(item.kind,'question');
    assert.equal(item.chatId,f.chat.id);assert.equal(item.title,'计算衍生论');assert.equal(item.source,'星港 · 科研');
    assert.equal(item.body,'先放大粗粒化尺度，还是先换成动量壳方案？（另有 1 个问题）');assert.equal(item.sound,true);
    assert.deepEqual(f.hub.runner.asking(),[f.chat.id]);
    assert.deepEqual(f.hub.runner.live(null).asking,[f.chat.id],'pages that load the list learn of it too');
    await f.hub.runner.answer(f.chat.id,'ask-1',{decision:'accept',answers:{scale:'放大尺度'}});
    assert.deepEqual(f.hub.runner.asking(),[],'answered: the chat is only running again');
    await started.done;await until(()=>!f.hub.runner.active.has(f.chat.id));
    assert.deepEqual(f.notifier.shown.map(shown=>shown.tone),['question','complete'],'finishing still says done, separately');
  }finally{await f.close();}
});

test('permission requests, desks and a chat the user is looking at raise no question popup',{timeout:15000},async()=>{
  const f=await fixture();
  try{
    const permission=await f.hub.runner.start(f.chat.id,'请批准这个命令');
    await until(()=>f.hub.runner.state(f.chat.id)?.approvals.length===1);
    assert.deepEqual(f.hub.runner.asking(),[]);assert.equal(f.notifier.shown.length,0);
    const base = "http://127.0.0.1:" + f.hub.server.address().port;
    const headers = { "X-Hub-Token": f.hub.token };
    for (const path of ["/api/state", "/api/live"]) {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).awaitingApproval, [f.chat.id]);
    }
    assert.deepEqual(f.hub.runner.packet(f.chat.id).awaitingApproval,[f.chat.id]);
    await f.hub.runner.answer(f.chat.id,'ask-1',{decision:'accept'});
    assert.deepEqual(f.hub.runner.live(null).awaitingApproval,[]);
    await permission.done;await until(()=>!f.hub.runner.active.has(f.chat.id));

    const rejected=await f.hub.runner.start(f.chat.id,'请批准这个命令');
    await until(()=>f.hub.runner.awaitingApproval().length===1);
    await f.hub.runner.answer(f.chat.id,'ask-1',{decision:'decline'});
    assert.deepEqual(f.hub.runner.awaitingApproval(),[]);
    await rejected.done;await until(()=>!f.hub.runner.active.has(f.chat.id));
    f.notifier.shown.length=0;

    const desk=f.hub.store.newChat({provider:'codex',workspace:f.dataDir,options:{codex:{},desk:{parentChatId:f.chat.id,companionId:'x'}}});
    const unattended=await f.hub.runner.start(desk.id,'请向我提问',[],{desk:true});
    await until(()=>f.hub.runner.state(desk.id)?.approvals.length===1);
    assert.equal(f.notifier.shown.length,0);
    await f.hub.runner.stop(desk.id);await unattended.done.catch(()=>{});

    f.hub.notifications.connect('page-watching-1');
    f.hub.notifications.report('page-watching-1',{focused:true,visible:true,chatId:f.chat.id});
    const watched=await f.hub.runner.start(f.chat.id,'请向我提问');
    await until(()=>f.hub.runner.asking().length===1);
    assert.equal(f.notifier.shown.length,0,'the question is already on screen');
    await f.hub.runner.stop(f.chat.id);await watched.done.catch(()=>{});
  }finally{await f.close();}
});

test('the page keeps a waiting-for-you list from run pushes and shows it apart from running',async()=>{
  const context=vm.createContext({});vm.runInContext(await readFile(new URL('../public/live.js',import.meta.url),'utf8'),context);
  const live=context.StarportLive,state={active:[],asking:[],messages:[],chats:[]};
  const run=approvals=>({id:'run',approvals});
  let change=live.applyUpdate(state,{chatId:'c1',run:run([{id:'q',kind:'question'}])});
  assert.deepEqual([...state.asking],['c1']);assert.deepEqual([...state.active],['c1']);assert.equal(change.activeChanged,true);
  change=live.applyUpdate(state,{chatId:'c1',run:run([])});
  assert.deepEqual([...state.asking],[]);assert.deepEqual([...state.active],['c1']);assert.equal(change.activeChanged,true);
  change=live.applyUpdate(state,{chatId:'c1',run:run([{id:'p',kind:'permission'}])});
  assert.deepEqual([...state.asking],[]);assert.deepEqual([...state.awaitingApproval],['c1']);assert.equal(change.activeChanged,true);
  change=live.applyUpdate(state,{chatId:'c1',run:run([])});
  assert.deepEqual([...state.awaitingApproval],[]);assert.deepEqual([...state.active],['c1']);assert.equal(change.activeChanged,true);
  live.applyUpdate(state,{chatId:'c2',run:run([{id:'q',kind:'question'}])});live.applyUpdate(state,{chatId:'c2',run:null});
  assert.deepEqual([...state.asking],[]);
  live.applyUpdate(state,{active:['c3','c4'],asking:['c3'],awaitingApproval:['c4']});
  assert.deepEqual([...state.asking],['c3']);assert.deepEqual([...state.awaitingApproval],['c4']);
  live.applyUpdate(state,{chatId:'c4',run:null});
  assert.deepEqual([...state.awaitingApproval],[]);

  const layout=readFileSync(new URL('../public/app-layout.js',import.meta.url),'utf8');
  assert.match(layout,/asking \? 'asking' : running \? 'running'/,'a waiting chat shows the question mark, not the spinner');
  assert.match(layout,/awaitingApproval \? 'awaiting-approval' : asking \? 'asking'/);
  const css=readFileSync(new URL('../public/chat-status.css',import.meta.url),'utf8');
  assert.match(css,/\.chat-status\.awaiting-approval::before\s*\{[^}]*content: '!'/);
  assert.match(css,/\.chat-status\.asking::before\s*\{[^}]*content: '\?'/);
});

test('a question has its own chime and popup colour on Windows',async()=>{
  const done=chimeWav(),asked=chimeWav(44100,QUESTION_CHIME);
  assert.notDeepEqual(asked,done);assert.ok((asked.length-44)/2/44100<1,'still short');
  const dataDir=await mkdtemp(join(tmpdir(),'starport-ask-chime-')),sent=[];
  const notifier=new WindowsNotifier({root:process.cwd(),dataDir,url:()=>'http://127.0.0.1:1/',platform:'win32'});
  notifier.send=message=>sent.push(message);
  notifier.show({tone:'question',sound:true});notifier.show({tone:'complete',sound:true});
  assert.match(sent[0].chime,/notify-question\.wav$/);assert.match(sent[1].chime,/notify-chime\.wav$/);
  assert.deepEqual(readFileSync(sent[0].chime),asked);
  const script=readFileSync(new URL('../scripts/notifier.ps1',import.meta.url),'utf8');
  assert.match(script,/'question' \{ \$palette\.Ask \}/);
  for(const theme of ['sea','port','deep-space'])assert.match(script,new RegExp(`'${theme}'\\s*= @\\{[^}]*Ask = '#[0-9A-F]{6}'`));
});

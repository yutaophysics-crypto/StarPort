import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/server.mjs';
import { excerpt, chimeWav, Notifications } from '../src/notifications.mjs';

const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true,nativeAutoReview:true}),models:async()=>({models:[]}),record(){},list:async()=>[]};
const until=async check=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture did not reach expected state');};
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};

test('popup text is a short plain summary of the Markdown reply',()=>{
  assert.equal(excerpt('**闭合误差**已经算完：在 $L=64$ 时误差降到 $3.2\\times10^{-3}$，$\\epsilon$ 很小。'),'闭合误差已经算完：在 L=64 时误差降到 3.2×10⁻³，ϵ 很小。');
  assert.equal(excerpt('# 结果\n\n- 第一项 `fit.py`\n- 见 [文档](http://example.com)\n\n```python\nprint(1)\n```\n$$E=mc^2$$\n完成 *好*'),'结果 第一项 fit.py 见 文档 [code] [formula] 完成 好');
  assert.equal(excerpt('```js\nconsole.log(1)\n```','120','en'),'[code]');
  const long=excerpt('长'.repeat(300));
  assert.equal([...long].length,120);assert.ok(long.endsWith('…'));
});

test('the chime is a short, quiet WAV',()=>{
  const wav=chimeWav();
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
  const rate=wav.readUInt32LE(24),samples=(wav.length-44)/2;
  assert.ok(samples/rate>0.4&&samples/rate<0.8,'about half a second');
  let peak=0;for(let i=44;i<wav.length;i+=2)peak=Math.max(peak,Math.abs(wav.readInt16LE(i)));
  assert.ok(peak>0.1*32767&&peak<0.3*32767,'audible but well below full scale');
  assert.ok(Math.abs(wav.readInt16LE(wav.length-2))<200,'ends without a click');
});

async function fixture({language='zh'}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'starport-notify-')),holds=new Map();
  const notifier={available:true,shown:[],dismissed:0,show(item){this.shown.push(item);},dismiss(){this.dismissed++;},close(){}};
  // Only the end of the prompt is the new message; earlier turns come before it as context.
  const codex=async({emit,prompt:full,signal})=>{
    const prompt=full.slice(-60);
    if(prompt.includes('等一等')){const hold=gate();holds.set(prompt.match(/等一等(\w+)/)[1],hold);await Promise.race([hold.promise,new Promise(r=>signal.addEventListener('abort',r))]);}
    if(signal.aborted)throw Object.assign(new Error('已停止'),{canceled:true});
    if(prompt.includes('失败'))throw new Error('模拟的工具错误：python fit.py 返回 1');
    const text='**闭合误差**已经算完，宏观层基本自洽。';emit({type:'replace',text});emit({type:'final-answer',text});
  };
  const hub=createHub({port:0,dataDir,registry,implementations:{codex},notifier});
  if(language)hub.notifications.report('fixture-language',{language});
  const port=await hub.listen(),base='http://127.0.0.1:'+port,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  const api=async(path,method='GET',data)=>{const response=await fetch(base+'/api'+path,{method,headers,body:data?JSON.stringify(data):undefined});return {status:response.status,data:await response.json()};};
  const room=hub.store.group('科研');
  const chat=hub.store.newChat({group_id:room.id,provider:'codex',workspace:dataDir,title:'计算衍生论'});
  const other=hub.store.newChat({provider:'codex',workspace:dataDir,title:'拓扑序数值验证'});
  // An open page: its event stream, and what it reports about itself.
  const page=async(client)=>{
    const controller=new AbortController(),response=await fetch(base+'/api/events?client='+client,{headers,signal:controller.signal});
    const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
    (async()=>{try{for(;;){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value);}}catch{}})();
    await until(()=>hub.notifications.live().length>0);
    return {get text(){return text;},report:data=>api('/presence','POST',{client,...data}),close:()=>controller.abort()};
  };
  const run=async(id,text)=>{const started=await hub.runner.start(id,text);await started.done.catch(()=>{});await until(()=>!hub.runner.active.has(id));return started;};
  return {hub,notifier,api,chat,other,page,run,holds,close:()=>hub.close()};
}

test('new installations notify in English and retain an explicit Chinese preference',async()=>{
  const f=await fixture({language:null});
  try{
    assert.equal(f.hub.notifications.look.language,'en');
    await f.run(f.chat.id,'A fresh installation');
    assert.equal(f.notifier.shown[0].language,'en');
    assert.equal(f.notifier.shown[0].state,'Done');
    f.hub.notifications.report('fixture-language',{language:'zh'});
    const restored=new Notifications({store:f.hub.store});
    assert.equal(restored.look.language,'zh');
  }finally{await f.close();}
});

test('a finished task reports its chat, room and result, plays the chime and flashes the taskbar',async()=>{
  const f=await fixture();
  try{
    await f.run(f.chat.id,'自洽闭合误差最小是什么意思？');
    assert.equal(f.notifier.shown.length,1);
    const item=f.notifier.shown[0];
    assert.equal(item.chatId,f.chat.id);assert.equal(item.title,'计算衍生论');assert.equal(item.source,'星港 · 科研');
    assert.equal(item.state,'已完成');assert.equal(item.tone,'complete');assert.equal(item.body,'闭合误差已经算完，宏观层基本自洽。');
    assert.equal(item.sound,true);assert.equal(item.flash,true,'no Starport window is in front');
    assert.equal(item.theme,'sea');assert.equal(item.language,'zh');

    await f.run(f.other.id,'这一步会失败');
    const failed=f.notifier.shown[1];
    assert.equal(failed.tone,'error');assert.equal(failed.state,'出错了');assert.equal(failed.source,'星港');
    assert.match(failed.body,/模拟的工具错误/);
  }finally{await f.close();}
});

test('nothing is shown for the chat in front of the user, a stopped task, a desk run, or while do-not-disturb is on',async()=>{
  const f=await fixture();
  try{
    const page=await f.page('page-watching-1');
    await page.report({focused:true,visible:true,chatId:f.chat.id,theme:'port',language:'zh'});
    await f.run(f.chat.id,'看着它完成');
    assert.equal(f.notifier.shown.length,0,'the user is looking at this chat');

    await f.run(f.other.id,'另一个对话');
    assert.equal(f.notifier.shown.length,1,'another chat still notifies');
    assert.equal(f.notifier.shown[0].flash,false,'Starport is already in front, so the taskbar stays calm');
    assert.equal(f.notifier.shown[0].theme,'port','the popup follows the page theme');

    await page.report({focused:false,visible:true,chatId:f.chat.id});
    await f.run(f.chat.id,'切走以后完成');
    assert.equal(f.notifier.shown.length,2,'a page in the background does not count as watching');
    assert.equal(f.notifier.shown[1].flash,true);

    await page.report({focused:true,visible:true,chatId:f.chat.id});
    page.close();
    await until(()=>f.hub.notifications.live().length===0);
    await f.run(f.chat.id,'窗口关掉以后完成');
    assert.equal(f.notifier.shown.length,3,'a closed window never keeps notifications quiet');

    const started=await f.hub.runner.start(f.other.id,'等一等stop');
    await until(()=>f.holds.has('stop'));
    await f.hub.runner.stop(f.other.id);await started.done.catch(()=>{});
    await until(()=>!f.hub.runner.active.has(f.other.id));
    assert.equal(f.notifier.shown.length,3,'a stop the user pressed is not news');

    const desk=f.hub.store.newChat({provider:'codex',workspace:process.cwd(),title:'[工位] 甲',options:{desk:{parentChatId:f.chat.id}}});
    const deskRun=await f.hub.runner.start(desk.id,'工位任务',[],{desk:true});await deskRun.done;
    await until(()=>!f.hub.runner.active.has(desk.id));
    assert.equal(f.notifier.shown.length,3,'workflow desks report through their run card');

    assert.equal((await f.api('/notifications','PUT',{enabled:'no'})).status,400);
    const off=await f.api('/notifications','PUT',{enabled:false});
    assert.deepEqual(off.data,{enabled:false,sound:true,native:true});
    assert.equal(f.notifier.dismissed,1,'turning on do-not-disturb clears popups on screen');
    await f.run(f.chat.id,'勿扰时完成');
    assert.equal(f.notifier.shown.length,3);
    assert.deepEqual((await f.api('/notifications')).data,{enabled:false,sound:true,native:true,open:null},'the setting survives');

    await f.api('/notifications','PUT',{enabled:true,sound:false});
    await f.run(f.chat.id,'静音时完成');
    assert.equal(f.notifier.shown.length,4);assert.equal(f.notifier.shown[3].sound,false);
  }finally{await f.close();}
});

test('queued messages notify once, after the last reply',async()=>{
  const f=await fixture();
  try{
    const first=await f.hub.runner.start(f.chat.id,'等一等first');
    await until(()=>f.holds.has('first')&&f.hub.runner.state(f.chat.id)?.id);
    f.hub.runner.enqueue(f.chat.id,{text:'接着第二条',clientId:'queued-1',runId:first.id});
    f.holds.get('first').resolve();await first.done;
    await until(()=>f.notifier.shown.length>0&&!f.hub.runner.active.has(f.chat.id));
    await new Promise(r=>setTimeout(r,50));
    assert.equal(f.notifier.shown.length,1);
    assert.equal(f.hub.store.messages(f.chat.id).filter(m=>m.role==='assistant').length,2);
  }finally{await f.close();}
});

test('a workflow run notifies once with its label and last result, unless it was stopped',async()=>{
  const f=await fixture();
  try{
    const run=f.hub.workflows.createRun(f.chat,{kind:'adhoc',title:'点名 甲',trigger:'dispatch',status:'running',plan:null});
    run.card.details.workflowRun.steps.push({output:'**结论**：闭合成立',error:'',verify:false});
    f.hub.workflows.finish(run);
    assert.equal(f.notifier.shown.length,1);
    assert.equal(f.notifier.shown[0].body,'点名 甲：结论：闭合成立');assert.equal(f.notifier.shown[0].state,'已完成');assert.equal(f.notifier.shown[0].kind,'workflow');

    const failed=f.hub.workflows.createRun(f.chat,{kind:'workflow',title:'工作流「验证」',trigger:'manual',plan:null});
    failed.card.details.workflowRun.status='failed';failed.card.details.workflowRun.notes.push('伙伴不可用');
    f.hub.workflows.finish(failed);
    assert.equal(f.notifier.shown[1].tone,'error');assert.equal(f.notifier.shown[1].state,'运行失败');assert.equal(f.notifier.shown[1].body,'工作流「验证」：伙伴不可用');

    const stopped=f.hub.workflows.createRun(f.chat,{kind:'adhoc',title:'点名 乙',trigger:'dispatch',plan:null});
    stopped.stopped=true;f.hub.workflows.finish(stopped);
    assert.equal(f.notifier.shown.length,2);
  }finally{await f.close();}
});

test('an @-message notifies once everyone named is done, not when 主模型 finishes its own part',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'starport-notify-dispatch-')),companionDone=gate();
  const notifier={available:true,shown:[],show(item){this.shown.push(item);},dismiss(){},close(){}};
  const reply=(emit,text)=>{emit({type:'replace',text});emit({type:'final-answer',text});};
  const implementations={
    codex:async({prompt,emit})=>{
      if(prompt.includes('你是星港的排程员'))return reply(emit,'{"steps":[{"order":1,"companion":"a","task":"查资料"},{"order":1,"companion":"main","task":"同时汇总"}]}');
      await companionDone.promise;reply(emit,'我负责：查资料\n资料：42');
    },
    claude:async({emit})=>reply(emit,'主模型汇总完成')};
  const hub=createHub({port:0,dataDir,registry,implementations,notifier});
  t.after(()=>{companionDone.resolve();return hub.close();});
  await hub.listen();
  const {store,workflows}=hub,room=store.group('点名室');workflows.deskPollMs=20;
  workflows.createCompanion({name:'甲',avatar:'🦉',provider:'codex'},{id:'a'});workflows.addMember(room.id,'a');
  const chat=store.newChat({group_id:room.id,provider:'claude',workspace:dataDir,title:'汇总'});
  const sent=await workflows.dispatch(chat.id,{text:'@甲 查资料 @主模型 同时汇总'});
  const step=who=>store.messageById(chat.id,sent.message.id).details.workflowRun.steps.find(s=>s.companionId===who);
  await until(()=>step('main')?.status==='done'&&!hub.runner.active.has(chat.id));
  assert.equal(step('a').status,'running');
  assert.equal(notifier.shown.length,0,'甲 is still at work');
  companionDone.resolve();
  await until(()=>!workflows.runs.size);
  assert.equal(notifier.shown.length,1);
  assert.equal(notifier.shown[0].kind,'workflow');assert.equal(notifier.shown[0].chatId,chat.id);assert.match(notifier.shown[0].body,/^点名 /);
});

test('clicking the popup opens its chat in the raised window, or in a new window once it loads',async()=>{
  const f=await fixture();
  try{
    f.hub.notifications.opened({chatId:f.chat.id,raised:false});
    assert.equal((await f.api('/notifications')).data.open,f.chat.id,'the new window picks the chat up on boot');
    assert.equal((await f.api('/notifications')).data.open,null,'only once');

    const page=await f.page('page-raised-1');
    f.hub.notifications.opened({chatId:f.chat.id,raised:true});
    await until(()=>page.text.includes('event: notification-open'));
    assert.match(page.text,new RegExp('"chatId":"'+f.chat.id+'"'));
    f.hub.notifications.opened({chatId:'missing',raised:true});
    assert.equal((await f.api('/notifications')).data.open,null);
    page.close();

    const sample=await f.api('/notifications/test','POST',{chatId:f.chat.id});
    assert.equal(sample.status,200);
    const item=f.notifier.shown.at(-1);
    assert.equal(item.kind,'test');assert.equal(item.chatId,f.chat.id);assert.equal(item.flash,false);assert.equal(item.title,'通知测试');

    const english=await f.page('page-english-1');
    await english.report({focused:false,visible:false,chatId:null,language:'en',theme:'deep-space'});
    await f.run(f.chat.id,'英文界面下完成');
    assert.equal(f.notifier.shown.at(-1).state,'Done');assert.equal(f.notifier.shown.at(-1).source,'Starport · 科研');assert.equal(f.notifier.shown.at(-1).theme,'deep-space');
    english.close();

    assert.equal((await f.api('/presence','POST',{client:'bad id'})).status,400);
    const chime=await fetch(f.hub.server.address().port&&'http://127.0.0.1:'+f.hub.server.address().port+'/api/notifications/chime.wav',{headers:{'X-Hub-Token':f.hub.token}});
    assert.equal(chime.headers.get('content-type'),'audio/wav');assert.equal((await chime.arrayBuffer()).byteLength,chimeWav().length);
  }finally{await f.close();}
});

test('the Windows helper gets one base64 JSON line per message and reports clicks back',async()=>{
  const { WindowsNotifier, WINDOW_TITLES } = await import('../src/notifier-windows.mjs');
  const { PassThrough } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  const dataDir=await mkdtemp(join(tmpdir(),'starport-notifier-')),spawned=[];
  const spawnProcess=(command,args,options)=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};child.lines=[];child.stdin.on('data',chunk=>child.lines.push(...String(chunk).trim().split('\n')));spawned.push({command,args,options,child});return child;};
  const notifier=new WindowsNotifier({root:process.cwd(),dataDir,url:()=>'http://127.0.0.1:3210/',spawnProcess,platform:'win32'});
  assert.equal(notifier.available,true);
  const opened=[];notifier.onOpen=event=>opened.push(event);
  notifier.show({id:'n1',chatId:'c1',title:'计算衍生论',body:'闭合误差已经算完',sound:true,flash:true});
  notifier.show({id:'n2',chatId:'c2',title:'第二个',body:'',sound:false,flash:false});
  assert.equal(spawned.length,1,'one helper serves every popup');
  assert.equal(spawned[0].command,'powershell.exe');assert.ok(spawned[0].args.includes('-STA'));assert.equal(spawned[0].options.windowsHide,true);
  await new Promise(r=>setImmediate(r));
  const [first,second]=spawned[0].child.lines.map(line=>JSON.parse(Buffer.from(line,'base64').toString('utf8')));
  assert.equal(first.type,'show');assert.equal(first.title,'计算衍生论');assert.deepEqual(first.titles,WINDOW_TITLES);
  assert.match(first.chime,/notify-chime\.wav$/);assert.match(first.icon,/starport-desktop-azure\.ico$/);
  assert.equal(second.chime,'','no sound when the chime is off');
  spawned[0].child.stdout.write(JSON.stringify({type:'open',id:'n1',chatId:'c1',raised:false})+'\n');
  await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(opened,[{type:'open',id:'n1',chatId:'c1',raised:false}]);
  notifier.close();
  assert.equal(new WindowsNotifier({root:process.cwd(),dataDir,url:()=>'',spawnProcess,platform:'darwin'}).available,false);
});

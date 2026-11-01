import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';

// Each push sends the whole message. Streaming event by event used to resend a long turn per
// token, which kept the page too busy to tick its clocks; pushes are now coalesced.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function setup(t,implementation){
  const directory=mkdtempSync(join(tmpdir(),'starport-stream-push-')),store=new Store(join(directory,'hub.sqlite'));
  const registry={resolve:()=>({command:process.execPath}),probe:async()=>({}),record:()=>{}};
  const pushes=[];
  const broadcast=(event,data)=>{const size=JSON.stringify(data).length;if(event==='message'&&data.message?.role==='assistant')pushes.push({at:Date.now(),data:JSON.parse(JSON.stringify(data))});return size;};
  const runner=new Runner(store,registry,broadcast,{deepseek:implementation});
  t.after(async()=>{await runner.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,runner,pushes,chat:store.newChat({provider:'deepseek',workspace:process.cwd()})};
}

test('streamed text is pushed a few times a second, and the end at once with everything',async t=>{
  const {runner,pushes,chat}=setup(t,async({emit})=>{for(let i=0;i<300;i++){emit({type:'delta',text:'字'});if(i%10===9)await sleep(20);}});
  await runner.start(chat.id,'hi');await runner.active.get(chat.id).done;
  // 300 events over about 0.6 s: one push each would be 300.
  assert.ok(pushes.length<40,`pushes: ${pushes.length}`);
  const last=pushes.at(-1).data.message;
  assert.equal(last.status,'complete');assert.equal(last.content,'字'.repeat(300));
});

test('a long turn is pushed less often than a short one',async t=>{
  const big='x'.repeat(1024*1024);
  const {runner,pushes,chat}=setup(t,async({emit})=>{emit({type:'replace',text:big});const end=Date.now()+700;while(Date.now()<end){emit({type:'delta',text:'y'});await sleep(5);}});
  await runner.start(chat.id,'hi');await runner.active.get(chat.id).done;
  const streaming=pushes.filter(push=>push.data.message.status==='running'&&push.data.message.content.length>=big.length);
  // About 1 MB per push: at most one every half second.
  assert.ok(streaming.length<=3,`pushes while streaming: ${streaming.length}`);
  assert.equal(pushes.at(-1).data.message.status,'complete');
});

test('an approval request is pushed at once, not coalesced',async t=>{
  let seen=-1;
  const {runner,pushes,chat}=setup(t,async({emit})=>{
    emit({type:'delta',text:'a'});
    const before=pushes.length;
    emit({type:'approval',request:{id:'req-1',kind:'command',command:'ls'}});
    seen=pushes.length-before;
    emit({type:'approval-resolved',id:'req-1'});
  });
  await runner.start(chat.id,'hi');await runner.active.get(chat.id).done;
  assert.equal(seen,1);
});

test('no push arrives after the turn has ended',async t=>{
  const {runner,pushes,chat}=setup(t,async({emit})=>{emit({type:'delta',text:'a'});emit({type:'delta',text:'b'});});
  await runner.start(chat.id,'hi');await runner.active.get(chat.id).done;
  const count=pushes.length;await sleep(150);
  assert.equal(pushes.length,count);assert.equal(pushes.at(-1).data.message.status,'complete');
});

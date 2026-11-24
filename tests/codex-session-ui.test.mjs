import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(api=async()=>{}){
  const state={chat:{id:'fictional-chat',provider:'codex'},active:[],messages:[],run:null},opened=[],errors=[];
  const el=(tag,attrs={},children=[])=>({tag,...attrs,children,append(...values){this.children.push(...values);}});
  const context=vm.createContext({state,el,t:value=>value,api,openChat:async id=>opened.push(id),toast:error=>errors.push(error),renderMessages(){}});
  vm.runInContext(readFileSync(new URL('../public/codex-session.js',import.meta.url),'utf8'),context);
  const message={id:'failure',role:'assistant',provider:'codex',status:'error',details:{nativeConflict:{kind:'active-writer',delivery:'not-delivered'}}};state.messages=[message];
  return {state,message,opened,errors,render:()=>context.StarportCodexSession.render(message)};
}

test('only the latest unsent refusal offers recovery; uncertain errors and busy turns cannot be resent',()=>{
  const f=fixture();assert.deepEqual(f.render().children[0].children.map(n=>n.text),['重试连接','在独立会话中继续']);
  f.state.run={};assert.ok(f.render().children[0].children.every(n=>n.disabled));f.state.run=null;
  f.message.details.nativeConflict.delivery='unknown';assert.equal(f.render(),null);f.message.details.nativeConflict.delivery='not-delivered';
  f.state.messages.push({id:'newer'});assert.equal(f.render(),null);f.state.messages.pop();
  f.state.chat.provider='claude';assert.equal(f.render(),null);f.state.chat.provider='codex';
  f.message.details.nativeConflict.recoverable=false;assert.equal(f.render(),null);
});

test('repeated clicks send one receipt-based request and never send composer text or navigate a different chat',async()=>{
  let finish;const calls=[],f=fixture((path,method,body)=>{calls.push({path,method,body});return new Promise(resolve=>finish=resolve);});
  const buttons=f.render().children[0].children,request=buttons[1].onclick();
  await buttons[0].onclick();assert.equal(calls.length,1);assert.ok(f.render().children[0].children.every(n=>n.disabled));
  assert.equal(calls[0].path,'/chats/fictional-chat/recover-session');
  assert.equal(JSON.stringify(calls[0].body),JSON.stringify({messageId:'failure',action:'independent'}));
  f.state.chat={id:'different-chat',provider:'codex'};finish({});await request;assert.deepEqual(f.opened,[]);
});

test('failed recovery keeps the controls available and successful retry refreshes the same chat',async()=>{
  let fail=true;const f=fixture(async()=>{if(fail)throw Error('Still occupied');});
  await f.render().children[0].children[0].onclick();assert.deepEqual(f.errors,['Still occupied']);
  assert.ok(f.render().children[0].children.every(n=>!n.disabled));fail=false;
  await f.render().children[0].children[0].onclick();assert.deepEqual(f.opened,['fictional-chat']);
});

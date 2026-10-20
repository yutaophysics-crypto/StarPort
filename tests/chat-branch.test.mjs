import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.mjs';
import { createHub } from '../src/server.mjs';

const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true,nativeAutoReview:true}),models:async()=>({models:[]}),record(){},list:async()=>[]};

test('a branch copies the history up to one finished reply into a new chat in the same room, read and without a session',()=>{
  const store=new Store(':memory:');
  try{
    const room=store.group('科研');
    const source=store.newChat({group_id:room.id,title:'计算衍生论',provider:'antigravity',workspace:'C:\\notes',options:{antigravity:{model:'gemini-4-argon-high'}}});
    const q1=store.message(source.id,'user','antigravity','第一问');
    const a1=store.message(source.id,'assistant','antigravity','第一答');
    store.message(source.id,'user','antigravity','追问',
      'complete',{replyTo:{messageId:a1.id,questions:[]}});
    const a2=store.message(source.id,'assistant','antigravity','第二答');
    store.message(source.id,'user','antigravity','分支点之后的问题');
    store.message(source.id,'assistant','antigravity','分支点之后的回答');
    store.saveSession(source.id,'antigravity','native-1',a2.id,'fp');

    const branch=store.branchChat(source.id,a2.id);
    assert.notEqual(branch.id,source.id);
    assert.equal(branch.title,'计算衍生论 · 分支');
    assert.equal(branch.group_id,room.id);assert.equal(branch.provider,'antigravity');assert.equal(branch.workspace,'C:\\notes');
    assert.equal(branch.options.antigravity.model,'gemini-4-argon-high');
    const copied=store.messages(branch.id);
    assert.deepEqual(copied.map(m=>m.content),['第一问','第一答','追问','第二答']);
    assert.deepEqual(branch.options.branch,{chatId:source.id,messageId:a2.id,at:copied[3].id});
    assert.equal(copied[2].details.replyTo.messageId,copied[1].id,'a reply inside the copy points at the copied message');
    assert.equal(copied[0].created,q1.created,'timestamps are kept');
    assert.equal(branch.unread,false);
    assert.equal(store.session(branch.id,'antigravity'),undefined,'the branch starts a fresh native session');
    assert.equal(store.messages(source.id).length,6,'the original conversation is untouched');

    assert.equal(store.branchChat(source.id,a1.id).title,'计算衍生论 · 分支 2');
    assert.equal(store.branchChat(branch.id,copied[1].id).title,'计算衍生论 · 分支 3','a branch of a branch keeps the base title');
  }finally{store.close();}
});

test('branches only start from a finished assistant reply in a visible chat',()=>{
  const store=new Store(':memory:');
  try{
    const chat=store.newChat({title:'对话'});
    const user=store.message(chat.id,'user','codex','问');
    const running=store.message(chat.id,'assistant','codex','','running');
    const card=store.message(chat.id,'assistant',null,'','complete',{workflowRun:{status:'done',steps:[]}});
    const failed=store.message(chat.id,'assistant','codex','','error',{error:'boom'});
    assert.throws(()=>store.branchChat(chat.id,user.id),/只能从助手的回复/);
    assert.throws(()=>store.branchChat(chat.id,card.id),/只能从助手的回复/);
    assert.throws(()=>store.branchChat(chat.id,running.id),/还没有结束/);
    assert.throws(()=>store.branchChat(chat.id,'missing'),/只能从助手的回复/);
    assert.throws(()=>store.branchChat('missing',user.id),/对话不存在/);
    const desk=store.newChat({title:'[工位] x',options:{desk:{parentChatId:chat.id}}});
    const deskReply=store.message(desk.id,'assistant','codex','ok');
    assert.throws(()=>store.branchChat(desk.id,deskReply.id),/对话不存在/);
    const fromError=store.branchChat(chat.id,failed.id);
    assert.deepEqual(store.messages(fromError.id).map(m=>m.status),['complete','complete','error'],'running rows are skipped; a failed reply can be retried in a branch');
  }finally{store.close();}
});

test('the branch route opens a new chat whose first turn carries the copied history, not the later turns',{timeout:20000},async t=>{
  const seen=[];
  const implementations={codex:async({prompt,session,emit})=>{seen.push({prompt,session});emit({type:'session',id:'native-'+seen.length});emit({type:'replace',text:'回答'+seen.length});emit({type:'final-answer',text:'回答'+seen.length});}};
  const dataDir=mkdtempSync(join(tmpdir(),'hub-branch-')),workspace=mkdtempSync(join(tmpdir(),'hub-branch-ws-'));
  const hub=createHub({port:0,dataDir,registry,implementations});await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+hub.server.address().port;
  const call=async(path,method='GET',data)=>{const res=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Hub-Token':hub.token,Origin:base},body:data===undefined?undefined:JSON.stringify(data)});const json=await res.json();if(!res.ok)throw Object.assign(new Error(json.error),{status:res.status});return json;};
  const {store,runner}=hub,chat=store.newChat({provider:'codex',workspace,title:'原对话'});
  const ask=async(chatId,text)=>{await call('/chats/'+chatId+'/messages','POST',{text});await runner.active.get(chatId)?.done;};
  await ask(chat.id,'甲问题');await ask(chat.id,'乙问题');
  const first=store.messages(chat.id).find(m=>m.role==='assistant');
  const branch=await call('/chats/'+chat.id+'/branch','POST',{messageId:first.id});
  assert.equal(branch.title,'原对话 · 分支');
  await ask(branch.id,'丙问题');
  const turn=seen.at(-1);
  assert.equal(turn.session,undefined);
  assert.match(turn.prompt,/甲问题[\s\S]*回答1[\s\S]*丙问题/);
  assert.equal(turn.prompt.includes('乙问题'),false,'turns after the branch point stay in the original chat');
  await assert.rejects(call('/chats/'+chat.id+'/branch','POST',{messageId:store.messages(chat.id)[0].id}),/只能从助手的回复/);
});

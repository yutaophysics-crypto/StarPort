import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateOptions} from '../src/providers.mjs';
import {CODEX_PERMISSIONS,codexPermissions} from '../src/codex-permissions.mjs';
import {runCodex} from '../src/adapters/codex.mjs';
import {createHub} from '../src/server.mjs';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';

test('the three approval presets preserve boundaries and legacy read-only options',()=>{
  assert.deepEqual(CODEX_PERMISSIONS.map(item=>item.label),['请求批准','帮我批准','完全访问权限']);
  const ask=codexPermissions(validateOptions('codex',{permissionMode:'ask'}),process.cwd());
  const auto=codexPermissions(validateOptions('codex',{permissionMode:'auto-review'}),process.cwd());
  const full=codexPermissions(validateOptions('codex',{permissionMode:'full-access'}),process.cwd());
  assert.deepEqual(ask.sandboxPolicy,auto.sandboxPolicy);assert.equal(ask.sandboxPolicy.networkAccess,false);
  assert.equal(ask.approvalsReviewer,'user');assert.equal(auto.approvalsReviewer,'auto_review');
  assert.equal(ask.approvalPolicy,'on-request');assert.equal(auto.approvalPolicy,'on-request');
  assert.deepEqual(full.sandboxPolicy,{type:'dangerFullAccess'});assert.equal(full.approvalPolicy,'never');
  const old=validateOptions('codex',{sandbox:'read-only',model:'saved-model'});
  assert.equal(old.sandbox,'read-only');assert.equal(old.permissionMode,'ask');
  assert.equal(codexPermissions(old,process.cwd()).sandboxPolicy.type,'readOnly');
  assert.equal(validateOptions('codex',{}).sandbox,'read-only');
  assert.equal(validateOptions('codex',{permissionMode:'ask'}).sandbox,'workspace-write');
  assert.equal(validateOptions('codex',{permissionMode:'ask',sandbox:'danger-full-access'}).sandbox,'workspace-write');
  assert.throws(()=>validateOptions('codex',{permissionMode:'always-accept'}));
  assert.throws(()=>validateOptions('codex',{sandbox:'anything'}));
});
test('native policy is explicit on thread start/resume and every turn, including downgrade',async()=>{
  for(const session of [undefined,'previous-full-access-session'])for(const permissionMode of ['ask','auto-review','full-access']){
    let output;
    await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/permissions-rpc.mjs')]},options:validateOptions('codex',{permissionMode}),session,prompt:'Check routing',cwd:process.cwd(),signal:new AbortController().signal,emit:event=>{if(event.type==='replace')output=JSON.parse(event.text);},setControl:()=>{}});
    assert.equal(output.thread.method,session?'thread/resume':'thread/start');
    const full=permissionMode==='full-access',reviewer=permissionMode==='auto-review'?'auto_review':'user';
    assert.equal(output.thread.params.approvalsReviewer,reviewer);assert.equal(output.turn.approvalsReviewer,reviewer);
    assert.equal(output.thread.params.approvalPolicy,full?'never':'on-request');assert.equal(output.turn.approvalPolicy,full?'never':'on-request');
    assert.equal(output.thread.params.sandbox,full?'danger-full-access':'workspace-write');
    assert.equal(output.turn.sandboxPolicy.type,full?'dangerFullAccess':'workspaceWrite');
    if(!full){assert.deepEqual(output.turn.sandboxPolicy.writableRoots,[process.cwd()]);assert.equal(output.turn.sandboxPolicy.networkAccess,false);}
  }
});
test('approval requests remain interactive and a user decline reaches Codex',async()=>{
  let control,output,seen=false;
  await runCodex({runtime:{command:process.execPath,prefixArgs:[resolve('tests/fixtures/permissions-rpc.mjs')]},options:validateOptions('codex',{permissionMode:'ask'}),prompt:'ASK',cwd:process.cwd(),signal:new AbortController().signal,
    setControl:value=>control=value,emit:event=>{if(event.type==='approval'){seen=true;control.answer(event.request.id,{decision:'decline'});}if(event.type==='replace')output=JSON.parse(event.text);}});
  assert.equal(seen,true);assert.equal(output.decision,'decline');
});
test('permission changes persist per chat, do not affect siblings, and cannot change a running turn',async t=>{
  let finish;
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({nativeAutoReview:true}),record:()=>{},list:async()=>[]};
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-permissions-')),registry,implementations:{codex:async()=>new Promise(resolve=>finish=resolve)}});
  const group=hub.store.group('Independent'),a=hub.store.newChat({group_id:group.id,workspace:process.cwd()}),b=hub.store.newChat({group_id:group.id,workspace:process.cwd()});
  const port=await hub.listen();t.after(()=>hub.close());const url=`http://127.0.0.1:${port}/api/chats/${a.id}`,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  const patch=body=>fetch(url,{method:'PATCH',headers,body:JSON.stringify({options:body})});
  assert.equal((await patch({permissionMode:'auto-review'})).status,200);
  assert.equal(hub.store.chat(a.id).options.codex.permissionMode,'auto-review');assert.equal(validateOptions('codex',hub.store.chat(b.id).options.codex).permissionMode,'ask');
  const run=await hub.runner.start(a.id,'Wait');await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await patch({permissionMode:'full-access'})).status,409);
  assert.equal(hub.store.chat(a.id).options.codex.permissionMode,'auto-review');finish();await hub.runner.active.get(a.id).done;
  assert.equal((await patch({permissionMode:'ask',sandbox:'danger-full-access'})).status,200);assert.equal(hub.store.chat(a.id).options.codex.sandbox,'workspace-write');
});
test('unsupported native auto-review fails before a message or model run is created',async()=>{
  const store=new Store(':memory:'),chat=store.newChat({workspace:process.cwd(),options:{codex:{permissionMode:'auto-review'}}});let called=false;
  const runner=new Runner(store,{resolve:()=>({command:process.execPath}),probe:async()=>({nativeAutoReview:false})},()=>{},{codex:async()=>called=true});
  await assert.rejects(()=>runner.start(chat.id,'Test'),/暂不支持自动审核/);assert.equal(called,false);assert.equal(store.messages(chat.id).length,0);assert.equal(runner.active.size,0);store.close();
});

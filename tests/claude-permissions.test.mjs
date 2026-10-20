import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROVIDERS,validateOptions} from '../src/providers.mjs';
import {runClaude} from '../src/adapters/claude.mjs';
import {createHub} from '../src/server.mjs';

function nativeQuery(observe=()=>{},actualMode){
  return ({prompt,options})=>({close(){},async *[Symbol.asyncIterator](){
    observe(options);await prompt[Symbol.asyncIterator]().next();
    yield {type:'system',subtype:'init',session_id:'permission-session',model:'fixture',permissionMode:actualMode??options.permissionMode};
    yield {type:'result',subtype:'success',session_id:'permission-session',result:'Done'};
  }});
}
const base={runtime:{command:process.execPath,prefixArgs:[]},prompt:'test',cwd:process.cwd(),emit:()=>{},setControl:()=>{}};

test('Claude exposes both native higher modes while preserving defaults and rejecting unknown modes',()=>{
  const field=PROVIDERS.claude.fields.find(f=>f.key==='permissionMode');
  for(const permissionMode of ['default','plan','dontAsk','acceptEdits','auto','bypassPermissions'])assert.equal(validateOptions('claude',{permissionMode}).permissionMode,permissionMode);
  assert.ok(field.choices.find(c=>c.value==='auto').description);
  assert.ok(field.choices.find(c=>c.value==='bypassPermissions').description);
  assert.equal(validateOptions('claude').permissionMode,'plan');
  assert.throws(()=>validateOptions('claude',{permissionMode:'allow-all'}),/选项无效/);
});

test('saved permissions reach a resumed native session and lowering permissions removes bypass capability',async t=>{
  const observed=[];
  const registry={resolve:()=>base.runtime,probe:async()=>({loggedIn:true}),record:()=>{},list:async()=>Object.values(PROVIDERS)};
  const hub=createHub({port:0,dataDir:mkdtempSync(join(tmpdir(),'starport-claude-permissions-')),registry,
    implementations:{claude:args=>runClaude({...args,makeQuery:nativeQuery(options=>observed.push(options))})}});
  const chat=hub.store.newChat({provider:'claude',workspace:process.cwd(),options:{claude:{permissionMode:'acceptEdits'}}});
  const other=hub.store.newChat({provider:'claude',workspace:process.cwd()});
  const port=await hub.listen();t.after(()=>hub.close());
  const url=`http://127.0.0.1:${port}/api/chats/${chat.id}`,headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  for(const permissionMode of ['bypassPermissions','auto','acceptEdits','default','plan','dontAsk']){
    const patch=await fetch(url,{method:'PATCH',headers,body:JSON.stringify({options:{permissionMode}})});
    assert.equal(patch.status,200);
    const saved=await(await fetch(url,{headers})).json();assert.equal(saved.chat.options.claude.permissionMode,permissionMode);
    const start=await hub.runner.start(chat.id,'Check permissions');await hub.runner.active.get(chat.id).done;
    assert.equal(hub.store.messages(chat.id).find(m=>m.id===start.assistant.id).status,'complete');
    const native=observed.at(-1);assert.equal(native.permissionMode,permissionMode);
    assert.equal(native.allowDangerouslySkipPermissions,permissionMode==='bypassPermissions');
    assert.equal(native.permissionPrompts,'host');assert.equal(typeof native.canUseTool,'function');
    assert.deepEqual(native.settingSources,['user','project','local']);
    if(observed.length>1)assert.equal(native.resume,'permission-session');
  }
  assert.equal(validateOptions('claude',hub.store.chat(other.id).options.claude).permissionMode,'plan');
});

test('native fallback from a requested higher mode reports failure instead of silently running with another mode',async()=>{
  for(const permissionMode of ['auto','bypassPermissions']){
    const events=[];let closed=false;
    const makeQuery=args=>{const stream=nativeQuery(()=>{},'default')(args);stream.close=()=>closed=true;return stream;};
    await assert.rejects(()=>runClaude({...base,options:{permissionMode},makeQuery,emit:e=>events.push(e)}),/Claude Code 未启用/);
    assert.equal(closed,true);assert.ok(!events.some(e=>e.type==='delta'||e.type==='replace'||e.type==='tool'));
  }
});

test('higher modes retain native forced approval and user-question callbacks',async()=>{
  for(const permissionMode of ['auto','bypassPermissions'])for(const toolName of ['PowerShell','AskUserQuestion']){
    let request,control,decision;
    const input=toolName==='AskUserQuestion'?{questions:[{question:'Which theme?',options:[{label:'Sea'}]}]}:{command:'node --version'};
    const makeQuery=({prompt,options})=>({close(){},async *[Symbol.asyncIterator](){
      await prompt[Symbol.asyncIterator]().next();
      yield {type:'system',subtype:'init',session_id:'forced',permissionMode};
      decision=await options.canUseTool(toolName,input,{signal:new AbortController().signal,toolUseID:'forced-tool',decisionReason:'Explicit native ask rule'});
      yield {type:'result',subtype:'success',result:'Done'};
    }});
    const running=runClaude({...base,options:{permissionMode},makeQuery,setControl:value=>control=value,emit:event=>{if(event.type==='approval')request=event.request;}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(request.kind,toolName==='AskUserQuestion'?'question':'permission');
    assert.equal(request.params.reason,'Explicit native ask rule');
    await control.answer(request.id,{decision:'decline'});await running;
    assert.equal(decision.behavior,'deny');
  }
});

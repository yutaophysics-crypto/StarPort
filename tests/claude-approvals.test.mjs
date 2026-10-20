import test from 'node:test';
import assert from 'node:assert/strict';
import {runClaude} from '../src/adapters/claude.mjs';

function fakeQuery(toolName='Bash',input={command:'node --version'},observe=()=>{},metadata={}){
  return ({prompt,options})=>({close(){},async *[Symbol.asyncIterator](){
    observe(options);await prompt[Symbol.asyncIterator]().next();
    yield {type:'system',subtype:'init',session_id:'test-session',model:'test'};
    const result=await options.canUseTool(toolName,input,{signal:new AbortController().signal,toolUseID:'call1',requestId:'native-request',...metadata});
    observe(result);
    yield {type:'result',subtype:'success',session_id:'test-session',result:'Done'};
  }});
}
const base={runtime:{command:process.execPath,prefixArgs:[]},options:{permissionMode:'acceptEdits'},prompt:'test',cwd:process.cwd(),emit:()=>{},setControl:()=>{}};

test('Claude awaits a manual one-time decision and the exact original input reaches SDK',async()=>{
  const observed=[],events=[];let control,request,finished=false;
  const running=runClaude({...base,makeQuery:fakeQuery('Bash',{command:'node --version'},value=>observed.push(value)),setControl:value=>control=value,emit:event=>{events.push(event);if(event.type==='approval')request=event.request;}}).then(()=>finished=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);assert.equal(request.params.toolName,'Bash');
  assert.equal(observed[0].permissionPrompts,'host');assert.equal(observed[0].permissionMode,'acceptEdits');assert.equal(observed[0].systemPrompt.preset,'claude_code');
  await assert.rejects(()=>control.answer('stale',{decision:'accept'}),/失效/);await assert.rejects(()=>control.answer(request.id,{decision:'bypass'}),/无效/);
  await assert.rejects(()=>control.answer(request.id,{decision:'skip'}),/无效/);
  assert.equal(finished,false);await control.answer(request.id,{decision:'accept'});await running;
  assert.deepEqual(observed[1].updatedInput,{command:'node --version'});assert.equal(observed[1].behavior,'allow');assert.equal(observed[1].updatedPermissions,undefined);
  assert.equal(events.filter(event=>event.type==='approval-resolved').length,1);await assert.rejects(()=>control.answer(request.id,{decision:'accept'}),/失效/);
});

test('reject and stop resolve pending permissions without executing or leaving stale prompts',async()=>{
  for(const stop of [false,true]){
    const observed=[],events=[];let control,request;
    const running=runClaude({...base,makeQuery:fakeQuery('Bash',{command:'never run'},value=>observed.push(value)),setControl:value=>control=value,emit:event=>{events.push(event);if(event.type==='approval')request=event.request;}});
    const result=running.then(()=>null,error=>error);await new Promise(resolve=>setImmediate(resolve));
    if(stop)await control.stop();else await control.answer(request.id,{decision:'decline'});
    const error=await result;assert.equal(observed[1].behavior,'deny');assert.equal(events.filter(event=>event.type==='approval-resolved').length,1);
    if(stop)assert.equal(error.canceled,true);else {assert.equal(error,null);assert.ok(events.some(event=>event.type==='tool'&&event.status==='denied'));}
  }
});

test('Claude questions validate answers and preserve native question keys and multi-select choices',async()=>{
  const observed=[];let control,request;
  const questions=[{question:'Which tests?',header:'Tests',multiSelect:true,options:[{label:'Unit'},{label:'Browser'}]}];
  const running=runClaude({...base,makeQuery:fakeQuery('AskUserQuestion',{questions},value=>observed.push(value)),setControl:value=>control=value,emit:event=>{if(event.type==='approval')request=event.request;}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(request.kind,'question');
  await assert.rejects(()=>control.answer(request.id,{decision:'accept',answers:{}}),/回答/);
  await control.answer(request.id,{decision:'accept',answers:{'0':['Unit','Browser']}});await running;
  assert.deepEqual(observed[1].updatedInput,{questions,answers:{'Which tests?':'Unit, Browser'}});
});

test('native request abort resolves once and closes the UI while late answers fail',async()=>{
  const controller=new AbortController();let control,request;const events=[];
  const running=runClaude({...base,makeQuery:fakeQuery('Bash',{},()=>{},{signal:controller.signal}),setControl:value=>control=value,emit:event=>{events.push(event);if(event.type==='approval')request=event.request;}});
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await running;
  assert.equal(events.filter(event=>event.type==='approval-resolved').length,1);await assert.rejects(()=>control.answer(request.id,{decision:'accept'}),/失效/);
});

test('Claude question skip sends an explicit freeform response with no invented choice',async()=>{
  const observed=[];let control,request;
  const questions=[{question:'Choose?',options:[{label:'A'},{label:'B'}]}];
  const running=runClaude({...base,makeQuery:fakeQuery('AskUserQuestion',{questions},value=>observed.push(value)),setControl:value=>control=value,emit:event=>{if(event.type==='approval')request=event.request;}});
  await new Promise(resolve=>setImmediate(resolve));await control.answer(request.id,{decision:'skip',answers:{'0':'A'}});await running;
  assert.equal(observed[1].behavior,'allow');assert.deepEqual(observed[1].updatedInput.questions,questions);
  assert.deepEqual(observed[1].updatedInput.answers,{});assert.match(observed[1].updatedInput.response,/跳过/);
  assert.equal(observed[1].updatedPermissions,undefined);
});

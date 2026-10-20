import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {cliArguments,runCli} from '../src/adapters/cli.mjs';
import {validateOptions} from '../src/providers.mjs';
import {Runner} from '../src/runner.mjs';
import {Store} from '../src/storage.mjs';

test('Antigravity user-requested default approves all tools while respecting explicit native policy and sandbox choice',()=>{
  const defaultOptions=validateOptions('antigravity',{}),args=cliArguments('antigravity',defaultOptions,'existing');
  assert.equal(defaultOptions.mode,'auto');
  assert.equal(defaultOptions.permissionMode,'allow-all');assert.ok(args.includes('--dangerously-skip-permissions'));assert.ok(args.includes('--sandbox'));
  assert.equal(args[args.indexOf('--mode')+1],'auto');
  assert.equal(args[args.indexOf('--conversation')+1],'existing');
  const planArgs=cliArguments('antigravity',validateOptions('antigravity',{mode:'plan'}));
  assert.equal(planArgs[planArgs.indexOf('--mode')+1],'plan');
  const restricted=cliArguments('antigravity',validateOptions('antigravity',{permissionMode:'configured',mode:'accept-edits'}));assert.ok(!restricted.includes('--dangerously-skip-permissions'));
  assert.ok(!cliArguments('antigravity',validateOptions('antigravity',{sandbox:false})).includes('--sandbox'));
  assert.throws(()=>validateOptions('antigravity',{permissionMode:'invented'}));
  assert.ok(!cliArguments('claude',validateOptions('claude',{})).includes('--dangerously-skip-permissions'));
});
test('Antigravity selected policy reaches the real child argv including on resumed runs',async()=>{
  const fixture=fileURLToPath(new URL('./fixtures/antigravity-cli.mjs',import.meta.url));
  for(const permissionMode of ['allow-all','configured']){
    const events=[],options=validateOptions('antigravity',{permissionMode,model:'test-model',mode:'accept-edits'});
    await runCli({provider:'antigravity',runtime:{command:process.execPath,prefixArgs:[fixture]},options,session:'saved-session',prompt:'test',cwd:process.cwd(),emit:e=>events.push(e),setControl:()=>{}});
    const result=JSON.parse(events.find(e=>e.type==='replace').text);
    assert.equal(result.approved,permissionMode==='allow-all');assert.equal(result.session,'saved-session');assert.equal(result.model,'test-model');assert.equal(result.sandbox,true);
  }
});
test('changing Antigravity policy persists per chat and is passed again on native resume',async()=>{
  const store=new Store(':memory:'),chat=store.newChat({provider:'antigravity',workspace:process.cwd(),options:{antigravity:{mode:'accept-edits'}}}),observed=[];
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),record:()=>{}};
  const runner=new Runner(store,registry,()=>{},{antigravity:async({options,session,emit})=>{observed.push({options,session});emit({type:'session',id:'native-test'});emit({type:'replace',text:'ok'});}});
  try{
    await runner.start(chat.id,'one');await runner.active.get(chat.id).done;
    store.updateChat(chat.id,{options:{antigravity:{mode:'accept-edits',permissionMode:'configured'}}});
    await runner.start(chat.id,'two');await runner.active.get(chat.id).done;
    assert.equal(observed[0].options.permissionMode,'allow-all');assert.equal(observed[1].options.permissionMode,'configured');assert.equal(observed[1].session,'native-test');
  }finally{store.close();}
});
async function denialFixture(t,mode){
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'agy-denial-')),file=join(dir,'state.json');
  await writeFile(file,JSON.stringify({prompts:[]}));t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime={command:process.execPath,prefixArgs:[fileURLToPath(new URL('./fixtures/antigravity-denial-cli.mjs',import.meta.url)),file,mode]};
  return {state:async()=>JSON.parse(await readFile(file,'utf8')),run:async extra=>{const events=[];await runCli({provider:'antigravity',runtime,options:validateOptions('antigravity',{permissionMode:'configured',mode:'accept-edits'}),prompt:'write the script',cwd:process.cwd(),emit:e=>events.push(e),setControl:()=>{},...extra});return events;}};
}
test('an unattended desk asks agy to carry on after a soft-denied command, in the same session',{timeout:8000},async t=>{
  const f=await denialFixture(t,'once'),events=await f.run({unattended:true});
  const prompts=(await f.state()).prompts;
  assert.equal(prompts.length,2);assert.match(prompts[1],/没有获得批准/);
  assert.equal(events.filter(e=>e.type==='final-answer').at(-1).text,'script written without running it');
  const notices=events.filter(e=>e.type==='notice').map(e=>e.text);
  assert.equal(notices.length,1);assert.match(notices[0],/已请它不用该命令继续（1\/2）/);
});
test('the follow-up is bounded and ends with a desk-specific notice; chats keep their own notice',{timeout:8000},async t=>{
  const f=await denialFixture(t,'always'),events=await f.run({unattended:true});
  assert.equal((await f.state()).prompts.length,3);
  assert.match(events.filter(e=>e.type==='notice').at(-1).text,/无人值守时的权限/);
  const g=await denialFixture(t,'once'),chat=await g.run();
  assert.equal((await g.state()).prompts.length,1);
  const chatNotices=chat.filter(e=>e.type==='notice').map(e=>e.text);assert.equal(chatNotices.length,1);assert.match(chatNotices[0],/^Antigravity 想调用命令等工具，但无交互模式无法弹出审批/);
});

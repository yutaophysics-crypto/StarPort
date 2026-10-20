import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,dirname,delimiter} from 'node:path';
import {tmpdir} from 'node:os';
import {deepseekDesktopRuntime,deepseekDesktopMetadata,isDeepseekDesktop} from '../src/deepseek-desktop.mjs';
import {discover} from '../src/providers.mjs';
import {deepseekBalance} from '../src/deepseek-usage.mjs';

async function installation(){
  const root=await mkdtemp(join(tmpdir(),'starport dsh 桌面-'));
  const launcher=join(root,'resources','runtime','cli','bin','dsh.cmd');
  await mkdir(dirname(launcher),{recursive:true});
  for(const file of [launcher,join(root,'DeepSeek Harness.exe'),join(root,'resources','app.asar')])await writeFile(file,'fixture');
  return {root,launcher};
}

test('official desktop launcher resolves to its Electron Node host, without a command shell',async()=>{
  const {root,launcher}=await installation(),runtime=deepseekDesktopRuntime(launcher);
  assert.equal(runtime.command,join(root,'DeepSeek Harness.exe'));
  assert.deepEqual(runtime.env,{ELECTRON_RUN_AS_NODE:'1'});
  assert.equal(runtime.prefixArgs[0],'--expose-internals');
  assert.equal(isDeepseekDesktop(runtime),true);
  const found=discover(root,'deepseek',{command:launcher,prefixArgs:['--patch','a & b.yml']});
  assert.deepEqual(found.prefixArgs,[...runtime.prefixArgs,'--patch','a & b.yml']);
  // The settings API displays resolved EXE/arguments. Saving those must retain
  // Electron's Node mode and must not duplicate the native entry point.
  assert.deepEqual(discover(root,'deepseek',{command:found.command,prefixArgs:found.prefixArgs}),found);
  assert.equal(deepseekDesktopRuntime(join(root,'dsh.cmd')),null);
  assert.equal(isDeepseekDesktop({command:runtime.command,prefixArgs:['some.js']}),false);
});

test('desktop CLI in PATH takes priority over the legacy embedded runtime', {skip:process.platform!=='win32'},async()=>{
  const {root,launcher}=await installation(),entry=join(root,'.runtime','deepseek','node_modules','@deepseek-ai','dsh','lib','bin.js');
  await mkdir(dirname(entry),{recursive:true});await writeFile(entry,'fixture');
  const previous=process.env.PATH;
  try{
    process.env.PATH='"'+dirname(launcher)+'"'+delimiter+join(root,'missing');
    assert.deepEqual(discover(root,'deepseek'),deepseekDesktopRuntime(launcher));
    process.env.PATH='';assert.deepEqual(discover(root,'deepseek'),{command:process.execPath,prefixArgs:[entry]});
  }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});

test('desktop metadata uses the native ASAR runtime and preserves model/service reasoning identities',async()=>{
  const {launcher}=await installation(),runtime=deepseekDesktopRuntime(launcher);
  const result=await deepseekDesktopMetadata(runtime,'workspace & 项目',async(command,args,options)=>{
    assert.equal(command,runtime.command);assert.equal(args[0],'--expose-internals');
    assert.match(args[1],/deepseek-desktop-metadata\.cjs$/);assert.equal(args[2],runtime.prefixArgs[1]);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(options.cwd,'workspace & 项目');assert.equal(options.windowsHide,true);
    return {stdout:JSON.stringify({source:'configured',selection:{provider:'deepseek-account',model:'flash',reasoningEffort:'max'},models:[
      {id:'flash',label:'Flash',provider:'deepseek-account',reasoning:{efforts:[{id:'off',name:'Off'},{id:'max',name:'Max'}],defaultEffort:'off'}},
      {id:'custom',label:'Custom',provider:'gateway'}]})};
  });
  assert.equal(result.selection.reasoningEffort,'max');
  assert.deepEqual(result.models[0].effort.choices.map(c=>c.value),['off','max']);
  assert.equal(result.models[0].effort.defaultLevel,'off');assert.equal(result.models[1].effort,null);
});

test('desktop account quota cannot accidentally query the API balance endpoint',async()=>{
  const {launcher}=await installation(),runtime=deepseekDesktopRuntime(launcher);
  const result=await deepseekBalance(runtime,'unused','unused',{provider:'deepseek-account'},()=>{throw Error('Must not send account credentials to API balance');});
  assert.equal(result.status,'unsupported');assert.match(result.reason,/账号额度与 API 余额不同/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ExternalTools} from '../src/external-tools/grants.mjs';
import {externalToolCapability,prepareExternalClaude} from '../src/external-tools/claude-launch.mjs';
import {runWorkspaceCommand} from '../src/external-tools/terminal.mjs';
import {runClaude} from '../src/adapters/claude.mjs';
import {contextToolHost} from '../src/context-tools.mjs';
import {Store} from '../src/storage.mjs';
import {createHub} from '../src/server.mjs';
const windows={skip:process.platform!=='win32'};
async function fixture(){
 const root=realpathSync.native(await mkdtemp(join(tmpdir(),'starport-runner-'))),workspace=join(root,'项目 & space'),sdk=join(root,'SDK'),data=join(root,'data');
 for(const dir of [workspace,sdk,data])await mkdir(dir);
 const exe=join(sdk,'tool.exe'),runner=join(root,'runner.mjs'),mcp=join(data,'owner.json');await writeFile(exe,'fixture');
 await writeFile(runner,`let text='';for await(const part of process.stdin)text+=part;const value=JSON.parse(text);console.log(JSON.stringify({workspace:value.workspace,exitCode:0,stdout:JSON.stringify(value),stderr:'',timedOut:false,canceled:false,isolation:'fixture controlled policy'}));`);
 const config={mcpServers:{starport_workspace:{command:process.execPath,args:['original.mjs'],env:{STARPORT_ISOLATED_RUNNER:runner,STARPORT_ALLOW_HOST_TOOLS:'0'}},browser:{command:process.execPath,args:['browser.mjs']}}};await writeFile(mcp,JSON.stringify(config));
 const tools=new ExternalTools({root:join(root,'hub'),dataDir:data});await tools.add(workspace,{name:'SDK',directory:sdk,executable:exe});
 const snapshot=tools.snapshot(workspace);await tools.setHostApproval(workspace,snapshot.tools[0].id,'always');
 return {root,workspace,sdk,data,runner,mcp,tools,config,runtime:{command:process.execPath,prefixArgs:['--mcp-config',mcp],externalTools:{...tools.snapshot(workspace),dataDir:data}}};
}
test('external-tool projects retain owner runner and cannot expose the host launch escape',windows,async()=>{
 const f=await fixture(),original=await readFile(f.mcp,'utf8');let called=false;
 const prepared=await prepareExternalClaude(f.runtime,f.workspace);
 try{const args=prepared.runtime.prefixArgs,config=JSON.parse(await readFile(args[args.indexOf('--mcp-config')+1],'utf8'));assert.ok(config.mcpServers.browser);assert.equal(config.mcpServers.starport_workspace,undefined);}finally{await prepared.cleanup();}
 const makeQuery=({options})=>({close(){},async *[Symbol.asyncIterator](){
  assert.equal(options.mcpServers.starport_external_tools,undefined,'remembered host consent cannot override owner isolation');
  const client=new Client({name:'runner-test',version:'1'}),server=options.mcpServers.starport_workspace.instance,[a,b]=InMemoryTransport.createLinkedPair();
  try{await server.connect(b);await client.connect(a);const result=await client.callTool({name:'run_command',arguments:{command:'literal ; command & data',timeoutMs:1000}});
   assert.equal(result.isError,false);const value=JSON.parse(result.content[0].text),input=JSON.parse(value.stdout);
   assert.equal(input.command,'literal ; command & data');assert.equal(input.workspace,f.workspace);assert.deepEqual(input.readonlyPaths,[f.sdk]);called=true;
  }finally{await client.close();await server.close();}
  yield {type:'result',subtype:'success',result:'done',session_id:'fixture'};
 }});
 await runClaude({runtime:f.runtime,options:{permissionMode:'bypassPermissions'},cwd:f.workspace,prompt:'fixture',emit(){},setControl(){},makeQuery});
 assert.equal(called,true);assert.equal(await readFile(f.mcp,'utf8'),original);assert.equal(f.tools.snapshot(f.workspace).tools[0].hostApproval,'always');
});
test('broken owner runner fails closed even with a legacy sandbox available',windows,async()=>{
 const f=await fixture();f.config.mcpServers.starport_workspace.env.STARPORT_ISOLATED_RUNNER=join(f.root,'missing.mjs');await writeFile(f.mcp,JSON.stringify(f.config));
 await assert.rejects(externalToolCapability(f.runtime,f.workspace,process.execPath),/不会改用其他终端/);
 await writeFile(f.runner,'process.exit(9)');
 await assert.rejects(runWorkspaceCommand({workspace:f.workspace,snapshot:f.tools.snapshot(f.workspace),runner:{command:process.execPath,args:[f.runner]},command:'fixture',timeoutMs:1000}),/不会放宽权限/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(runWorkspaceCommand({workspace:f.workspace,runner:{command:process.execPath,args:[f.runner]},command:'fixture',signal:controller.signal}),/已取消/);
});
test('runtime coordination is scoped and revoked when its task ends',async()=>{
 const store=new Store(':memory:'),chat=store.newChat({});let active=true,reloads=0;
 try{const host=contextToolHost({store,chat,messages:()=>[],isActive:()=>active,localControl:{status:id=>({chatId:id,activeTasks:2,otherActiveTasks:1}),reload:()=>({scheduled:++reloads>0})}});
  assert.deepEqual(await host.call('starport_runtime_status',{}),{chatId:chat.id,activeTasks:2,otherActiveTasks:1});
  await assert.rejects(host.call('starport_runtime_status',{path:'/api/export'}),/参数无效/);
  assert.equal((await host.call('starport_reload_when_idle',{})).scheduled,true);assert.equal(reloads,1);
  const ordinary=contextToolHost({store,chat,messages:()=>[]});assert.ok(!ordinary.definitions.some(t=>t.name==='starport_reload_when_idle'));
  const desk=contextToolHost({store,chat,messages:()=>[],tools:new Set(['starport_memory_search']),localControl:{}});assert.ok(!desk.definitions.some(t=>t.name==='starport_runtime_status'));
  active=false;await assert.rejects(host.call('starport_runtime_status',{}),/任务已结束/);
 }finally{store.close();}
});
test('the real runner supplies bounded local status to its conversation model',async()=>{
 const root=realpathSync.native(await mkdtemp(join(tmpdir(),'starport-status-')));let observed;
 const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),record(){},list:async()=>[]};
 const hub=createHub({port:0,dataDir:join(root,'data'),registry,implementations:{claude:async({contextTools,emit})=>{
  assert.ok(contextTools.definitions.some(t=>t.name==='starport_runtime_status'));
  observed=await contextTools.call('starport_runtime_status',{});emit({type:'replace',text:'done'});
 }}});
 await hub.listen();try{
  const chat=hub.store.newChat({provider:'claude',workspace:root});await hub.runner.start(chat.id,'fixture');
  await hub.runner.active.get(chat.id)?.done;
  assert.equal(observed.app,'Starport');assert.equal(observed.activeTasks,1);assert.equal(observed.otherActiveTasks,0);
  assert.deepEqual(observed.companionSteps,[]);assert.equal(observed.token,undefined);assert.equal(observed.messages,undefined);
 }finally{await hub.close();}
});

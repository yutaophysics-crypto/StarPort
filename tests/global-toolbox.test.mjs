import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,unlink} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';
import {ExternalTools} from '../src/external-tools/grants.mjs';
import {workspaceFilesystem} from '../src/external-tools/terminal.mjs';
import {toolboxEnvironment} from '../src/external-tools/toolbox.mjs';
import {runExternalApplication} from '../src/external-tools/host-run.mjs';
import {createHub} from '../src/server.mjs';
import {externalToolServers} from '../src/external-tools/claude-tools.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

async function fixture(){
 const root=realpathSync.native(await mkdtemp(join(tmpdir(),'starport-global-'))),workspace=join(root,'project'),other=join(root,'second'),sdk=join(root,'SDK'),dataDir=join(root,'hub','.data');
 for(const dir of [workspace,other,sdk,dataDir])await mkdir(dir,{recursive:true});
 const executable=join(sdk,'compiler.exe');await writeFile(executable,'fixture');
 return {root,workspace,other,sdk,dataDir,executable,tools:new ExternalTools({root:join(root,'hub'),dataDir})};
}
test('global toolbox is durable and inherited by every workspace without modifying project or catalog consent',async()=>{
 const f=await fixture();await f.tools.add(f.workspace,{name:'Project SDK',directory:f.sdk,executable:f.executable});
 const localBefore=f.tools.saved(f.workspace),catalogBefore=f.tools.catalog();
 const globalDir=join(f.root,'globalSDK');await mkdir(globalDir);const binary=join(globalDir,'engine.exe');await writeFile(binary,'fixture');
 await f.tools.addGlobal({name:'Compiler',command:'compile',directory:globalDir,executable:binary});
 const restored=new ExternalTools({root:join(f.root,'hub'),dataDir:f.dataDir});
 for(const workspace of [f.workspace,f.other]){
  const snapshot=restored.snapshot(workspace),global=snapshot.tools.find(tool=>tool.scope==='global');assert.equal(global.command,'compile');assert.equal(global.hostApproval,'always');assert.equal(workspaceFilesystem(workspace,snapshot)[globalDir],'read');
 }
 assert.deepEqual(restored.saved(f.workspace),localBefore);assert.deepEqual(restored.catalog(),catalogBefore);assert.equal(restored.view(f.other).tools.length,0);
 await restored.removeGlobal(restored.globalTools()[0].id);assert.equal(restored.snapshot(f.other).tools.length,0);assert.deepEqual(restored.saved(f.workspace),localBefore);
});
test('commands are validated; multiple engines share an installation; a missing executable is visible but does not break every project',async()=>{
 const f=await fixture(),input={name:'Engine',command:'latex',directory:f.sdk,executable:f.executable};
 await f.tools.addGlobal(input);await assert.rejects(f.tools.addGlobal(input),/已经添加/);
 await assert.rejects(f.tools.addGlobal({...input,command:'latex;whoami'}));
 await f.tools.addGlobal({...input,command:'latex2'});assert.equal(f.tools.snapshot(f.other).tools.length,2);
 const env=toolboxEnvironment(f.tools.snapshot(f.other),f.other,{Path:'original',HTTPS_PROXY:'preserve'});assert.equal(env.Path.split(delimiter)[0],f.sdk);assert.equal(env.HTTPS_PROXY,'preserve');
 await unlink(f.executable);assert.ok(f.tools.globalTools().every(tool=>tool.error));assert.equal(f.tools.snapshot(f.other).tools.length,0);
});
test('global commands run by name on the host without repeat approval and receive the shared toolbox PATH',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture();await f.tools.addGlobal({name:'Runtime',command:'runtime',directory:dirname(process.execPath),executable:process.execPath});
 const result=await runExternalApplication({workspace:f.other,snapshot:f.tools.snapshot(f.other),command:'runtime',args:['-e','console.log("GLOBAL_TOOLBOX_OK")'],approve:()=>assert.fail('global consent must be reused')});
 assert.equal(result.ok,true,result.stderr);assert.match(result.stdout,/GLOBAL_TOOLBOX_OK/);
 await assert.rejects(runExternalApplication({workspace:f.other,snapshot:f.tools.snapshot(f.other),command:'unregistered',args:[]}));
  const host=externalToolServers({runtime:{externalTools:{...f.tools.snapshot(f.other),dataDir:f.dataDir}},cwd:f.other,signal:new AbortController().signal,canUseTool:()=>assert.fail('global MCP must not prompt'),emit(){}});
  const server=host.servers.starport_external_tools.instance,client=new Client({name:'toolbox-fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{await server.connect(b);await client.connect(a);const result=await client.callTool({name:'run',arguments:{command:'runtime',args:['-e','console.log("GLOBAL_MCP_OK")']}});assert.equal(result.isError,false);assert.match(JSON.parse(result.content[0].text).stdout,/GLOBAL_MCP_OK/);}finally{await client.close();await server.close();await host.settled();}
});
test('global toolbox routes require owner auth and idle tasks; project routes keep their own scope',{skip:process.platform!=='win32'},async t=>{
 const f=await fixture(),hub=createHub({port:0,dataDir:f.dataDir,registry:{resolve:()=>null,list:async()=>[]}});await hub.listen();t.after(()=>hub.close());
 const base='http://127.0.0.1:'+hub.server.address().port,path='/api/toolbox',headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'},input={name:'Compiler',command:'compile',directory:f.sdk,executable:f.executable};
 assert.equal((await fetch(base+path)).status,401);
 assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify(input)})).status,403);
 let response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,201);const saved=await response.json();assert.equal(saved.tools[0].scope,'global');
 const chat=hub.store.newChat({provider:'claude',workspace:f.workspace});hub.runner.active.set(chat.id,{});
 try{assert.equal((await fetch(base+path+'/'+saved.tools[0].id,{method:'DELETE',headers})).status,409);assert.equal((await(await fetch(base+path,{headers})).json()).busy,true);}finally{hub.runner.active.delete(chat.id);}
 assert.equal((await fetch(base+path+'/'+saved.tools[0].id,{method:'DELETE',headers})).status,200);
});

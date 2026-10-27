import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,unlink} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {ExternalTools,validateToolSnapshot} from '../src/external-tools/grants.mjs';
import {prepareExternalClaude} from '../src/external-tools/claude-launch.mjs';
import {workspaceFilesystem} from '../src/external-tools/terminal.mjs';
import {ProviderRegistry} from '../src/providers.mjs';
import {Store} from '../src/storage.mjs';
import {sessionFingerprint} from '../src/context.mjs';
import {createHub} from '../src/server.mjs';
import {runClaude} from '../src/adapters/claude.mjs';

async function fixture(){
  const root=realpathSync.native(await mkdtemp(join(tmpdir(),'starport-external-'))),workspace=join(root,'项目 & workspace'),sdk=join(root,'SDK'),data=join(root,'hub','.data');
  for(const path of [workspace,sdk,data])await mkdir(path,{recursive:true});
  const binary=join(sdk,'tool.exe');await writeFile(binary,'fixture');
  return {root,workspace,sdk,data,binary,tools:new ExternalTools({root:join(root,'hub'),dataDir:data})};
}
test('machine-local grants persist, apply only to the exact project, and remain read-only',async()=>{
  const f=await fixture();await f.tools.add(f.workspace,{name:'SDK',directory:f.sdk,executable:f.binary});
  const restored=new ExternalTools({root:join(f.root,'hub'),dataDir:f.data}),snapshot=restored.snapshot(f.workspace);
  const child=join(f.workspace,'subfolder');await mkdir(child);
  assert.equal(restored.snapshot(child).tools.length,0);
  assert.equal(snapshot.tools.length,1);const policy=workspaceFilesystem(f.workspace,snapshot);
  assert.equal(policy[f.sdk],'read');assert.equal(policy[f.workspace],'write');assert.equal(policy[':root'],'deny');
  assert.ok(!existsSync(join(f.workspace,'external-tools.json')));
  const store=new Store(':memory:');try{
    store.setSetting('providers',{claude:{command:process.execPath,prefixArgs:[]}});
    const registry=new ProviderRegistry(join(f.root,'hub'),f.data,store),chat={workspace:f.workspace},options={};
    const before=sessionFingerprint(registry.resolve('claude',f.workspace),chat,options);
    assert.deepEqual(Object.keys(registry.resolve('claude',f.workspace).externalTools),['workspace','tools','executionPolicy','dataDir','sandboxExecutable'],'existing sessions resume only while the policy shape is unchanged');
    await restored.remove(f.workspace,snapshot.tools[0].id);
    const after=sessionFingerprint(registry.resolve('claude',f.workspace),chat,options);
    assert.notEqual(after,before,'revocation must not resume a session that had the grant');
  }finally{store.close();}
});
test('rejects broad roots, protected configuration, relative paths and escaped executables',async()=>{
  const f=await fixture(),name='SDK';
  for(const directory of ['relative',homedir(),f.workspace,f.data,resolve(f.workspace,'..')])await assert.rejects(f.tools.add(f.workspace,{name,directory}));
  await assert.rejects(f.tools.add(f.workspace,{name,directory:f.sdk,executable:process.execPath}),/安装文件夹内/);
  await f.tools.add(f.workspace,{name,directory:f.sdk});
  await assert.rejects(f.tools.add(f.workspace,{name,directory:f.sdk}),/已经添加/);
  await writeFile(f.tools.file,'invalid JSON');assert.throws(()=>f.tools.snapshot(f.workspace),/无法读取/);
});
test('legacy tools seed the common catalog without writes; removing grants keeps reusable choices',async()=>{
  const f=await fixture();await f.tools.add(f.workspace,{name:'SDK',directory:f.sdk,executable:f.binary});
  const legacy=JSON.parse(await readFile(f.tools.file,'utf8'));delete legacy.catalog;
  const bytes=JSON.stringify(legacy);await writeFile(f.tools.file,bytes);
  const restored=new ExternalTools({root:join(f.root,'hub'),dataDir:f.data});
  const [remembered]=restored.catalog();assert.equal(remembered.name,'SDK');assert.equal(remembered.canonical,f.sdk);
  assert.equal(await readFile(f.tools.file,'utf8'),bytes,'listing old tools must not mutate permissions or files');
  const other=join(f.root,'Other project');await mkdir(other);
  assert.equal(restored.snapshot(other).tools.length,0,'catalog entries alone grant no access');
  const original=restored.snapshot(f.workspace);await restored.use(other,remembered.id);
  assert.deepEqual(restored.snapshot(f.workspace),original);
  assert.equal(restored.catalog().length,1,'the same installation is remembered once across projects');
  assert.notEqual(restored.snapshot(other).tools[0].id,original.tools[0].id,'reuse creates a separate project grant');
  await restored.remove(f.workspace,original.tools[0].id);await restored.remove(other,restored.snapshot(other).tools[0].id);
  const restarted=new ExternalTools({root:join(f.root,'hub'),dataDir:f.data});assert.equal(restarted.catalog().length,1);
  assert.equal(restarted.snapshot(f.workspace).tools.length,0);assert.equal(restarted.snapshot(other).tools.length,0);
  await restarted.use(other,remembered.id);assert.equal(restarted.snapshot(other).tools[0].executable,f.binary);
});
test('common choices retain the latest successful name and cannot bypass project restrictions',async()=>{
  const f=await fixture(),other=join(f.root,'Other');await mkdir(other);
  await f.tools.add(f.workspace,{name:'First name',directory:f.sdk});const id=f.tools.catalog()[0].id;
  await f.tools.add(other,{name:'Updated name',directory:f.sdk,executable:f.binary});
  assert.equal(f.tools.catalog().length,1);assert.equal(f.tools.catalog()[0].id,id);assert.equal(f.tools.catalog()[0].name,'Updated name');
  const bytes=await readFile(f.tools.file,'utf8');
  await assert.rejects(f.tools.use(other,id),/已经添加/);
  await assert.rejects(f.tools.use(f.sdk,id),/单独的工具安装文件夹/);
  await assert.rejects(f.tools.use(other,'unknown'),e=>e.status===404);
  assert.equal(await readFile(f.tools.file,'utf8'),bytes,'rejected choices must not update catalog or permissions');
  assert.equal(f.tools.catalog()[0].name,'Updated name');
});
test('junction retargeting and a manifest for another project fail closed',async()=>{
  const f=await fixture(),alternate=join(f.root,'alternate'),link=join(f.root,'SDK-link');await mkdir(alternate);
  await symlink(f.sdk,link,process.platform==='win32'?'junction':'dir');
  await f.tools.add(f.workspace,{name:'SDK link',directory:link});
  const snapshot=f.tools.snapshot(f.workspace);assert.throws(()=>validateToolSnapshot(snapshot,alternate),/项目路径/);
  await unlink(link);await symlink(alternate,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.tools.snapshot(f.workspace),/工具路径已变化/);
  assert.match(f.tools.view(f.workspace).tools[0].error,/工具路径已变化/);
  const [remembered]=f.tools.catalog();assert.match(remembered.error,/工具路径已变化/);
  await assert.rejects(f.tools.use(f.workspace,remembered.id),/工具路径已变化/);
});
async function ownerRuntime(f){
  const settings=join(f.data,'owner-settings.json'),mcp=join(f.data,'owner-mcp.json');
  await writeFile(settings,JSON.stringify({env:{HTTPS_PROXY:'http://proxy.invalid'},disableAllHooks:true,permissions:{blockReadsOutsideWorkingDirectories:true,deny:['Read(./private/**)']}}));
  await writeFile(mcp,JSON.stringify({mcpServers:{starport_workspace:{command:process.execPath,args:['legacy.mjs'],env:{STARPORT_CODEX_SANDBOX:process.execPath}},claude_browser:{command:process.execPath,args:['browser.mjs'],env:{OWNER_BROWSER:'preserve'}}}}));
  return {command:process.execPath,prefixArgs:['--restricted','--strict-mcp-config','--tools','Read,Edit','--settings',settings,'--mcp-config',mcp]};
}
test('Claude launch preserves owner proxy/browser rules and adds a read-only SDK without changing originals',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture(),base=await ownerRuntime(f);await f.tools.add(f.workspace,{name:'SDK',directory:f.sdk,executable:f.binary});
  const originalSettings=base.prefixArgs[base.prefixArgs.indexOf('--settings')+1],original=await readFile(originalSettings,'utf8');
  const runtime={...base,externalTools:{...f.tools.snapshot(f.workspace),dataDir:f.data}},prepared=await prepareExternalClaude(runtime,f.workspace);
  try{
    const args=prepared.runtime.prefixArgs,settings=JSON.parse(await readFile(args[args.indexOf('--settings')+1],'utf8')),mcp=JSON.parse(await readFile(args[args.indexOf('--mcp-config')+1],'utf8'));
    assert.equal(settings.env.HTTPS_PROXY,'http://proxy.invalid');assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories,true);
    assert.ok(settings.permissions.deny.includes('Read(./private/**)'));assert.match(settings.permissions.deny.at(-1),/^Edit\(\/\/[a-z]\//);
    assert.ok(args.includes('--restricted'));assert.equal(args[args.indexOf('--add-dir')+1],f.sdk);
    assert.deepEqual(mcp.mcpServers.claude_browser,{command:process.execPath,args:['browser.mjs'],env:{OWNER_BROWSER:'preserve'}});
    assert.equal(mcp.mcpServers.starport_workspace,undefined,'workspace terminal is hosted by SDK, without a stale per-turn stdio manifest');
    assert.equal(prepared.runtime.workspaceTerminal.sandboxExecutable,process.execPath);
    assert.equal(prepared.runtime.externalTools.workspace,f.workspace);assert.equal(prepared.runtime.externalTools.tools[0].canonical,f.sdk);
    assert.equal(await readFile(originalSettings,'utf8'),original);
  }finally{await prepared.cleanup();assert.equal(existsSync(prepared.directory),false);}
});
test('Claude startup failure cleans private launch copies',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture(),base=await ownerRuntime(f);await f.tools.add(f.workspace,{name:'SDK',directory:f.sdk});
  await assert.rejects(runClaude({runtime:{...base,externalTools:{...f.tools.snapshot(f.workspace),dataDir:f.data}},options:{permissionMode:'acceptEdits'},cwd:f.workspace,prompt:'test',emit(){},setControl(){},makeQuery(){throw Error('fixture startup failure');}}),/fixture startup failure/);
  const {readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(join(f.data,'external-tools-runs')),[]);
});
test('project tools API requires owner authentication, rejects cross-site grants and busy project changes',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(),runtime=await ownerRuntime(f),registry={resolve:()=>runtime,list:async()=>[],record(){}};
  const hub=createHub({port:0,dataDir:f.data,registry});await hub.listen();t.after(()=>hub.close());
  const project=hub.store.addProject('Fixture project',f.workspace),base='http://127.0.0.1:'+hub.server.address().port,path='/api/projects/'+project.id+'/external-tools';
  const headers={'X-Hub-Token':hub.token,'Content-Type':'application/json'};
  assert.equal((await fetch(base+path)).status,401);
  assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify({name:'SDK',directory:f.sdk})})).status,403);
  let response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify({name:'SDK',directory:f.sdk,executable:f.binary})});assert.equal(response.status,201);const saved=await response.json();assert.equal(saved.tools.length,1);
  assert.equal(saved.catalog.length,1);assert.equal(saved.catalog[0].name,'SDK');assert.equal(saved.catalog[0].canonical,f.sdk);
  const toolPath=path+'/'+saved.tools[0].id;
  assert.equal((await fetch(base+toolPath,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({hostApproval:'always'})})).status,401);
  assert.equal((await fetch(base+toolPath,{method:'PATCH',headers:{...headers,Origin:'https://evil.invalid'},body:JSON.stringify({hostApproval:'always'})})).status,403);
  response=await fetch(base+toolPath,{method:'PATCH',headers,body:JSON.stringify({hostApproval:'always'})});assert.equal(response.status,200);
  const allowed=await response.json();assert.equal(allowed.tools[0].hostApproval,'always');assert.equal(allowed.catalog[0].hostApproval,undefined);
  const other=join(f.root,'Another project');await mkdir(other);const otherProject=hub.store.addProject('Another',other),otherPath='/api/projects/'+otherProject.id+'/external-tools';
  const available=await(await fetch(base+otherPath,{headers})).json();assert.equal(available.tools.length,0);assert.equal(available.catalog.length,1);
  response=await fetch(base+otherPath,{method:'POST',headers,body:JSON.stringify({catalogId:saved.catalog[0].id})});assert.equal(response.status,201);
  const reused=await response.json();assert.equal(reused.tools[0].canonical,f.sdk);assert.equal(reused.tools[0].hostApproval,undefined);
  const chat=hub.store.newChat({provider:'claude',workspace:f.workspace});hub.runner.active.set(chat.id,{});
  try{response=await fetch(base+path+'/'+saved.tools[0].id,{method:'DELETE',headers});assert.equal(response.status,409);assert.equal((await(await fetch(base+path,{headers})).json()).busy,true);assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify({catalogId:saved.catalog[0].id})})).status,409);assert.equal((await fetch(base+toolPath,{method:'PATCH',headers,body:JSON.stringify({hostApproval:'ask'})})).status,409);}
  finally{hub.runner.active.delete(chat.id);}
  assert.equal((await fetch(base+path+'/'+saved.tools[0].id,{method:'DELETE',headers})).status,200);
  const removed=await(await fetch(base+path,{headers})).json();assert.equal(removed.tools.length,0);assert.equal(removed.catalog.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readClaudeNetworkPolicy,applyClaudeNetworkPolicy,createClaudeNetworkGuard} from '../src/claude-network.mjs';
import {ProviderRegistry} from '../src/providers.mjs';
import {Store} from '../src/storage.mjs';
import {prepareExternalClaude} from '../src/external-tools/claude-launch.mjs';
import {runWorkspaceCommand} from '../src/external-tools/terminal.mjs';
import {runClaude} from '../src/adapters/claude.mjs';

async function fixture(){const root=realpathSync.native(await mkdtemp(join(tmpdir(),'starport-client-network-'))),data=join(root,'data'),workspace=join(root,'project');for(const path of [data,workspace])await mkdir(path);return {root,data,workspace};}
const configuration={version:1,enabled:true,toolNetwork:'normal',proxyUrl:'http://127.0.0.1:18080',protectedPrograms:[process.execPath],gitExecutable:process.execPath};
const guarded={claudeNetwork:{script:'fixture-firewall.ps1',policyPath:'fixture-policy.json',program:process.execPath}};
const auditPassed={stdout:JSON.stringify({Success:true,Missing:[],Error:null})};
async function policy(f,value=configuration){await writeFile(join(f.data,'claude-network-policy.json'),JSON.stringify(value));return readClaudeNetworkPolicy(f.root,f.data);}

test('concurrent launches share a pending audit but subsequent launches check again',async()=>{
 let calls=0,release;
 const guard=createClaudeNetworkGuard(async(command,args,options)=>{
  calls++;assert.ok(options.timeout>=60000);assert.equal(options.env.PSModulePath,undefined);assert.ok(args.includes('Audit'));assert.ok(!args.includes('Apply'));
  if(calls===1)await new Promise(resolve=>{release=resolve;});return auditPassed;
 });
 const first=guard(guarded),second=guard(guarded);assert.equal(first,second);assert.equal(calls,1);
 release();await Promise.all([first,second]);await guard(guarded);assert.equal(calls,2);
});

test('an audit for a different executable cannot authorize another launch',async()=>{
 let calls=0;const guard=createClaudeNetworkGuard(async()=>{calls++;return auditPassed;});
 await Promise.all([guard(guarded),guard({claudeNetwork:{...guarded.claudeNetwork,program:'another-client.exe'}})]);assert.equal(calls,2);
});

test('a timed out audit blocks all waiting launches and does not instruct firewall reapplication',async()=>{
 let calls=0;const guard=createClaudeNetworkGuard(async()=>{calls++;throw Object.assign(Error('fixture deadline'),{killed:true,signal:'SIGTERM'});});
 const results=await Promise.allSettled([guard(guarded),guard(guarded)]);assert.equal(calls,1);
 for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'CLAUDE_NETWORK_AUDIT_TIMEOUT');assert.match(result.reason.message,/已阻止启动/);assert.doesNotMatch(result.reason.message,/-Mode Apply/);}
 await assert.rejects(guard(guarded));assert.equal(calls,2);
});

test('missing coverage and query failures remain blocked with actionable original reasons',async()=>{
 const missing=createClaudeNetworkGuard(async()=>{throw Object.assign(Error('exit 1'),{stdout:JSON.stringify({Success:false,Missing:['new-client.exe'],Error:null})});});
 await assert.rejects(missing(guarded),error=>{assert.match(error.message,/new-client.exe/);assert.match(error.message,/-Mode Apply/);return true;});
 const denied=createClaudeNetworkGuard(async()=>{throw Object.assign(Error('exit 1'),{stdout:JSON.stringify({Success:false,Missing:[],Error:'Access is denied'})});});
 await assert.rejects(denied(guarded),error=>{assert.match(error.message,/Access is denied/);assert.match(error.message,/未回退直连/);assert.doesNotMatch(error.message,/-Mode Apply/);return true;});
});

test('a zero exit without an explicit successful audit never authorizes a launch',async()=>{
 for(const stdout of ['', 'not JSON', '{}', JSON.stringify({Success:false,Missing:[]}),JSON.stringify({Success:'true'})]){
  const guard=createClaudeNetworkGuard(async()=>({stdout}));await assert.rejects(guard(guarded),/已阻止启动/);
 }
 const failed=createClaudeNetworkGuard(async()=>{throw Object.assign(Error('exit 1'),auditPassed);});await assert.rejects(failed(guarded),/已阻止启动/);
});

test('only Claude clients force the proxy; DSH and ordinary providers stay unchanged',async()=>{
 const f=await fixture();assert.equal(readClaudeNetworkPolicy(f.root,f.data),null);const p=await policy(f);
 const runtime={command:process.execPath,env:{https_proxy:'http://wrong.invalid',ELECTRON_RUN_AS_NODE:'1'}};
 const value=applyClaudeNetworkPolicy(runtime,'claude',p);assert.equal(value.env.HTTPS_PROXY,p.proxyUrl);assert.equal(value.env.https_proxy,p.proxyUrl);assert.equal(value.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(value.claudeNetwork.program,process.execPath);
 for(const id of ['deepseek','codex'])assert.equal(applyClaudeNetworkPolicy(runtime,id,p),runtime);assert.equal(runtime.env.https_proxy,'http://wrong.invalid');
 assert.equal(await policy(f,{...configuration,activated:false}),null);
 await assert.rejects(policy(f,{...configuration,proxyUrl:'http://user:password@127.0.0.1:18080'}),/网络策略无效/);
});
test('all Claude projects receive the normal terminal, including those with no external grants',async()=>{
 const f=await fixture(),store=new Store(':memory:');try{
  store.setSetting('providers',{claude:{command:process.execPath},codex:{command:process.execPath},deepseek:{command:process.execPath}});const registry=new ProviderRegistry(f.root,f.data,store);
  assert.equal(registry.resolve('claude',f.workspace).externalTools,undefined);await policy(f);
  const value=registry.resolve('claude',f.workspace);assert.equal(value.externalTools.tools.length,0);assert.equal(value.externalTools.normalPolicy.toolNetwork,'normal');assert.ok(value.claudeNetwork);
  assert.equal(registry.resolve('codex',f.workspace).normalPolicy,undefined);
  const dsh=registry.resolve('deepseek',f.workspace);assert.equal(dsh.claudeNetwork,undefined);assert.equal(dsh.env?.HTTPS_PROXY,undefined);
 }finally{store.close();}
});
test('normal policy replaces a stale temporary runner while retaining the browser and file restrictions',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),p=await policy(f),mcp=join(f.data,'mcp.json');await writeFile(mcp,JSON.stringify({mcpServers:{starport_workspace:{command:'missing-old-node.exe',env:{STARPORT_ISOLATED_RUNNER:'missing-date-path',STARPORT_ALLOW_HOST_TOOLS:'0'}},browser:{command:process.execPath,args:['browser.mjs']}}}));
 const runtime={command:process.execPath,normalPolicy:p,prefixArgs:['--mcp-config',mcp],externalTools:{workspace:f.workspace,tools:[],dataDir:f.data,sandboxExecutable:process.execPath,normalPolicy:p}};
 const prepared=await prepareExternalClaude(runtime,f.workspace);try{
  assert.equal(prepared.runtime.workspaceTerminal.hostExecution,true);assert.equal(prepared.runtime.workspaceTerminal.normalPolicy.toolNetwork,'normal');assert.equal(prepared.runtime.workspaceTerminal.runner,undefined);
  const args=prepared.runtime.prefixArgs,value=JSON.parse(await readFile(args[args.indexOf('--mcp-config')+1],'utf8'));assert.ok(value.mcpServers.browser);assert.equal(value.mcpServers.starport_workspace,undefined);
  const settings=JSON.parse(await readFile(args[args.indexOf('--settings')+1],'utf8'));assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories,true);
 }finally{await prepared.cleanup();}
});
test('an unverified protected client is stopped before any native query starts',{skip:process.platform!=='win32'},async()=>{
 let started=false;await assert.rejects(runClaude({runtime:{command:process.execPath,claudeNetwork:{script:'missing-firewall-audit.ps1',policyPath:'missing-policy.json',program:process.execPath}},cwd:process.cwd(),options:{permissionMode:'bypassPermissions'},prompt:'fixture',emit(){},setControl(){},makeQuery(){started=true;throw Error('must not start');}}),/已阻止启动/);assert.equal(started,false);
});
test('normal command request permits networking but retains deny-by-default filesystem and strips client credentials',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),p=await policy(f),client=join(p.runtimeDir,'git-client');await mkdir(client,{recursive:true});await writeFile(join(client,'git-askpass.exe'),'fixture');
 await writeFile(join(f.workspace,'sandbox'),"console.log(JSON.stringify({args:process.argv.slice(2),secret:!!process.env.STARPORT_TEST_API_KEY,proxy:process.env.HTTPS_PROXY||null}))");
 const original={STARPORT_TEST_API_KEY:process.env.STARPORT_TEST_API_KEY,HTTPS_PROXY:process.env.HTTPS_PROXY};
 process.env.STARPORT_TEST_API_KEY='fixture';process.env.HTTPS_PROXY='http://wrong.invalid';
 try{const value=await runWorkspaceCommand({workspace:f.workspace,sandboxExecutable:process.execPath,normalPolicy:p,command:'literal command',timeoutMs:5000});const output=JSON.parse(value.stdout);
  assert.equal(value.exitCode,0);assert.equal(value.networkMode,'normal-development');assert.equal(output.secret,false);assert.equal(output.proxy,null);
  assert.ok(output.args.some(v=>v.includes('network={ enabled=true }')));assert.ok(output.args.some(v=>v.includes('\":root\" = \"deny\"')));
 }finally{for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

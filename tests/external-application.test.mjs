import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,unlink} from 'node:fs/promises';
import {realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ExternalTools} from '../src/external-tools/grants.mjs';
import {externalApplicationRequest,runExternalApplication} from '../src/external-tools/host-run.mjs';
import {runClaude} from '../src/adapters/claude.mjs';
import {ExternalApplicationManager} from '../src/external-tools/applications.mjs';
import {exec} from '../src/process.mjs';
import {pathToFileURL} from 'node:url';

const windows={skip:process.platform!=='win32'};
async function fixture(){
  const root=realpathSync.native(await mkdtemp(join(tmpdir(),'starport-application-'))),workspace=join(root,'项目 & workspace'),data=join(root,'hub','.data');
  await mkdir(workspace,{recursive:true});await mkdir(data,{recursive:true});
  const tools=new ExternalTools({root:join(root,'hub'),dataDir:data});
  await tools.add(workspace,{name:'Native runtime',directory:dirname(process.execPath),executable:process.execPath});
  const snapshot=tools.snapshot(workspace);return {root,workspace,data,tools,snapshot,toolId:snapshot.tools[0].id};
}
test('host launch validates a current project executable and physical working directory before asking approval',windows,async()=>{
  const f=await fixture(),outside=join(f.root,'outside');await mkdir(outside);
  const request=externalApplicationRequest({...f,args:['; & $()','a"b','空 格']});
  assert.equal(request.executable,process.execPath);assert.equal(request.cwd,f.workspace);assert.match(request.warning,/项目外文件及网络/);
  for(const input of [{toolId:'ungranted'}, {directory:'..'},{directory:outside},{args:'echo bad'},{args:['a\0b']},{timeoutMs:900001},{successExitCodes:[-1]},{successExitCodes:[]}]){
    assert.throws(()=>externalApplicationRequest({...f,...input}));
  }
  const link=join(f.workspace,'outside-link');await symlink(outside,link,'junction');
  assert.throws(()=>externalApplicationRequest({...f,directory:'outside-link'}),/当前项目内/);
  await f.tools.remove(f.workspace,f.toolId);assert.equal(f.tools.catalog().length,1);
  assert.throws(()=>externalApplicationRequest({...f,snapshot:f.tools.snapshot(f.workspace)}),/程序路径/,'remembered catalog entries do not authorize execution');
});
test('decline, missing approval and canceled approval never launch the application',windows,async()=>{
  const f=await fixture(),marker=join(f.workspace,'should-not-exist.txt');
  const input={...f,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'BAD')`]};
  for(const approve of [undefined,async()=>false]){const result=await runExternalApplication({...input,approve});assert.equal(result.approved,false);assert.equal(result.ok,false);}
  const controller=new AbortController();
  await assert.rejects(runExternalApplication({...input,signal:controller.signal,approve:async()=>{controller.abort();return true;}}),/取消/);
  assert.equal(existsSync(marker),false);
  await assert.rejects(runExternalApplication({...input,toolId:'wrong',approve:()=>assert.fail('unregistered executable must fail before approval')}));
});
test('arguments remain literal, Unicode cwd survives, and documented nonzero success codes are explicit',windows,async()=>{
  const f=await fixture(),values=['空 格','a"b','C:\\尾巴\\','; & $()',''];let approvals=0;
  const result=await runExternalApplication({...f,args:['-e','console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}));process.exit(36)',...values],successExitCodes:[36],approve:async request=>{approvals++;assert.deepEqual(request.args.slice(2),values);return true;}});
  assert.equal(result.ok,true,result.stderr);assert.equal(result.exitCode,36);assert.equal(approvals,1);
  assert.deepEqual(JSON.parse(result.stdout),{args:values,cwd:f.workspace});assert.match(result.isolation,/no project filesystem or network sandbox/);
  const rejected=await runExternalApplication({...f,args:['-e','process.exit(36)'],approve:async()=>true});assert.equal(rejected.ok,false);assert.equal(rejected.exitCode,36);
});
test('a junction changed during approval is revalidated before host execution',windows,async()=>{
  const f=await fixture(),sdk=join(f.root,'sdk'),other=join(f.root,'other'),link=join(f.root,'sdk-link');
  for(const path of [sdk,other]){await mkdir(path);await writeFile(join(path,'tool.exe'),'fixture');}
  await symlink(sdk,link,'junction');await f.tools.add(f.workspace,{name:'Linked SDK',directory:link,executable:join(link,'tool.exe')});
  const snapshot=f.tools.snapshot(f.workspace);
  await assert.rejects(runExternalApplication({...f,snapshot,toolId:snapshot.tools[1].id,approve:async()=>{await unlink(link);await symlink(other,link,'junction');return true;}}),/路径已变化/);
});
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
test('owned Windows job closes detached descendants when their parent exits',windows,async()=>{
  const f=await fixture(),pidFile=join(f.workspace,'child.pid');
  const code=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();`;
  const result=await runExternalApplication({...f,args:['-e',code],approve:async()=>true,timeoutMs:15000});assert.equal(result.ok,true,result.stderr);
  const pid=Number(await readFile(pidFile,'utf8'));assert.equal(alive(pid),false,'detached child must not outlive the owned job');
});
test('timeout and cancellation stop the owned application tree',windows,async()=>{
  for(const cancel of [false,true]){
    const f=await fixture(),controller=new AbortController(),pidFile=join(f.workspace,'parent.pid');
    const code=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
    const running=runExternalApplication({...f,args:['-e',code],timeoutMs:cancel?15000:2500,signal:controller.signal,approve:async()=>true});
    if(cancel){for(let i=0;i<100&&!existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,50));assert.equal(existsSync(pidFile),true);controller.abort();}
    const result=await running;assert.equal(result.ok,false);assert.equal(cancel?result.canceled:result.timedOut,true);
    assert.equal(alive(Number(await readFile(pidFile,'utf8'))),false);
  }
});
test('SDK host MCP still asks a one-time user decision under auto and bypass modes',windows,async()=>{
  for(const permissionMode of ['auto','bypassPermissions']){
    const f=await fixture(),mcp=join(f.data,'owner-mcp.json');
    await writeFile(mcp,JSON.stringify({mcpServers:{starport_workspace:{env:{STARPORT_CODEX_SANDBOX:process.execPath}}}}));
    let control,request,resolveApproval;const appeared=new Promise(r=>resolveApproval=r);let callResult;
    const makeQuery=({options})=>({close(){},async *[Symbol.asyncIterator](){
      assert.ok(options.allowedTools.includes('mcp__starport_external_tools__run'));
      const server=options.mcpServers.starport_external_tools.instance,client=new Client({name:'application-test',version:'1.0.0'}),[a,b]=InMemoryTransport.createLinkedPair();
      try{await server.connect(b);await client.connect(a);
        const listed=await client.listTools();assert.match(listed.tools[0].description,/ask-policy tool requires explicit approval/);
        callResult=await client.callTool({name:'run',arguments:{toolId:f.toolId,args:['--version']}});
        yield {type:'result',subtype:'success',result:'done',session_id:'fixture'};
      }finally{await client.close();await server.close();}
    }});
    const running=runClaude({runtime:{command:process.execPath,prefixArgs:['--mcp-config',mcp],externalTools:{...f.snapshot,dataDir:f.data}},options:{permissionMode},prompt:'fixture',cwd:f.workspace,
      setControl:value=>control=value,emit:event=>{if(event.type==='approval'){request=event.request;resolveApproval();}},makeQuery});
    running.then(()=>{if(!request)resolveApproval();},()=>resolveApproval());
    await Promise.race([appeared,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('host approval not received: '+JSON.stringify(callResult))),5000);timer.unref();})]);
    assert.ok(request,JSON.stringify(callResult));assert.equal(request.params.defaultToNo,true);assert.equal(request.params.input.executable,process.execPath);assert.match(request.params.description,/不是项目沙箱/);
    await control.answer(request.id,{decision:'decline'});await running;assert.equal(callResult.isError,true);assert.equal(JSON.parse(callResult.content[0].text).approved,false);
    await assert.rejects(control.answer(request.id,{decision:'accept'}),/失效/);
  }
});
test('remembered host consent is scoped to one project executable and is not copied by the catalog',windows,async()=>{
  const f=await fixture(),other=join(f.root,'other-project');await mkdir(other);
  await f.tools.setHostApproval(f.workspace,f.toolId,'always');
  const allowed=f.tools.snapshot(f.workspace);assert.equal(allowed.tools[0].hostApproval,'always');assert.equal(f.tools.catalog()[0].hostApproval,undefined);
  await f.tools.use(other,f.tools.catalog()[0].id);assert.equal(f.tools.snapshot(other).tools[0].hostApproval,undefined);
  const result=await runExternalApplication({...f,snapshot:allowed,args:['-e','console.log("REMEMBERED")'],approve:()=>assert.fail('remembered consent must not prompt again')});
  assert.equal(result.ok,true,result.stderr);assert.match(result.stdout,/REMEMBERED/);
  await f.tools.setHostApproval(f.workspace,f.toolId,'ask');
  const denied=await runExternalApplication({...f,snapshot:f.tools.snapshot(f.workspace),args:['-e','process.exit(0)'],approve:async()=>false});assert.equal(denied.approved,false);
  assert.throws(()=>f.tools.setHostApproval(f.workspace,f.toolId,'global'),/有效/);
});
test('persistent applications survive their launching Node process and can be reattached, reused and stopped by scoped job id',windows,async t=>{
  const f=await fixture(),manager=new ExternalApplicationManager(f.data),other=join(f.root,'other-project');await mkdir(other);
  const marker=join(f.workspace,'persistent.pid'),input={workspace:f.workspace,snapshot:f.snapshot,toolId:f.toolId,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`],persistent:true};
  const script=`import {runExternalApplication} from ${JSON.stringify(pathToFileURL(resolveModule('../src/external-tools/host-run.mjs')).href)};import {ExternalApplicationManager} from ${JSON.stringify(pathToFileURL(resolveModule('../src/external-tools/applications.mjs')).href)};const r=await runExternalApplication({...${JSON.stringify(input)},manager:new ExternalApplicationManager(${JSON.stringify(f.data)}),approve:async()=>true});console.log(JSON.stringify(r));`;
  const output=await exec(process.execPath,['--input-type=module','-e',script],{timeout:15000,windowsHide:true});const launched=JSON.parse(output.stdout);assert.equal(launched.ok,true,JSON.stringify(launched));
  t.after(async()=>{for(const row of await manager.list(f.workspace))if(row.state==='running')await manager.stop(f.workspace,row.id);});
  const pid=Number(await readFile(marker,'utf8'));assert.equal(alive(pid),true,'editor survives launcher process exit');
  const row=(await manager.list(f.workspace))[0];assert.equal(row.state,'running');assert.equal(row.id,launched.application.id);
  assert.deepEqual(await manager.list(other),[]);await assert.rejects(manager.stop(other,row.id),e=>e.status===404);
  const reused=await runExternalApplication({...input,manager,approve:async()=>true});assert.equal(reused.reused,true);assert.equal(reused.application.id,row.id);
  await manager.stop(f.workspace,row.id);assert.equal(alive(pid),false);assert.equal((await manager.list(f.workspace))[0].state,'stopped');
});
const resolveModule=relative=>new URL(relative,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');

test('persistent mode keeps a launcher child alive and stopping during startup leaves no application',windows,async t=>{
  const f=await fixture(),manager=new ExternalApplicationManager(f.data),marker=join(f.workspace,'child.pid');
  const code=`const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
  const result=await runExternalApplication({...f,args:['-e',code],persistent:true,manager,approve:async()=>true});
  t.after(async()=>{for(const row of await manager.list(f.workspace))if(row.state==='running')await manager.stop(f.workspace,row.id);});
  assert.equal(result.ok,true,JSON.stringify(result));const pid=Number(await readFile(marker,'utf8'));assert.equal(alive(pid),true);
  await manager.stop(f.workspace,result.application.id);assert.equal(alive(pid),false);
  const controller=new AbortController(),pending=runExternalApplication({...f,args:['-e','setInterval(()=>{},1000)'],persistent:true,manager,signal:controller.signal,approve:async()=>true});
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(pending,/取消/);assert.ok((await manager.list(f.workspace)).every(row=>row.state!=='running'));
  const starting=runExternalApplication({...f,args:['-e','setInterval(()=>{},1000)'],persistent:true,manager,approve:async()=>true});
  let row;for(let i=0;i<80;i++){row=(await manager.list(f.workspace)).find(item=>item.state==='starting');if(row)break;await new Promise(r=>setTimeout(r,25));}
  assert.ok(row,'user can see and close an application during startup');await manager.stop(f.workspace,row.id);
  assert.equal((await starting).ok,false);assert.ok((await manager.list(f.workspace)).every(item=>item.state!=='running'));
});

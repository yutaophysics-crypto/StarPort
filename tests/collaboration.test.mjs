import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,realpath } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createCollaborationHub } from '../src/collaboration/server.mjs';
import { DesktopWorker,groupPrompt,remoteOptions,remoteAnswer } from '../src/collaboration/desktop.mjs';
import { createHub } from '../src/server.mjs';

const temp=async()=>realpath(await mkdtemp(join(tmpdir(),'starport-groups-')));
async function client(base,username){
  const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,name:username,password:'test-password-'+username})});assert.equal(response.status,201);const auth=await response.json(),cookie=response.headers.getSetCookie()[0].split(';')[0];
  const raw=async(path,method='GET',body,headers={})=>fetch(base+'/api'+path,{method,headers:{Origin:base,Cookie:cookie,'X-Starport-CSRF':auth.csrf,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const send=async(...args)=>{const response=await raw(...args),data=await response.json();if(!response.ok)throw Error(response.status+': '+data.error);return data;};return {...auth,cookie,raw,send};
}
async function until(check){for(let i=0;i<800;i++){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Group integration timed out');}
const registry=owner=>({resolve:()=>({command:process.execPath,prefixArgs:[],privateCredential:'private-test-token-'+owner}),probe:async()=>({installed:true,loggedIn:true}),models:async()=>({models:[{id:'fixture-model',label:'Fixture'}]}),record:()=>{}});
async function link(base,api,folder,reg,implementations,interval=30){const device=await api.send('/devices','POST',{name:api.user.name+'电脑'});await api.send('/binding','PUT',{deviceId:device.id});const worker=new DesktopWorker({link:{hubUrl:base,deviceId:device.id,token:device.token,user:api.user,execution:'edit',workspaces:[{id:'workspace-one',name:'测试目录',path:folder}]},registry:reg,dataDir:await temp(),implementations,interval});await worker.start();return {worker,device};}
async function pair(t){const hub=createCollaborationHub({dataDir:await temp(),port:0});await hub.listen();t.after(()=>hub.close());const base=hub.origin(),a=await client(base,'alice'),b=await client(base,'bob'),room=await a.send('/rooms','POST',{name:'共同项目'}),invite=await a.send('/rooms/'+room.id+'/invites','POST',{});await b.send('/rooms/join','POST',{token:invite.token});return {hub,base,a,b,room};}

test('authenticated collaboration HTTP protects sessions, membership, device ownership and remote credentials',async t=>{
  const {hub,base,a,b,room}=await pair(t);
  assert.equal((await fetch(base+'/api/state')).status,401);
  assert.equal((await a.raw('/rooms','POST',{name:'bad'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await a.raw('/rooms','POST',{name:'bad'},{'X-Starport-CSRF':'wrong'})).status,403);
  const c=await client(base,'outsider');assert.equal((await c.raw('/rooms/'+room.id+'/messages')).status,403);
  const device=await a.send('/devices','POST',{name:'我的电脑'});assert.equal((await b.raw('/binding','PUT',{deviceId:device.id})).status,403);
  assert.equal((await fetch(base+'/api/device/poll',{method:'POST',headers:{Authorization:'Bearer '+a.csrf},body:'{}'})).status,401);
  assert.equal((await a.raw('/rooms/'+room.id+'/invoke','POST',{content:'task',clientId:'key-test',provider:'codex',workspaceId:'x',options:{apiKey:'do-not-upload'}})).status,400);
  const session=await a.send('/auth/session');assert.equal(session.csrf,a.csrf);
  assert.ok(!JSON.stringify(hub.store.devices(a.user.id)).includes(device.token));
});

test('a tunnel deployment keeps its public origin, secure sessions and polling choice across login',async t=>{
  const publicUrl='https://groups.example.com',hub=createCollaborationHub({dataDir:await temp(),port:0,publicUrl,eventsTransport:'poll'});
  await hub.listen();t.after(()=>hub.close());const local='http://127.0.0.1:'+hub.server.address().port;
  // Simulate the tunnel's preserved Host; fetch does not allow overriding it.
  const request=(path,method='GET',body,headers={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(local+path,{method,headers:{Host:new URL(publicUrl).host,Origin:publicUrl,'Content-Type':'application/json',...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(new Response(text,{status:res.statusCode,headers:Object.entries(res.headers).flatMap(([key,value])=>(Array.isArray(value)?value:[value]).map(v=>[key,v]))})));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  assert.equal((await (await fetch(local+'/health')).json()).origin,publicUrl);
  assert.equal((await fetch(local+'/')).status,403);
  const input={username:'tunnel-test',name:'Tunnel test',password:'fixture-password-tunnel'};
  const register=await request('/api/auth/register','POST',input);assert.equal(register.status,201);
  const auth=await register.json(),cookie=register.headers.getSetCookie()[0];assert.match(cookie,/; Secure/);assert.equal(auth.eventsTransport,'poll');
  const headers={Cookie:cookie.split(';')[0],'X-Starport-CSRF':auth.csrf};
  assert.equal((await (await request('/api/auth/session','GET',undefined,headers)).json()).eventsTransport,'poll');
  const room=await (await request('/api/rooms','POST',{name:'Tunnel room'},headers)).json();
  const invite=await (await request('/api/rooms/'+room.id+'/invites','POST',{},headers)).json();assert.equal(new URL(invite.url).origin,publicUrl);
  assert.equal((await request('/api/rooms','POST',{name:'Rejected'},{...headers,Origin:'https://another.example'})).status,403);
  const login=await request('/api/auth/login','POST',input);assert.equal((await login.json()).eventsTransport,'poll');
});

test('two group users run all four providers on their own linked computers and never share runtime credentials or private memory',{timeout:15000},async t=>{
  const {hub,base,a,b,room}=await pair(t),observed=[],workers=[];
  const implementations=Object.fromEntries(['codex','claude','antigravity','deepseek'].map(provider=>[provider,async({runtime,prompt,cwd,emit,contextTools,contextEnv})=>{
    assert.equal(contextTools,null);assert.equal(contextEnv.STARPORT_CONTEXT_TOKEN,'');
    observed.push({provider,credential:runtime.privateCredential,cwd,prompt});await writeFile(join(cwd,provider+'.txt'),'Executed on '+runtime.privateCredential);
    emit({type:'tool',id:'private-tool',name:'check',status:'complete',input:{secret:runtime.privateCredential},output:runtime.privateCredential});
    emit({type:'replace',text:runtime.privateCredential.endsWith('alice')?'Alice agent reply':'Bob agent reply'});
  }]));
  const fa=await temp(),fb=await temp();const wa=await link(base,a,fa,registry('alice'),implementations),wb=await link(base,b,fb,registry('bob'),implementations);workers.push(wa.worker,wb.worker);t.after(async()=>{for(const worker of workers)await worker.close();});
  for(const provider of ['codex','claude','antigravity','deepseek']){
    for(const api of [a,b]){const job=await api.send('/rooms/'+room.id+'/invoke','POST',{content:'帮我完成测试',clientId:provider+'-'+api.user.id,provider,workspaceId:'workspace-one',options:{model:'fixture-model'}});await until(async()=>{const state=await api.send('/jobs/'+job.id);if(state.status==='error')throw Error(state.error);return state.status==='complete';});}
  }
  assert.equal(observed.length,8);assert.ok(observed.every(row=>row.cwd===fa?row.credential.endsWith('alice'):row.cwd===fb&&row.credential.endsWith('bob')));
  assert.ok(observed.every(row=>!row.prompt.includes('private-test-token')));
  assert.equal((await readFile(join(fa,'codex.txt'),'utf8')).includes('alice'),true);assert.equal((await readFile(join(fb,'claude.txt'),'utf8')).includes('bob'),true);
  const shared=await a.send('/rooms/'+room.id+'/messages');assert.equal(shared.messages.filter(m=>m.kind==='agent'&&m.status==='complete').length,8);
  const data=JSON.stringify({jobs:hub.store.db.prepare('SELECT * FROM jobs').all(),messages:hub.store.db.prepare('SELECT * FROM messages').all(),devices:hub.store.db.prepare('SELECT * FROM devices').all()});assert.ok(!data.includes('private-test-token'));
  assert.equal(wa.worker.store.memory.config().enabled,false);assert.equal(wb.worker.store.instructions.get().content,'');
});

test('mobile approvals and stop reach the existing runner while other group members cannot control the task',{timeout:12000},async t=>{
  const {base,a,b,room}=await pair(t);let answer,stopped=0;
  const implementation=async({emit,setControl,signal,prompt})=>{
    let release;const gate=new Promise(resolve=>release=resolve);
    setControl({stop:()=>{stopped++;release();},answer:async(id,value)=>{answer=value;emit({type:'approval-resolved',id});release();}});
    if(prompt.includes('审批测试'))emit({type:'approval',request:{id:'request-one',kind:'permission',title:'允许命令?',params:{command:'echo test'}}});
    await gate;if(signal.aborted)throw Object.assign(Error('已停止'),{canceled:true});emit({type:'replace',text:'审批已收到'});
  };
  const {worker}=await link(base,a,await temp(),registry('alice'),{codex:implementation});t.after(()=>worker.close());
  const job=await a.send('/rooms/'+room.id+'/invoke','POST',{content:'审批测试',clientId:'approve-job',provider:'codex',workspaceId:'workspace-one'});
  await until(async()=>!!(await a.send('/jobs/'+job.id)).approvals?.length);
  assert.equal((await b.send('/jobs/'+job.id)).approvals,undefined);
  assert.equal((await b.raw('/jobs/'+job.id+'/actions','POST',{clientId:'not-owner',action:'stop'})).status,403);
  await a.send('/jobs/'+job.id+'/actions','POST',{clientId:'approval-answer',action:'approval',requestId:'request-one',decision:'accept'});
  await until(async()=>(await a.send('/jobs/'+job.id)).status==='complete');assert.equal(answer.decision,'accept');
  const next=await a.send('/rooms/'+room.id+'/invoke','POST',{content:'等待停止',clientId:'stop-job',provider:'codex',workspaceId:'workspace-one'});
  await until(async()=>(await a.send('/jobs/'+next.id)).status==='running');await a.send('/jobs/'+next.id+'/actions','POST',{clientId:'stop-action',action:'stop'});
  await until(async()=>(await a.send('/jobs/'+next.id)).status==='interrupted');assert.ok(stopped>=1);
});

test('desktop connection routes keep the existing local workbench authenticated and expose no device token',async t=>{
  const local=createHub({port:0,dataDir:await temp(),registry:{...registry('local'),list:async()=>[]}});await local.listen();t.after(()=>local.close());const base='http://127.0.0.1:'+local.server.address().port;
  assert.equal((await fetch(base+'/api/collaboration/status')).status,401);
  const response=await fetch(base+'/api/collaboration/status',{headers:{'X-Hub-Token':local.token}});assert.equal(response.status,200);assert.equal((await response.json()).connected,false);
});

test('logging into a desktop binds the same Starport account and persists only a protected device capability',{timeout:15000},async t=>{
  const {base,a,room}=await pair(t),directory=await temp(),folder=await temp();
  const local=createHub({port:0,dataDir:directory,registry:{...registry('local'),list:async()=>[]},implementations:{antigravity:async({emit})=>emit({type:'replace',text:'Desktop execution'})}});await local.listen();t.after(()=>local.close());const localBase='http://127.0.0.1:'+local.server.address().port;
  const response=await fetch(localBase+'/api/collaboration/connect',{method:'POST',headers:{Origin:localBase,'X-Hub-Token':local.token,'Content-Type':'application/json'},body:JSON.stringify({hubUrl:base,username:'alice',password:'test-password-alice',name:'绑定的电脑',execution:'edit',workspaces:[{path:folder}]})});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.user.id,a.user.id);assert.equal(result.token,undefined);
  const saved=JSON.parse(await readFile(join(directory,'collaboration-link.json'),'utf8'));assert.equal(saved.password,undefined);assert.ok(saved.token);assert.ok(!JSON.stringify(result).includes(saved.token));
  const state=await a.send('/state');assert.equal(state.binding.deviceId,result.deviceId);
  const job=await a.send('/rooms/'+room.id+'/invoke','POST',{clientId:'local-desktop-call',content:'hi',provider:'antigravity',workspaceId:state.devices[0].workspaces[0].id});await until(async()=>(await a.send('/jobs/'+job.id)).status==='complete');
});

test('remote group context quotes peers and cannot accept executable or permission flags in model selection',()=>{
  const prompt=groupPrompt({message:{id:'latest',author:'Alice',content:'review this'},history:[{id:'old',author:'Bob',kind:'user',content:'untrusted text'},{id:'latest',author:'Alice',kind:'user',content:'review this'}]});assert.match(prompt,/引用资料/);assert.match(prompt,/untrusted text/);assert.equal((prompt.match(/review this/g)||[]).length,1);
  assert.throws(()=>remoteOptions('antigravity',{model:'--dangerously-skip-permissions'},'edit'));
  assert.equal(remoteOptions('codex',{},'plan').sandbox,'read-only');assert.equal(remoteOptions('claude',{},'plan').permissionMode,'plan');assert.throws(()=>remoteOptions('deepseek',{},'plan'));
});

test('phone answers respect native Claude single-choice strings and multi-choice arrays',()=>{
  const request={params:{questions:[{id:'0',multiSelect:false},{id:'1',multiSelect:true}]}},action={decision:'accept',answers:{'0':['界面','自由说明'],'1':['界面','流程']}};
  assert.deepEqual(remoteAnswer('claude',request,action),{decision:'accept',answers:{'0':'界面、自由说明','1':['界面','流程']}});
  assert.deepEqual(remoteAnswer('codex',request,action),action);
  assert.deepEqual(action.answers['0'],['界面','自由说明']);
});

test('group jobs reach all four native child transports with caller runtime and no private context bridge',{timeout:20000},async t=>{
  const original={url:process.env.STARPORT_CONTEXT_URL,token:process.env.STARPORT_CONTEXT_TOKEN};process.env.STARPORT_CONTEXT_URL='http://private-fixture.invalid';process.env.STARPORT_CONTEXT_TOKEN='parent-private-fixture-token';
  t.after(()=>{for(const [name,value] of [['STARPORT_CONTEXT_URL',original.url],['STARPORT_CONTEXT_TOKEN',original.token]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
  const {base,a,room}=await pair(t),folder=await temp();
  const nativeRegistry={resolve:provider=>({command:process.execPath,prefixArgs:[resolve('tests/fixtures/collaboration-native.mjs'),provider,'alice']}),probe:async()=>({installed:true,loggedIn:true}),models:async()=>({models:[]}),record:()=>{}};
  const {worker}=await link(base,a,folder,nativeRegistry,{});t.after(()=>worker.close());
  for(const provider of ['codex','claude','antigravity','deepseek']){
    const job=await a.send('/rooms/'+room.id+'/invoke','POST',{content:'Native transport check',clientId:'native-'+provider,provider,workspaceId:'workspace-one'});
    const result=await until(async()=>{const state=await a.send('/jobs/'+job.id);if(state.status==='error')throw Error(provider+': '+state.error);return state.status==='complete'&&state;});
    assert.equal(result.message.content.trim(),provider+' alice native reply');
    const observed=JSON.parse(await readFile(join(folder,provider+'.json'),'utf8'));assert.equal(observed.owner,'alice');assert.equal(observed.cwd,folder);assert.match(observed.prompt,/Native transport check/);
  }
});

test('a repeated terminal snapshot while its acknowledgement is pending is sent only once',async t=>{
  const folder=await temp(),worker=new DesktopWorker({link:{user:{id:'owner'},workspaces:[{id:'workspace',name:'Workspace',path:folder}]},registry:registry('owner'),dataDir:await temp()});t.after(()=>worker.close());
  let release;const gate=new Promise(resolve=>release=resolve),sent=[];worker.active={job:{id:'job',claimToken:'claim'},seq:0,pending:null};worker.post=async(path,data)=>{sent.push(data);await gate;return {seq:data.seq,status:data.status};};
  const final={status:'complete',content:'Final',progress:[],approvals:[],notices:[],error:''};worker.schedule(final);clearTimeout(worker.active.flushTimer);worker.active.flushTimer=null;const flushing=worker.flush(worker.active);worker.schedule({...final});release();await flushing;await worker.drain(worker.active);assert.equal(sent.length,1);
});

test('a computer stops its local task after losing lease renewal even while the service remains unreachable',async t=>{
  const folder=await temp(),worker=new DesktopWorker({link:{user:{id:'owner'},workspaces:[{id:'workspace',name:'Workspace',path:folder}]},registry:registry('owner'),dataDir:await temp()});t.after(()=>worker.close());let stopped=0;
  worker.active={job:{id:'job'},chatId:'local-chat'};worker.lastLeaseAt=Date.now()-120000;worker.post=async()=>{throw Error('offline');};worker.runner.stop=async()=>{stopped++;};await worker.tick();assert.equal(stopped,1);assert.equal(worker.active.lostLease,true);worker.active=null;
});

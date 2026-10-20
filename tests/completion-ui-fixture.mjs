// Local isolated fixture: all providers are fake; no credentials or model calls.
// Provider discovery deliberately stalls after completion. DISCONNECT drops SSE
// immediately before the final packet to exercise automatic catchup.
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
let blockedUntil=0,disconnect=false;const streams=new Set();
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),
  record:()=>{blockedUntil=Date.now()+10000;if(disconnect){disconnect=false;for(const stream of streams)stream.destroy();}},
  list:async()=>{const wait=Math.max(0,blockedUntil-Date.now());if(wait)await new Promise(resolve=>setTimeout(resolve,wait));return Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'隔离测试 · 完成状态'}));}};
const fake=async({emit,setControl,signal,prompt})=>{
  const input=prompt.split('\n--- 用户 ---\n').at(-1);
  let stop;const stopped=new Promise(resolve=>stop=resolve);setControl({stop});
  emit({type:'tool',id:'last-tool',name:'read_file',status:'running',input:{path:'tests/completion-ui-fixture.mjs'}});
  emit({type:'replace',text:'正在检查任务结束通知。'});
  await Promise.race([new Promise(resolve=>setTimeout(resolve,2000)),stopped]);
  if(signal.aborted)throw Object.assign(Error('已停止'),{canceled:true});
  if(input.includes('FAIL'))throw Error('模拟执行失败');
  disconnect=input.includes('DISCONNECT');
  emit({type:'replace',text:'模拟任务已完成，页面无需刷新。'});emit({type:'final-answer',text:'模拟任务已完成，页面无需刷新。'});
};
const hub=createHub({port:3216,dataDir:mkdtempSync(join(tmpdir(),'starport-completion-ui-')),registry,implementations:Object.fromEntries(Object.keys(PROVIDERS).map(id=>[id,fake]))});
hub.server.on('request',(request,response)=>{if(request.url==='/api/events'){streams.add(response);response.on('close',()=>streams.delete(response));}});
const group=hub.store.group('完成状态验证');for(const id of Object.keys(PROVIDERS))hub.store.newChat({provider:id,title:PROVIDERS[id].name+' 状态验证',workspace:process.cwd(),group_id:group.id});
console.log('Completion UI fixture http://127.0.0.1:'+await hub.listen()+' (all providers simulated)');

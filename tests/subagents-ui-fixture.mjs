import { createHub } from '../src/server.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravitySubagents } from '../src/subagents.mjs';
const registry={resolve:()=>null,list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:false,statusLabel:'隔离测试环境'})),models:async()=>({models:[]})};
const hub=createHub({port:3212,dataDir:mkdtempSync(join(tmpdir(),'starport-subagents-ui-')),registry});
const chat=hub.store.newChat({title:'子任务状态测试',provider:'antigravity',workspace:process.cwd()}),now=Date.now();
hub.store.message(chat.id,'user','antigravity','查找 Chamon 模型的两个斜向 transport operators，并核对边界激发。');
const message=hub.store.message(chat.id,'assistant','antigravity','已派出子任务检索和核对。','running',{subagents:[
  {id:'running-a',name:'Chamon Transport Operator Researcher',task:'查找两条 45° 斜向 transport operators 的定义，报告上下边界留下的激发。',status:'running',startedAt:now-514000,updatedAt:now-4000,activity:'读取 Chamon model FTH.tex 的 transport 定义'},
  {id:'done-b',name:'Boundary charge check',task:'核对底边界与顶边界的 charge labels。',status:'complete',startedAt:now-500000,updatedAt:now-100000,endedAt:now-100000,activity:'已核对公式与行号'},
  {id:'error-c',name:'失败的检索',task:'Unavailable file',status:'error',startedAt:now-120000,updatedAt:now-90000,endedAt:now-90000},
  {id:'unknown-d',name:'状态未确认',task:'<img src=x onerror="window.__subagentXss=true">',status:'unknown',startedAt:now-120000,updatedAt:now-80000,endedAt:now-80000}
]});
hub.runner.active.set(chat.id,{id:'fixture-run',provider:'antigravity',started:new Date(now-520000).toISOString(),lastEventAt:now,approvals:new Map(),message});
const real=await new AntigravitySubagents().snapshot('ca6bada3-5c5a-44e0-9471-2af4ff11a605',{since:Date.parse('2026-09-28T11:18:17Z')});
if(real.length){const live=hub.store.newChat({title:'Chamon 真实日志预览',provider:'antigravity',workspace:process.cwd()});hub.store.message(live.id,'assistant','antigravity','真实本地日志读取快照。','running',{subagents:real});}
await hub.listen();console.log('Subagents fixture http://127.0.0.1:3212');

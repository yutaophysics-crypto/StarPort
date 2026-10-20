import { createHub } from '../src/server.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const registry={resolve:()=>null,list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:false,statusLabel:'隔离测试环境'})),models:async()=>({models:[]})};
const hub=createHub({port:3212,dataDir:mkdtempSync(join(tmpdir(),'starport-subagents-ui-')),registry});
const chat=hub.store.newChat({title:'子任务状态测试',provider:'antigravity',workspace:process.cwd()}),now=Date.now();
hub.store.message(chat.id,'user','antigravity','查找 CSV 导入的字段格式，并核对必填字段。');
const message=hub.store.message(chat.id,'assistant','antigravity','已派出子任务检索和核对。','running',{subagents:[
  {id:'running-a',name:'Import Format Researcher',task:'查找 CSV 文件的列定义，报告必填和可选字段。',status:'running',startedAt:now-514000,updatedAt:now-4000,activity:'读取 sample-import.md 的列定义'},
  {id:'done-b',name:'Required field check',task:'核对导入和导出的字段名称。',status:'complete',startedAt:now-500000,updatedAt:now-100000,endedAt:now-100000,activity:'已核对公式与行号'},
  {id:'error-c',name:'失败的检索',task:'Unavailable file',status:'error',startedAt:now-120000,updatedAt:now-90000,endedAt:now-90000},
  {id:'unknown-d',name:'状态未确认',task:'<img src=x onerror="window.__subagentXss=true">',status:'unknown',startedAt:now-120000,updatedAt:now-80000,endedAt:now-80000}
]});
hub.runner.active.set(chat.id,{id:'fixture-run',provider:'antigravity',started:new Date(now-520000).toISOString(),lastEventAt:now,approvals:new Map(),message});
await hub.listen();console.log('Subagents fixture http://127.0.0.1:3212');

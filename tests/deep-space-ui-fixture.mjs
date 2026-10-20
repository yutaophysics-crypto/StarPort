// Visual fixture only: its temporary database and fake adapters are independent of Starport.
import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true,nativePlan:true,nativeGoal:true,nativeAutoReview:true}),record:()=>{},
  models:async()=>({source:'native',models:[]}),list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,statusLabel:'隔离测试环境',nativePlan:true,nativeAutoReview:true}))};
const hub=createHub({port:3217,dataDir:mkdtempSync(join(tmpdir(),'starport-deep-space-')),registry,implementations:Object.fromEntries(Object.keys(PROVIDERS).map(id=>[id,async()=>{}]))});
const design=hub.store.group('星港设计'),research=hub.store.group('研究与探索'),daily=hub.store.group('日常');
const chat=hub.store.newChat({title:'深空航站 · 界面设计',provider:'claude',workspace:process.cwd(),group_id:design.id,options:{claude:{permissionMode:'auto'}}});
hub.store.newChat({title:'对话分组与工作目录',provider:'codex',workspace:process.cwd(),group_id:design.id});
hub.store.newChat({title:'量子信息读书笔记',provider:'codex',workspace:process.cwd(),group_id:research.id});
hub.store.newChat({title:'模型与工具的连接',provider:'antigravity',workspace:process.cwd(),group_id:research.id});
hub.store.newChat({title:'本周安排',provider:'deepseek',workspace:process.cwd(),group_id:daily.id});
hub.store.message(chat.id,'user','claude','设计一套星际飞船航站主题，名字叫「深空」。','complete');
const reply=[
  '## 深空航站','','从观景舷窗望向停泊中的星际飞船。银灰色面板和暖色灯光贯穿整个工作台。',
  '', '对话区保持清楚的层级，背景在阅读时自动压暗。',
  '', '### 设计细节', '', '- 会话、工具和工作目录沿用熟悉的位置。','- 主题切换会记住你的选择。','- 中英文和小窗口都可以正常使用。',
  '', '行内公式 $E=mc^2$ 和独立公式也保持清晰：','','$$','S(\\rho)=-\\mathrm{Tr}(\\rho\\log\\rho)','$$',
  '', '```js',"StarportTheme.set('deep-space');",'```'
].join('\n');
hub.store.message(chat.id,'assistant','claude',reply,'complete',{activity:[
  {id:'think',kind:'thinking',nativeType:'thinking',text:'检查界面层级、主题切换和长篇内容的阅读效果。',status:'complete'},
  {id:'read',kind:'tool',name:'Read',nativeType:'tool_use',input:{file_path:'public/deep-space.css'},output:'Theme styles loaded.\nDesktop and narrow layouts available.',status:'complete'},
  {id:'reply',kind:'text',text:reply,status:'complete'}]});
await hub.listen();console.log(JSON.stringify({url:'http://127.0.0.1:3217/',chatId:chat.id}));
process.on('SIGINT',()=>hub.close().then(()=>process.exit(0)));

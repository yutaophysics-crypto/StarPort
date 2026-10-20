import {createHub} from '../src/server.mjs';
import {PROVIDERS} from '../src/providers.mjs';
import {effortChoices} from '../src/effort.mjs';
import {claudeModelCatalog} from '../src/claude-models.mjs';
import {codexUsage,claudeUsage,USAGE_SOURCES} from '../src/usage.mjs';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixtureHistoryConnect} from './fixtures/history.mjs';
import {fixtureClaudeHistory} from './fixtures/claude-history.mjs';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({nativeGoal:true,nativePlan:true,nativeAutoReview:true}),record:()=>{},
  usage:async id=>({provider:id,source:USAGE_SOURCES[id],queriedAt:new Date().toISOString(),...({
    codex:codexUsage({rateLimits:{},rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:24,windowDurationMins:300,resetsAt:1790406000},secondary:{usedPercent:null,windowDurationMins:10080,resetsAt:null},credits:{unlimited:false,balance:'12.50',hasCredits:true}}},rateLimitResetCredits:{availableCount:0},futureMetric:'<img src=x onerror="window.__usageXss=true">'}),
    claude:claudeUsage({subscription_type:'pro',rate_limits_available:true,rate_limits:{limits:[{kind:'session',percent:0,resets_at:'2026-09-26T00:00:00Z'},{kind:'weekly_all',percent:43,resets_at:'2026-10-01T00:00:00Z'}],spend:{used:{amount_minor:125,currency:'USD',exponent:2},enabled:false}},behaviors:{day:{sample:'Local activity'}}}),
    deepseek:{status:'ok',native:{is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.01',granted_balance:'0.00',topped_up_balance:'12.01'}]}},
    antigravity:{status:'ok',reports:[{label:'模型配额',text:'Model quota: 81%\n<img src=x onerror="window.__usageXss=true">'},{label:'AI Credits',text:'Monthly credits: 125'}]}
  })[id]}),
  models:async id=>id==='claude'?claudeModelCatalog([
    {value:'opus',resolvedModel:'claude-opus-5-5',supportedEffortLevels:['low','medium','high','xhigh','max']},
    {value:'older',resolvedModel:'claude-opus-4-6',supportedEffortLevels:['low','medium','high','max']},
    {value:'haiku',resolvedModel:'claude-haiku-4-5',supportsEffort:false}]):
    {source:'native',models:[{id:id+'-test-model',label:'Test model',effort:effortChoices(id==='deepseek'?['off','low','high','max']:['low','high'],{defaultLevel:'high'}),...id==='deepseek'?{provider:'test-service'}:{}}],...id==='antigravity'?{effort:effortChoices(['low','medium','high'],{source:'cli'})}:{}},
  list:async()=>Object.values(PROVIDERS).map(p=>({...p,installed:true,nativePlan:p.id!=='deepseek',nativeGoal:p.id==='codex',nativeAutoReview:p.id==='codex',statusLabel:'隔离测试环境'}))};
const fake=async({provider,prompt,emit,signal,setControl})=>{
  let stop;const interrupted=new Promise(resolve=>stop=resolve);setControl({stop});
  emit({type:'session',id:provider+'-test'});emit({type:'delta',text:'开始处理。'});
  if(['codex','claude'].includes(provider))emit({type:'context',context:{status:'ready',usedTokens:provider==='codex'?23456:102400,windowTokens:200000,percent:provider==='codex'?11.728:51.2,model:provider+'-test',basis:provider==='codex'?'codex-last':'claude-input',updatedAt:new Date().toISOString()}});
  if(prompt.includes('SLOW')){await interrupted;throw Object.assign(new Error('已停止'),{canceled:true});}
  await new Promise(resolve=>setTimeout(resolve,200));
  emit({type:'replace',text:'已保留上下文。\n\n行内公式 $x^2+y^2=1$。\n\n$$\nE=mc^2\n$$\n\n```js\nconst ready = true;\n```\n\n<img src=x onerror="window.__xss=true"><script>window.__xss=true</script>\n\n| 工具 | 状态 |\n|---|---|\n| '+provider+' | 正常 |'});
};
const hub=createHub({port:3211,dataDir:mkdtempSync(join(tmpdir(),'hub-ui-')),registry,historyConnect:fixtureHistoryConnect(),claudeHistory:fixtureClaudeHistory(),implementations:Object.fromEntries(Object.keys(PROVIDERS).map(p=>[p,fake]))});
await hub.listen();console.log('Isolated UI fixture http://127.0.0.1:3211');

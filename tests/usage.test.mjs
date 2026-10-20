import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {usageWindow,codexUsage,claudeUsage,readClaudeUsage,UsageReader,nativeUsageText} from '../src/usage.mjs';
import {claudeControl} from '../src/claude-control.mjs';
import {deepseekBalance} from '../src/deepseek-usage.mjs';
import {startProcess} from '../src/process.mjs';
import {createHub} from '../src/server.mjs';

test('usage keeps zero distinct from unknown, preserves timestamps and handles over-limit percentages',()=>{
  assert.equal(usageWindow('a',0,0).remainingPercent,100);
  assert.equal(usageWindow('a',null,null).remainingPercent,null);
  assert.equal(usageWindow('a',undefined,null).usedPercent,null);
  assert.equal(usageWindow('a',120,0).remainingPercent,0);
  assert.equal(usageWindow('a',120,0).usedPercent,120);
  assert.equal(usageWindow('a',0,0).resetAt,0);
});
test('Codex preserves multiple buckets, credits, reset credits and future fields without duplicating legacy bucket',()=>{
  const native={accountId:'private',rateLimits:{primary:{usedPercent:50}},rateLimitsByLimitId:{core:{limitName:'Core',primary:{usedPercent:20,windowDurationMins:300,resetsAt:123},secondary:{usedPercent:0,resetsAt:null},credits:{hasCredits:true,unlimited:false,balance:'0.0'}},research:{limitName:'Research',primary:{usedPercent:99},future:{capacity:42}}},rateLimitResetCredits:{availableCount:0},ordinaryUsageAllowed:false};
  const result=codexUsage(native);assert.equal(result.windows.length,3);assert.equal(result.windows[0].remainingPercent,80);assert.equal(result.windows[0].durationMinutes,300);
  assert.equal(result.native.rateLimitsByLimitId.research.future.capacity,42);assert.equal(result.native.rateLimitResetCredits.availableCount,0);assert.equal(result.native.ordinaryUsageAllowed,false);assert.ok(!('accountId'in result.native));
  assert.equal(codexUsage({rateLimits:{primary:{usedPercent:5}},rateLimitsByLimitId:{}}).windows[0].remainingPercent,95);
});
test('Claude uses native visible rows, preserves extra spend and attribution, and excludes empty query-session cost',()=>{
  const report={session:{total_cost_usd:0},subscription_type:'pro',rate_limits_available:true,rate_limits:{five_hour:{utilization:20},limits:[{kind:'session',percent:20,resets_at:'2026-09-26T00:00:00Z'},{kind:'model',display_name:'Fable',percent:null}],spend:{used:{amount_minor:25,currency:'USD',exponent:2}}},behaviors:{day:{}}};
  const result=claudeUsage(report);assert.equal(result.windows.length,2);assert.equal(result.windows[0].remainingPercent,80);assert.equal(result.windows[1].remainingPercent,null);assert.ok(!('session'in result.native));assert.deepEqual(result.native.behaviors,report.behaviors);assert.deepEqual(result.native.rate_limits.spend,report.rate_limits.spend);
  assert.equal(claudeUsage({rate_limits_available:false,rate_limits:null}).status,'unavailable');
  const failed=claudeUsage({rate_limits_available:true,rate_limits:null});assert.equal(failed.status,'error');assert.match(failed.reason,/网络\/代理/);
  assert.throws(()=>claudeUsage({}),/无法识别/);
});
test('older Claude rate-limit shapes retain model windows and unavailable values',()=>{
  const result=claudeUsage({rate_limits_available:true,rate_limits:{five_hour:{utilization:0,resets_at:null},model_scoped:[{display_name:'Future model',utilization:17,resets_at:null}],extra_usage:{utilization:0}}});
  assert.equal(result.windows.length,2);assert.equal(result.windows[1].label,'Future model');assert.equal(result.windows[0].remainingPercent,100);
});
test('native Claude control never yields a prompt, enables tools or persists and closes on failure',async()=>{
  for(const fails of [false,true]){let input,closed=false;const query=request=>{input=request;return{close:()=>{closed=true;}}};
    const call=claudeControl({command:'fake',prefixArgs:[]},process.cwd(),async()=>{if(fails)throw new Error('offline');return{rate_limits:null};},query,50);
    if(fails)await assert.rejects(()=>call,/offline/);else await call;
    assert.equal(closed,true);assert.deepEqual(await input.prompt.next(),{done:true,value:undefined});assert.deepEqual(input.options.tools,[]);assert.equal(input.options.settings.disableAllHooks,true);assert.equal(input.options.persistSession,false);assert.equal(input.options.resume,undefined);
  }
});

test('Claude metadata query preserves owner proxy and workspace settings without modifying the file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'starport-usage-settings-')),file=join(directory,'settings.json');
  for(const hooksDisabled of [true,false])for(const fails of [false,true]){
    const original={env:{HTTPS_PROXY:'http://127.0.0.1:3217',NATIVE_SECRET:'private-settings-fixture'},permissions:{blockReadsOutsideWorkingDirectories:true},disableAllHooks:hooksDisabled};await writeFile(file,JSON.stringify(original));let seen,copy;
    const query=request=>{seen=request;copy=request.options.settings;return {close(){}};};
    const read=async()=>{const actual=JSON.parse(await readFile(copy,'utf8'));assert.deepEqual(actual.env,original.env);assert.deepEqual(actual.permissions,original.permissions);assert.equal(actual.disableAllHooks,true);assert.equal(typeof copy,'string');if(fails)throw Error('fixture offline');return {};};
    const run=claudeControl({command:'fake',prefixArgs:['--restricted','--settings',file]},directory,read,query);
    if(fails)await assert.rejects(()=>run,/fixture offline/);else await run;
    assert.deepEqual(seen.options.tools,[]);assert.equal(seen.options.persistSession,false);assert.deepEqual(await seen.prompt.next(),{done:true,value:undefined});assert.deepEqual(JSON.parse(await readFile(file,'utf8')),original);
    if(hooksDisabled)assert.equal(copy,file);else{assert.notEqual(copy,file);await assert.rejects(()=>access(copy),error=>error.code==='ENOENT');}
  }
});

test('Claude quota retries an eligible empty report once while preserving native attribution',async()=>{
  for(const mode of ['recover','fail','not-applicable']){let calls=0,waits=0;const control=async(runtime,cwd,read)=>{calls++;return read({usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async options=>{assert.deepEqual(options,{skipBehaviors:false});return {rate_limits_available:mode!=='not-applicable',rate_limits:mode==='recover'&&calls===2?{five_hour:{utilization:20}}:null};}});};
    const result=await readClaudeUsage({},process.cwd(),control,async()=>waits++);assert.equal(calls,mode==='not-applicable'?1:2);assert.equal(waits,mode==='not-applicable'?0:1);assert.equal(result.status,mode==='recover'?'ok':mode==='fail'?'error':'unavailable');if(mode==='recover')assert.equal(result.windows[0].remainingPercent,80);
  }
});

test('native Claude usage child sees preserved proxy settings and restricted/no-tools/no-prompt arguments',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'starport-usage-native-')),file=join(directory,'settings.json');await writeFile(file,JSON.stringify({env:{HTTPS_PROXY:'http://127.0.0.1:3217'},permissions:{blockReadsOutsideWorkingDirectories:true},disableAllHooks:true}));
  const result=await readClaudeUsage({command:process.execPath,prefixArgs:[resolve('tests/fixtures/claude-usage-control.mjs'),'--restricted','--settings',file]},directory);assert.equal(result.status,'ok');assert.equal(result.windows[0].remainingPercent,85);
});
test('usage reader coalesces only in-flight requests and never returns a previous account snapshot on failure',async()=>{
  let calls=0,fail=false;const reader=new UsageReader('',async()=>{calls++;await new Promise(r=>setTimeout(r,10));if(fail)throw new Error('offline');return{status:'ok',windows:[]};});
  const [a,b]=await Promise.all([reader.get('codex',{},'one'),reader.get('codex',{},'one')]);assert.deepEqual(a,b);assert.equal(calls,1);
  fail=true;const failed=await reader.get('codex',{},'one');assert.equal(failed.status,'error');assert.equal(failed.windows,undefined);assert.equal(calls,2);
  await reader.get('claude',{},'one');assert.equal(calls,3);assert.equal(reader.pending.size,0);
});
test('Antigravity report allows only built-in usage commands, strips ANSI, stops on login and timeout',async()=>{
  const runtime={command:process.execPath,prefixArgs:[resolve('tests/fixtures/usage-cli.mjs')]};
  for(const mode of ['success','silent','login','timeout']){
    let child,closed=false;const spawn=(command,args,options)=>{assert.deepEqual(args.slice(-4),['--print','/usage','--output-format','text']);assert.equal(options.env,undefined,'usage must inherit the same authentication environment as native chat');child=startProcess(command,args,{...options,env:{...options.env,STARPORT_USAGE_FIXTURE_MODE:mode}});child.once('close',()=>closed=true);return child;};
    const call=nativeUsageText(runtime,process.cwd(),'/usage',spawn,mode==='timeout'?150:3000);
    if(mode==='success'||mode==='silent')assert.ok((await call).startsWith('Model quota: 81%'));
    else await assert.rejects(()=>call,mode==='login'?/登录/:/超时/);
    if(!closed)await new Promise(r=>child.once('close',r));
    assert.equal(closed,true);
  }
  await assert.rejects(()=>nativeUsageText(runtime,process.cwd(),'hello'),/无效/);
});
test('usage API is authenticated, workspace validated and read-only for chat data',async t=>{
  const root=await mkdtemp(join(tmpdir(),'starport-usage-http-'));let received;
  const hub=createHub({port:0,dataDir:root,registry:{usage:async(...args)=>{received=args;return{status:'ok',windows:[]};}}});await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+hub.server.address().port,headers={'X-Hub-Token':hub.token};
  assert.equal((await fetch(base+'/api/providers/codex/usage')).status,401);
  assert.equal((await fetch(base+'/api/providers/codex/usage',{headers:{...headers,Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(base+'/api/providers/codex/usage?workspace=relative',{headers})).status,400);
  const {exported,...before}=hub.store.export();const url=base+'/api/providers/deepseek/usage?'+new URLSearchParams({workspace:root,service:'gateway'});
  assert.equal((await fetch(url,{headers})).status,200);assert.deepEqual(received,['deepseek',root,{provider:'gateway'}]);const {exported:afterTime,...after}=hub.store.export();assert.deepEqual(after,before);
});
test('DeepSeek usage preserves credential precedence and official-host boundaries with isolated native helpers',async t=>{
  const root=process.cwd(),home=await mkdtemp(join(tmpdir(),'starport-usage-dsh-')),cwd=join(home,'project');await mkdir(cwd);
  const previousHome=process.env.DSH_HOME,previousKey=process.env.STARPORT_USAGE_TEST_KEY;
  process.env.DSH_HOME=home;process.env.STARPORT_USAGE_TEST_KEY='process-test-secret';t.after(()=>{if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;if(previousKey===undefined)delete process.env.STARPORT_USAGE_TEST_KEY;else process.env.STARPORT_USAGE_TEST_KEY=previousKey;});
  const runtime={command:process.execPath,prefixArgs:[join(home,'native-cli/bin.js')]};
  // JSON is valid YAML. These modules model the native helper contracts without
  // requiring an installed DeepSeek runtime or reading actual account settings.
  const modules={
    'js-yaml':{load:text=>text.trim()?JSON.parse(text):null},
    '@deepseek-ai/dsh-launch-environment':{createLaunchEnvironmentSnapshot:sources=>({getFrom:(key,order)=>{for(const source of order){const value=sources.find(row=>row.source===source)?.values[key];if(value!==undefined)return {value};}}})},
    '@deepseek-ai/dsh-llm-deepseek':{resolveAdapterOptions:settings=>settings},
    '@deepseek-ai/dsh-credentials-local':{
      resolveSpec:settings=>({filename:join(settings.dshHome,'.credentials.yaml')}),
      renderFlatLayoutMigration:()=>null,
      parseCredentialsDocument:raw=>({refs:new Map(Object.entries(JSON.parse(raw).refs))})
    }
  };
  const loadNative=async name=>{assert(Object.hasOwn(modules,name),name);return modules[name];};
  const config=join(home,'settings.yaml'),credential=join(home,'.credentials.yaml');
  const setup=base=>writeFile(config,JSON.stringify({'llm-deepseek':{baseURL:base,apiKeyEnv:'STARPORT_USAGE_TEST_KEY'}}));
  await setup('https://api.deepseek.com');await writeFile(credential,JSON.stringify({version:1,refs:{STARPORT_USAGE_TEST_KEY:'stored-test-secret'}}));await writeFile(join(cwd,'.env'),'STARPORT_USAGE_TEST_KEY=project-test-secret\n');
  const original=await readFile(credential,'utf8');let calls=0,lastKey;
  const request=async(url,options)=>{calls++;lastKey=options.headers.Authorization;assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(options.redirect,'error');return{ok:true,json:async()=>({is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.01',granted_balance:'0',topped_up_balance:'12.01'}]})};};
  assert.equal((await deepseekBalance(runtime,cwd,root,{},request,loadNative)).native.balance_infos[0].total_balance,'12.01');assert.equal(lastKey,'Bearer process-test-secret');
  delete process.env.STARPORT_USAGE_TEST_KEY;await deepseekBalance(runtime,cwd,root,{},request,loadNative);assert.equal(lastKey,'Bearer stored-test-secret');
  await setup('https://gateway.example');assert.equal((await deepseekBalance(runtime,cwd,root,{},request,loadNative)).status,'unsupported');assert.equal(calls,2);
  assert.equal((await deepseekBalance(runtime,cwd,root,{provider:'third-party'},request,loadNative)).status,'unsupported');assert.equal(calls,2);assert.equal(await readFile(credential,'utf8'),original);
});

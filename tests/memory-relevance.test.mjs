import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Store} from '../src/storage.mjs';
import {Runner} from '../src/runner.mjs';
import {contextToolHost,contextCommandBridge} from '../src/context-tools.mjs';
import {memoryQuery} from '../src/memory-relevance.mjs';
const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true}),models:async()=>({models:[]}),record:()=>{},list:async()=>[]};
const add=(s,kind,title,content,extra={})=>s.memory.create({kind,title,content,...extra},{confirmed:true});
async function finish(runner,id){for(let i=0;i<200;i++){if(!runner.active.has(id))return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('runner timed out');}

test('no profile or keyword match injects memory bodies automatically; models receive index pointers only',()=>{
  const s=new Store(':memory:');try{
    const row=add(s,'preference','园艺设备','园艺设备选择兼顾节水与AI自动控制，关注维修成本。');
    add(s,'fact','Sample profile','The sample user restores antique bicycles.');
    add(s,'preference','展示偏好','示例用户希望图表采用高对比度配色。');
    const recall=s.memory.recall('开发一个AI游戏');
    assert.deepEqual(recall.items,[]);assert.doesNotMatch(recall.text,/关注维修成本|restores antique bicycles|高对比度配色/);
    const found=s.memory.search({query:'AI'});assert.ok(found.items.some(item=>item.id===row.id)); // A candidate, not a selected instruction.
    assert.equal(s.memory.list().total,3);
  }finally{s.close();}
});

test('open vocabulary retrieves subjects never listed in code and supports multilingual tokenization',()=>{
  const s=new Store(':memory:');try{
    for(const [title,content,query] of [
      ['盆景养护','盆景浇水需要先检查基质湿度。','盆景基质'],
      ['陶艺记录','陶艺釉料在窑炉中需要记录温度曲线。','陶艺釉料'],
      ['birdwatching','Preferred binocular magnification for birdwatching is eight times.','birdwatching binocular'],
      ['cerámica','La cerámica requiere controlar la temperatura del horno.','cerámica horno'],
      ['天文观测','观测土星环时使用较高倍率的目镜。','土星环目镜'],
    ]){
      const row=add(s,'knowledge',title,content),found=s.memory.search({query});
      assert.ok(found.items.some(item=>item.id===row.id),query);assert.equal(s.memory.read([row.id]).items[0].content,content);
    }
    assert.equal(s.memory.search({query:'不存在的字符串xyz'}).total,0);
    assert.equal(s.memory.search({query:'" OR 1=1 --'}).total,0);
  }finally{s.close();}
});

test('empty search supports bounded browsing and kind filters; index cache updates on edits and deletion',()=>{
  const s=new Store(':memory:');try{
    const rows=Array.from({length:7},(_,i)=>add(s,i%2?'fact':'preference','记录 '+i,'新的内容 marker'+i));
    const a=s.memory.search({limit:3}),b=s.memory.search({limit:3,offset:a.nextOffset});
    assert.equal(a.nextOffset,3);assert.equal(b.items.length,3);assert.equal(new Set([...a.items,...b.items].map(r=>r.id)).size,6);assert.ok(a.items.every(r=>!('content' in r)&&!('excerpt' in r)));
    assert.equal(s.memory.search({kind:'preference'}).total,4);
    s.memory.search({query:'marker0'});s.memory.update(rows[0].id,{revision:1,content:'改为 orchardNotes'});
    assert.equal(s.memory.search({query:'marker0'}).total,0);assert.equal(s.memory.search({query:'orchardNotes'}).total,1);
    s.memory.remove(rows[0].id,2);assert.equal(s.memory.search({query:'orchardNotes'}).total,0);
    assert.throws(()=>s.memory.search({limit:31}));assert.throws(()=>s.memory.search({kind:'a-new-topic'}));
  }finally{s.close();}
});

test('search/read enforce confirmation, project membership, conflict exclusions and disabled memory',()=>{
  const s=new Store(':memory:');try{
    const a=s.addProject('A','C:/A'),b=s.addProject('B','C:/B'),global=add(s,'fact','orchard','orchard global');
    const own=add(s,'knowledge','orchard project','orchard owned',{project_id:a.id}),foreign=add(s,'knowledge','orchard foreign','orchard foreign',{project_id:b.id});
    const pending=s.memory.create({kind:'fact',title:'orchard pending',content:'orchard candidate'});
    assert.deepEqual(new Set(s.memory.search({query:'orchard',projectId:a.id}).items.map(r=>r.id)),new Set([global.id,own.id]));
    for(const id of [foreign.id,pending.id])assert.throws(()=>s.memory.read([global.id,id],{projectId:a.id}),e=>e.status===404);
    s.memorySync={blockedMemoryIds:()=>new Set([global.id])};assert.equal(s.memory.search().total,0);assert.throws(()=>s.memory.read([global.id]),e=>e.status===404);
    s.memory.configure({enabled:false});assert.equal(s.memory.recall('orchard').text,'');assert.throws(()=>s.memory.search(),e=>e.status===403);assert.throws(()=>s.memory.read([own.id],{projectId:a.id}),e=>e.status===403);
  }finally{s.close();}
});

test('retrieval guide follow-ups use delivered user context, never assistant output or queued messages',()=>{
  const history=[{role:'user',status:'complete',content:'我想制作陶艺，需要了解釉料。'},
    {role:'assistant',status:'complete',content:'用户喜欢某只股票'},
    {role:'user',status:'pending',content:'讨论旅行'},
    {role:'user',status:'complete',content:'讨论游戏',details:{guidance:{state:'queued'}}}];
  assert.match(memoryQuery('继续',history),/陶艺/);assert.doesNotMatch(memoryQuery('继续',history),/股票|旅行|游戏/);
  assert.equal(memoryQuery('可以帮我选择一个用户名',history),'可以帮我选择一个用户名');
});

test('reads require a relevance reason; preview and body budgets are cumulative and omitted records are not counted',async()=>{
  const s=new Store(':memory:');try{
    const chat=s.newChat({}),rows=Array.from({length:12},(_,i)=>add(s,'knowledge','orchard '+i,'orchard '+i+' '+('x'.repeat(1700)))),read=[],browsed=[];
    const host=contextToolHost({store:s,chat,messages:()=>[],onMemories:items=>read.push(...items),onBrowse:items=>browsed.push(...items)});
    await assert.rejects(host.call('starport_memory_read',{ids:[rows[0].id],reason:'x'}));
    const first=await host.call('starport_memory_read',{ids:rows.slice(0,8).map(r=>r.id),reason:'这些园艺记录与当前种植任务相关。'});
    const second=await host.call('starport_memory_read',{ids:rows.slice(8).map(r=>r.id),reason:'需要继续核对当前种植计划。'});
    assert.ok(first.usedChars+second.usedChars<=9000);assert.ok(first.omitted.length+second.omitted.length>0);assert.equal(read.length,first.items.length+second.items.length);
    let exhausted=false;for(let i=0;i<12;i++){const result=await host.call('starport_memory_search',{query:'orchard',limit:30});if(result.previewBudgetExhausted){exhausted=true;break;}}
    assert.ok(exhausted);assert.ok(browsed.length>0);
    s.memory.remove(rows[0].id,1);await assert.rejects(host.call('starport_memory_read',{ids:[rows[0].id],reason:'检查已删除条目。'}));
  }finally{s.close();}
});

test('command helper transports JSON ID arrays and reads through the authenticated ephemeral bridge',async()=>{
  const s=new Store(':memory:'),chat=s.newChat({}),row=add(s,'knowledge','陶艺釉料','窑炉记录保存在当前项目中。'),bridge=await contextCommandBridge(contextToolHost({store:s,chat,messages:()=>[]}));
  try{
    const result=await new Promise((resolve,reject)=>{let out='',err='';const child=spawn(process.execPath,['scripts/context-tool.mjs','starport_memory_read','--ids',JSON.stringify([row.id]),'--reason','需要核对陶艺釉料的历史记录。'],{cwd:process.cwd(),env:{...process.env,...bridge.env},windowsHide:true});child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out)));});
    assert.equal(result.items[0].id,row.id);
  }finally{await bridge.close();s.close();}
});

for(const provider of ['codex','claude','antigravity','deepseek'])test(provider+' supports model-selected reads during a task, records reasons and avoids resuming the old policy',async()=>{
  const s=new Store(':memory:'),calls=[],runner=new Runner(s,registry,()=>{},{[provider]:async args=>{
    calls.push(args);const search=await args.contextTools.call('starport_memory_search',{query:'釉料'});
    await args.contextTools.call('starport_memory_read',{ids:[search.items[0].id],reason:'当前在做陶艺，需要釉料的已确认背景。'});
    const more=await args.contextTools.call('starport_memory_search',{query:'窑炉'});
    await args.contextTools.call('starport_memory_read',{ids:[more.items[0].id],reason:'工作进行中需要补查窑炉的温度记录。'});
    args.emit({type:'session',id:'new-native'});args.emit({type:'replace',text:'已核对陶艺记录。'});
  }});
  try{
    const a=add(s,'knowledge','釉料','陶艺釉料使用方法 marker-glaze'),b=add(s,'knowledge','窑炉','窑炉温度曲线 marker-kiln');
    const irrelevant=add(s,'preference','投资偏好','与当前陶艺工作无关的投资偏好。');
    const chat=s.newChat({provider,workspace:process.cwd()}),old=s.message(chat.id,'assistant',provider,'上次的工作完成。');
    const legacy=createHash('sha256').update(JSON.stringify({runtime:registry.resolve(provider),workspace:chat.workspace,worktree:false,memoryPolicy:'relevance-v2',memoryEpoch:s.memory.epoch,projectId:null,instructionFingerprint:s.instructions.fingerprint()})).digest('hex');
    s.saveSession(chat.id,provider,'old-unfiltered-native',old.id,legacy);
    await runner.start(chat.id,'帮我制定陶艺制作步骤');await finish(runner,chat.id);
    assert.equal(calls[0].session,undefined);assert.doesNotMatch(calls[0].prompt,/marker-glaze|marker-kiln|无关的投资偏好/);
    const receipt=s.lastAssistant(chat.id).details.memory;
    assert.deepEqual(new Set(receipt.ids),new Set([a.id,b.id]));assert.equal(receipt.reads.length,2);assert.ok(receipt.reads.every(r=>r.reason));assert.equal(receipt.browsed.length,3);assert.ok(receipt.browsed.some(r=>r.id===irrelevant.id));assert.ok(!receipt.ids.includes(irrelevant.id));
    await runner.start(chat.id,'继续');await finish(runner,chat.id);assert.equal(calls[1].session,provider==='deepseek'?undefined:'new-native');assert.equal(s.memory.list().total,3);
  }finally{await runner.close();s.close();}
});

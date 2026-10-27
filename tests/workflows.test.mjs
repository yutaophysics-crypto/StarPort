import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildContext } from '../src/storage.mjs';
import { createHub } from '../src/server.mjs';
import { parseMentions, nextSlot, verdict, splitLedger, heuristicPlan, triggerData } from '../src/workflows.mjs';

const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({loggedIn:true,nativeAutoReview:true}),models:async()=>({models:[]}),record(){},list:async()=>[]};
const until=async(check,label,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,15));}throw new Error('timed out: '+label);};
const hasGit=(()=>{try{execFileSync('git',['--version'],{stdio:'ignore'});return true;}catch{return false;}})();

test('mentions match exact names longest-first and keep the Chinese text after them',()=>{
  const people=[{id:'a',name:'伙伴1'},{id:'b',name:'伙伴2'},{id:'s',name:'探子'},{id:'s2',name:'探子二号'}];
  const hits=parseMentions('@伙伴1，你去做事情1。@伙伴2，你做一下事情2',people);
  assert.deepEqual(hits.map(h=>[h.companion.id,h.segment]),[['a','你去做事情1。'],['b','你做一下事情2']]);
  assert.deepEqual(parseMentions('请@探子二号看一下，@探子 也看',people).map(h=>h.companion.id),['s2','s']);
  assert.deepEqual(parseMentions('邮件 a@b.com 不是点名',people),[]);
  const plan=heuristicPlan('x',parseMentions('@伙伴1 写代码 @伙伴2 在伙伴1做完后验收',people));
  assert.deepEqual(plan.rows.map(r=>[r.companionId,r.order,r.verify]),[['a',1,false],['b',2,true]]);
  assert.deepEqual(heuristicPlan('x',parseMentions('@伙伴1 查A @伙伴2 查B',people)).rows.map(r=>r.order),[1,1]);
});
test('triggers compute the next local slot; verdicts and ledger blocks parse strictly',()=>{
  const monday=new Date(2026,9,12,8,0).getTime();
  assert.equal(new Date(nextSlot(triggerData({type:'daily',time:'09:30',days:[1]}),monday)).getHours(),9);
  assert.equal(new Date(nextSlot(triggerData({type:'daily',time:'07:00',days:[1]}),monday)).getDate(),19);
  assert.equal(nextSlot(triggerData({type:'interval',every:2,unit:'hours'}),monday),monday+7200000);
  assert.throws(()=>triggerData({type:'interval',every:1,unit:'minutes'}));
  assert.equal(verdict('我负责：验收\n…\n验收：不通过——缺测试'),'fail');assert.equal(verdict('验收：通过'),'pass');assert.equal(verdict('没写结论'),null);
  const split=splitLedger('正文\n```starport-ledger\n{"claims_add":[{"text":"x"}]}\n```');
  assert.equal(split.text,'正文');assert.equal(split.ops.claims_add[0].text,'x');
  assert.equal(splitLedger('a\n```starport-ledger\n{oops\n```').error.length>0,true);
});
test('run cards and prior @-requests remain available in ordinary conversation context',()=>{
  const rows=[{id:'1',role:'user',content:'你好',status:'complete',details:{}},{id:'2',role:'assistant',content:'回答',status:'complete',details:{}},
    {id:'3',role:'user',content:'@探子 查一下',status:'complete',details:{dispatch:{companions:['s']}}},{id:'4',role:'assistant',content:'卡片秘密',status:'complete',details:{workflowRun:{}}},
    {id:'5',role:'user',content:'继续',status:'complete',details:{runRef:{messageId:'4'},runContext:'附带的运行结果'}}];
  const text=buildContext(rows).text;
  assert.equal(text.includes('卡片秘密'),true);assert.equal(text.includes('@探子'),true);assert.equal(text.includes('附带的运行结果'),true);
});

test('workflows: @dispatch with planner fallback, verification, run cards, reply-to-run, ledger, approvals, scheduler and roster rules',{timeout:60000},async t=>{
  const prompts=[],answers=[];
  let plannerFails=true;
  const reply=(emit,text)=>{emit({type:'replace',text});emit({type:'final-answer',text});};
  const implementations={
    codex:async({prompt,emit})=>{
      prompts.push({provider:'codex',prompt});
      if(prompt.includes('你是星港的排程员')){if(plannerFails)throw new Error('codex unreachable');reply(emit,'```json\n{"steps":[{"order":1,"companion":"cx","task":"写代码","verify":false},{"order":2,"companion":"cl","task":"验收","verify":true}]}\n```');return;}
      if(prompt.includes('工作流「研究」')){
        reply(emit,'我负责：推导\n结论 A\n```starport-ledger\n{"claims_add":[{"text":"命题一","prediction":{"probability":0.8,"deadline":"2026-10-01","criterion":"看数据"}}],"claims_status":[{"id":"C1","status":"verified"}],"log":{"done":["推导完成"],"failed":[{"tried":"方法甲","why":"发散"}]},"verifiers_add":[{"name":"量纲检查","how":"检查每一项量纲"}],"bogus":1}\n```');return;
      }
      reply(emit,'我负责：写代码\n代码结果 XYZ');
    },
    claude:async({prompt,emit,setControl})=>{
      prompts.push({provider:'claude',prompt});
      if(prompt.includes('工作流「研究」')){
        // An unattended desk must not hang on a permission request.
        let resolve;const answered=new Promise(r=>{resolve=r;});
        setControl({answer:async(id,answer)=>{answers.push(answer);resolve();}});
        emit({type:'approval',request:{id:'perm-1',provider:'claude',kind:'permission',method:'canUseTool',params:{toolName:'Bash',input:{command:'rm -rf build'}}}});
        await answered;
        reply(emit,'我负责：审查\n```starport-ledger\n{"claims_status":[{"id":"C1","status":"verified","note":"复核"}],"plan_proposal":{"summary":"加一条约定","plan":"# PLAN\\n新的\\n"}}\n```\n验收：通过');return;
      }
      reply(emit,prompt.includes('代码结果 XYZ')?'我负责：验收\n看过了\n验收：通过':'我负责：验收\n没看到上游\n验收：不通过');
    },
    deepseek:async({prompt,emit})=>{prompts.push({provider:'deepseek',prompt});if(prompt.includes('你是星港的排程员')){reply(emit,'{"steps":[{"order":1,"companion":"cx","task":"写代码"},{"order":2,"companion":"cl","task":"验收","verify":true}]}');return;}reply(emit,'对话模型的回答');}
  };
  const dataDir=mkdtempSync(join(tmpdir(),'hub-workflows-')),workspace=mkdtempSync(join(tmpdir(),'hub-workflows-ws-'));
  const hub=createHub({port:0,dataDir,registry,implementations});await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+hub.server.address().port;
  const call=async(path,method='GET',data)=>{const res=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Hub-Token':hub.token,Origin:base},body:data===undefined?undefined:JSON.stringify(data)});const json=await res.json();if(!res.ok)throw Object.assign(new Error(json.error),{status:res.status});return json;};
  const {store,workflows}=hub;
  const room=store.group('物理书房'),other=store.group('另一个房间');
  const cx=workflows.createCompanion({name:'码农',avatar:'🛠',role:'实现',persona:'认真',provider:'codex',access:'workspace'},{id:'cx'});
  const cl=workflows.createCompanion({name:'审计',avatar:'⚖',role:'验收',provider:'claude'},{id:'cl'});
  const ds=workflows.createCompanion({name:'推导者',provider:'deepseek'},{id:'ds'});
  await call('/rooms/'+room.id+'/members','POST',{companionId:'cx'});await call('/rooms/'+room.id+'/members','POST',{companionId:'cl'});
  const chat=store.newChat({group_id:room.id,provider:'deepseek',workspace});

  // Ad hoc: two companions → planner chain (first fails, second answers) → sequential with verification.
  await call('/workflows/settings','PUT',{planners:[{provider:'codex',model:'gpt-6-luna',effort:''},{provider:'deepseek',model:'deepseek-flash',effort:''}]});
  const sent=await call('/chats/'+chat.id+'/dispatch','POST',{text:'@码农，把函数写了。@审计 在码农做完后验收'});
  assert.equal(sent.message.details.workflowRun.status,'planning');
  await until(()=>!workflows.runs.size,'adhoc run');
  let card=store.messageById(chat.id,sent.message.id),run=card.details.workflowRun;
  assert.equal(run.status,'passed');assert.equal(run.plan.source,'planner');assert.equal(run.plan.planner.provider,'deepseek');assert.match(run.plan.attempts[0].error,/unreachable/);
  assert.deepEqual(run.steps.map(s=>[s.companionId,s.order,s.status]),[['cx',1,'done'],['cl',2,'done']]);
  const reviewPrompt=prompts.find(p=>p.provider==='claude').prompt;
  assert.match(reviewPrompt,/代码结果 XYZ/);assert.match(reviewPrompt,/@码农，把函数写了。@审计 在码农做完后验收/);assert.match(reviewPrompt,/房间里的伙伴：🛠 码农/);assert.match(reviewPrompt,/我负责：/);
  // Personality only shapes the voice; the verifier is told not to invent objections; out-of-lane findings are allowed.
  const coderPrompt=prompts.find(p=>p.prompt.includes('你是「码农」')).prompt;
  assert.match(coderPrompt,/## 语气\n分析和结论不受性格影响。写给用户的文字可以带上你的语气：认真$/);assert.equal(coderPrompt.includes('性格：'),false);
  assert.match(coderPrompt,/分工外的发现/);assert.match(reviewPrompt,/不要为了挑刺而挑刺/);assert.equal(reviewPrompt.includes('## 语气'),false);
  assert.equal(card.status,'complete');assert.equal(store.chat(chat.id).unread,true);
  assert.equal(store.list().chats.some(c=>c.options?.desk),false,'desk chats are hidden');
  assert.equal(store.export().messages.some(m=>m.chat_id!==chat.id),false,'desk messages are not exported');
  const desks=store.db.prepare("SELECT id FROM chats WHERE json_extract(options,'$.desk.parentChatId')=?").all(chat.id);assert.ok(desks.length>=3);

  // The conversation model sees saved companion output; replying to a card still works.
  const before=prompts.length;
  let turn=await call('/chats/'+chat.id+'/messages','POST',{text:'总结一下'});await until(()=>!hub.runner.active.has(chat.id),'chat turn');
  assert.equal(prompts.slice(before).some(p=>p.prompt.includes('代码结果 XYZ')),true);
  turn=await call('/chats/'+chat.id+'/messages','POST',{text:'针对这次运行继续',runRef:sent.message.id});await until(()=>!hub.runner.active.has(chat.id),'reply turn');
  assert.match(prompts.at(-1).prompt,/代码结果 XYZ/);assert.equal(turn.user.details.runRef.messageId,sent.message.id);
  await assert.rejects(call('/chats/'+chat.id+'/messages','POST',{text:'x',runRef:'nope'}));

  // A single mention needs no planner and reuses the companion's persistent desk.
  plannerFails=true;const single=await call('/chats/'+chat.id+'/dispatch','POST',{text:'@码农 再看一眼'});await until(()=>!workflows.runs.size,'single');
  run=store.messageById(chat.id,single.message.id).details.workflowRun;assert.equal(run.plan.source,'direct');
  assert.equal(run.steps[0].deskChatId,store.messageById(chat.id,sent.message.id).details.workflowRun.steps[0].deskChatId);
  assert.match(prompts.at(-1).prompt,/审计：我负责：验收/,'a companion sees what happened since its last turn');

  // Save the ad-hoc plan as a reusable workflow.
  const saved=await call('/chats/'+chat.id+'/runs/'+sent.message.id+'/save-workflow','POST',{name:'写完再验收'});
  assert.equal(saved.workflow.stages.length,2);assert.equal(Object.values(saved.assignments).sort().join(),'cl,cx');

  // Workflow with ledger: assigning someone outside the room pulls them in; approvals are auto-declined.
  const workflow=await call('/workflows','POST',{name:'研究',description:'推进课题',acceptance:'结论可复核',ledger:true,
    stages:[{name:'推导',positions:[{id:'derive',name:'推导',task:'推导主项'}]},{name:'审查',positions:[{id:'review',name:'审查',task:'审查推导',verify:true}]}]});
  const mount=await call('/chats/'+chat.id+'/mounts','POST',{workflowId:workflow.id,trigger:{type:'manual'},assignments:{derive:'ds',review:'cl'}});
  assert.equal(workflows.members(room.id).includes('ds'),true,'assigned companion auto-joins the room');
  implementations.deepseek=implementations.codex;hub.runner.implementations.deepseek=implementations.codex;
  const started=await call('/mounts/'+mount.id+'/run','POST',{text:'这次重点看边界项'});
  assert.equal(started.user.details.dispatch.mountId,mount.id);
  await assert.rejects(call('/mounts/'+mount.id+'/run','POST',{}),e=>e.status===409);
  await until(()=>!workflows.runs.size,'workflow run',15000);
  run=store.messageById(chat.id,started.message.id).details.workflowRun;
  assert.equal(run.status,'passed',JSON.stringify(run.notes));
  assert.deepEqual(answers,[{decision:'decline'}]);assert.match(run.steps[1].notes.join(),/自动拒绝.*rm -rf build/);
  assert.equal(run.steps[0].output.includes('starport-ledger'),false);
  assert.match(run.steps[0].ledger.rejected.join(),/不支持的操作：bogus/);
  assert.match(run.steps[0].ledger.rejected.join(),/C1 不存在|自己提出/);
  const ledger=await call('/mounts/'+mount.id+'/ledger');
  assert.equal(ledger.claims.claims[0].id,'C1');assert.equal(ledger.claims.claims[0].status,'verified');assert.equal(ledger.claims.claims[0].history[0].by,'cl');
  assert.match(ledger.changelog,/推导完成/);assert.match(ledger.changelog,/方法甲 —— 原因：发散/);assert.equal(ledger.verifiers[0].name,'量纲检查');
  assert.equal(ledger.proposals[0].status,'pending');
  const state=await call('/workflows/state');assert.equal(state.scores.ds.n,1);assert.equal(state.scores.ds.brier,0.04);
  const derivePrompt=prompts.filter(p=>p.prompt.includes('工作流「研究」')).at(0).prompt;assert.match(derivePrompt,/开工顺序/);assert.match(derivePrompt,/PLAN · 研究/);assert.match(derivePrompt,/用户这次的要求\n这次重点看边界项/);
  assert.equal(buildContext(store.messages(chat.id)).text.includes('这次重点看边界项'),true,'the prior workflow request remains part of shared conversation history');
  if(hasGit){
    const log=execFileSync('git',['-c','safe.directory=*','log','--oneline'],{cwd:ledger.path,encoding:'utf8'});assert.equal(log.trim().split('\n').length,2,log);
  }
  const accepted=await call('/mounts/'+mount.id+'/ledger','PATCH',{proposal:{id:ledger.proposals[0].id,action:'accept'}});
  assert.equal(accepted.plan,'# PLAN\n新的\n');assert.equal(accepted.proposals[0].status,'accepted');
  const ruled=await call('/mounts/'+mount.id+'/ledger','PATCH',{claim:{id:'C1',status:'refuted',note:'用户判定'}});
  assert.equal(ruled.claims.claims[0].status,'refuted');assert.equal((await call('/workflows/state')).scores.ds.brier,0.64);

  // Scheduler: missed slots run once (catch-up) or are skipped; overlapping runs never start.
  await call('/mounts/'+mount.id,'PATCH',{enabled:true,trigger:{type:'interval',every:5,unit:'minutes'},missed:'skip'});
  let m=workflows.mount(mount.id);m.nextAt=Date.now()-10*60000;workflows.saveMount(m);workflows.tick();
  assert.equal(workflows.runs.size,0);assert.match(workflows.mount(mount.id).lastNote,/跳过/);
  await call('/mounts/'+mount.id,'PATCH',{missed:'once'});m=workflows.mount(mount.id);m.nextAt=Date.now()-10*60000;workflows.saveMount(m);workflows.tick();
  assert.equal(workflows.runs.size,1);assert.equal([...workflows.runs.values()][0].card.details.workflowRun.trigger,'catchup');
  m=workflows.mount(mount.id);m.nextAt=Date.now()-1000;workflows.saveMount(m);workflows.tick();assert.equal(workflows.runs.size,1);assert.match(workflows.mount(mount.id).lastNote,/仍在进行/);
  await until(()=>!workflows.runs.size,'catch-up run',15000);
  await call('/mounts/'+mount.id,'PATCH',{enabled:false});

  // Roster consistency: removing a holder empties the seat (paused); moving the chat pulls companions along.
  await call('/rooms/'+room.id+'/members/ds/remove','POST',{});
  assert.match((await call('/workflows/state')).mounts.find(x=>x.id===mount.id).blockers.join(),/位置空缺：推导/);
  await assert.rejects(call('/mounts/'+mount.id+'/run','POST',{}),e=>e.status===409);
  await call('/mounts/'+mount.id,'PATCH',{assignments:{derive:'ds'}});assert.equal(workflows.members(room.id).includes('ds'),true);
  await call('/rooms/'+room.id+'/members/cl/remove','POST',{reassign:{[mount.id]:{review:'cx'}}});
  assert.equal(workflows.mount(mount.id).assignments.review,'cx');
  await call('/chats/'+chat.id,'PATCH',{group_id:other.id});
  assert.deepEqual(workflows.members(other.id).sort(),['cx','ds']);
  await call('/chats/'+chat.id,'PATCH',{group_id:null});
  assert.match(workflows.blockers(workflows.mount(mount.id)).join(),/未分组/);

  // Deleting the conversation removes its hidden desks and mounts.
  await call('/chats/'+chat.id,'DELETE');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chats WHERE json_extract(options,'$.desk.parentChatId')=?").get(chat.id).n,0);
  assert.equal(workflows.mount(mount.id),null);
  assert.equal(existsSync(join(workspace,'.starport','ledgers',workflow.id,'PLAN.md')),true,'ledger files stay in their project folder after deleting a chat');
  assert.equal(readFileSync(join(workspace,'.starport','ledgers',workflow.id,'CHANGELOG.md'),'utf8').includes('研究'),true);
});

test('migration imports browser companions, rosters and routines once, with routines switched off',{timeout:20000},async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'hub-migrate-')),workspace=mkdtempSync(join(tmpdir(),'hub-migrate-ws-'));
  const hub=createHub({port:0,dataDir,registry:{...registry,models:async provider=>({models:provider==='codex'?[{id:'gpt-6-luna'}]:[]})},implementations:{}});await hub.listen();t.after(()=>hub.close());
  const room=hub.store.group('交易作战室'),quiet=hub.store.group('客厅');
  const result=await hub.workflows.migrate({workspace,companions:[
    {id:'scout',name:'探子',avatar:'🦅',role:'信息猎手',persona:'抓预期差',provider:'codex',model:'gpt-5.4',effort:'high',duty:'扫描公告'},
    {id:'auditor',name:'毒舌审计',avatar:'⚖️',role:'证伪官',persona:'泼冷水',provider:'codex',model:'gpt-6-luna',duty:'红队证伪'}],
    rooms:{[room.id]:['scout','auditor'],[quiet.id]:['auditor']},
    routines:{[room.id]:{enabled:false,lastRunDate:'2026-10-01',time:'15:15',prompt:'收盘复盘'},[quiet.id]:{enabled:false,time:'21:00',prompt:'晚间总结'}}});
  assert.equal(result.report.companions,2);assert.deepEqual(result.report.cleared,['探子：gpt-5.4']);
  assert.equal(hub.workflows.companion('scout').model,'');assert.equal(hub.workflows.companion('auditor').model,'gpt-6-luna');
  assert.equal(result.report.workflows,2);assert.equal(result.report.mounts,1,'only a routine that was used gets a conversation');
  const wf=hub.workflows.workflows().find(w=>w.name.startsWith('交易作战室'));
  assert.deepEqual(wf.stages[0].positions.map(p=>p.task),['扫描公告','红队证伪']);assert.equal(wf.description,'收盘复盘');
  const mount=hub.workflows.mounts()[0];assert.equal(mount.enabled,false);assert.equal(mount.trigger.time,'15:15');
  assert.equal(hub.store.chat(mount.chatId).group_id,room.id);
  assert.equal((await hub.workflows.migrate({companions:[{id:'x',name:'x'}]})).skipped,true);
});

test('room memory switches: per room and companion, desks get only the granted memory tools and quote only the user',{timeout:30000},async t=>{
  const seen=[];
  const reply=(emit,text)=>{emit({type:'replace',text});emit({type:'final-answer',text});};
  const implementations={codex:async({prompt,emit,contextTools})=>{
    const names=contextTools?.definitions.map(d=>d.name)||[];seen.push({prompt,names});
    const results=[];
    if(names.includes('starport_memory_propose')){
      for(const evidence of ['我以后都想要简洁的结论','上游伙伴写的结论'])
        try{results.push((await contextTools.call('starport_memory_propose',{kind:'preference',title:'简洁结论',content:'用户希望结论简洁',evidence,scope:'global'})).status);}catch(error){results.push('rejected');}
    }
    if(names.includes('starport_memory_search'))results.push((await contextTools.call('starport_memory_search',{query:'回答'})).items.length);
    reply(emit,'我负责：查看\n'+results.join(','));
  }};
  const dataDir=mkdtempSync(join(tmpdir(),'hub-room-memory-')),workspace=mkdtempSync(join(tmpdir(),'hub-room-memory-ws-'));
  const hub=createHub({port:0,dataDir,registry,implementations});await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+hub.server.address().port;
  const call=async(path,method='GET',data)=>{const res=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Hub-Token':hub.token,Origin:base},body:data===undefined?undefined:JSON.stringify(data)});const json=await res.json();if(!res.ok)throw Object.assign(new Error(json.error),{status:res.status});return json;};
  const {store,workflows}=hub;
  store.memory.create({kind:'preference',title:'回答风格',content:'用户喜欢简洁的回答'},{confirmed:true});
  const room=store.group('书房'),other=store.group('客厅');
  workflows.createCompanion({name:'助手',provider:'codex'},{id:'cx'});
  await call('/rooms/'+room.id+'/members','POST',{companionId:'cx'});await call('/rooms/'+other.id+'/members','POST',{companionId:'cx'});
  assert.deepEqual((await call('/workflows/state')).roomMemory[room.id].cx,{read:true,propose:false},'reading is on and proposing off by default');
  const chat=store.newChat({group_id:room.id,provider:'codex',workspace});
  const dispatch=async text=>{const sent=await call('/chats/'+chat.id+'/dispatch','POST',{text});await until(()=>!workflows.runs.size,'run');return store.messageById(chat.id,sent.message.id);};

  // Default: reading only. The recall index is offered, proposals are not.
  let card=await dispatch('@助手 我以后都想要简洁的结论');
  assert.deepEqual(seen.at(-1).names,['starport_memory_search','starport_memory_read']);
  assert.match(seen.at(-1).prompt,/关键词候选索引/);assert.equal(seen.at(-1).prompt.includes('星港候选记忆约定'),false);
  assert.match(card.details.workflowRun.steps[0].output,/1$/);

  // Proposing on in this room only: evidence must be the user's words in the parent conversation.
  assert.deepEqual(await call('/rooms/'+room.id+'/members/cx/memory','PATCH',{propose:true}),{read:true,propose:true});
  assert.deepEqual(workflows.memberMemory(other.id,'cx'),{read:true,propose:false});
  card=await dispatch('@助手 再看一次');
  assert.deepEqual(seen.at(-1).names,['starport_memory_search','starport_memory_read','starport_memory_propose']);
  assert.match(card.details.workflowRun.steps[0].output,/candidate,rejected,1/);
  const candidate=store.memory.list({view:'candidate'}).items[0];
  assert.equal(candidate.source_chat,chat.id,'the candidate points at the real conversation, not the hidden desk');
  assert.deepEqual(card.details.memory.candidates,[candidate.id],'the run card carries the candidate for review');

  // Both off: no memory tools, no recall, no proposal protocol.
  await call('/rooms/'+room.id+'/members/cx/memory','PATCH',{read:false,propose:false});
  await dispatch('@助手 第三次');
  assert.deepEqual(seen.at(-1).names,[]);assert.equal(seen.at(-1).prompt.includes('关键词候选索引'),false);
  await assert.rejects(call('/rooms/'+room.id+'/members/cx/memory','PATCH',{read:'yes'}),/记忆开关无效/);
  await assert.rejects(call('/rooms/'+room.id+'/members/nobody/memory','PATCH',{read:true}),/不在这个房间/);
});

test('one-way @mentions: the companion gets only the message on its own desk, and the conversation still reads its answer',{timeout:30000},async t=>{
  const prompts=[];
  const reply=(emit,text)=>{emit({type:'replace',text});emit({type:'final-answer',text});};
  const implementations={codex:async({prompt,emit})=>{prompts.push(prompt);reply(emit,prompt.includes('单向可见')?'我负责：独立评估\n独立结论 Q7':'我负责：复核\n普通结论 N2');}};
  const dataDir=mkdtempSync(join(tmpdir(),'hub-one-way-')),workspace=mkdtempSync(join(tmpdir(),'hub-one-way-ws-'));
  const hub=createHub({port:0,dataDir,registry,implementations});await hub.listen();t.after(()=>hub.close());
  const {store,workflows}=hub,room=store.group('评审室');
  workflows.createCompanion({name:'评审',avatar:'🔍',provider:'codex'},{id:'rv'});workflows.addMember(room.id,'rv');
  const chat=store.newChat({group_id:room.id,provider:'claude',workspace});store.updateChat(chat.id,{title:'标题里的背景 T3'});
  store.message(chat.id,'user',null,'之前的背景 K9','complete');store.message(chat.id,'assistant','claude','对话模型的看法 M5','complete');
  const desk=table=>store.db.prepare(`SELECT * FROM ${table} WHERE companion_id='rv' AND chat_id=?`).get(chat.id);
  assert.equal(workflows.state().oneWay,true,'the page offers the switch only to a server that handles it');

  // An ordinary mention sees the conversation, as before.
  const normal=await workflows.dispatch(chat.id,{text:'@评审 先看一眼'});await until(()=>!workflows.runs.size,'normal');
  assert.match(prompts.at(-1),/之前的背景 K9/);assert.match(prompts.at(-1),/标题里的背景 T3/);
  const cursor=desk('companion_desks').cursor;assert.equal(cursor,normal.user.id);
  store.message(chat.id,'user',null,'后来的背景 K10','complete');

  // One-way: only this message, on a desk of its own; the ordinary desk and its cursor are untouched.
  const oneWay=await workflows.dispatch(chat.id,{text:'@评审 独立评估这个方案',isolated:true});await until(()=>!workflows.runs.size,'one-way');
  const prompt=prompts.at(-1);
  assert.match(prompt,/单向可见/);assert.match(prompt,/独立评估这个方案/);assert.match(prompt,/房间里的伙伴：🔍 评审/);
  for(const hidden of ['K9','K10','M5','T3','N2','评审室','自你上次发言以来'])assert.equal(prompt.includes(hidden),false,hidden);
  assert.equal(oneWay.user.details.dispatch.isolated,true);
  const card=store.messageById(chat.id,oneWay.message.id),run=card.details.workflowRun;
  assert.equal(run.isolated,true);assert.equal(run.steps[0].status,'done');assert.match(card.content,/单向可见/);
  const isolatedDesk=desk('companion_isolated_desks').desk_id;
  assert.equal(run.steps[0].deskChatId,isolatedDesk);assert.notEqual(isolatedDesk,desk('companion_desks').desk_id);
  assert.equal(desk('companion_desks').cursor,cursor);assert.equal(store.chat(isolatedDesk).options.desk.isolated,true);

  // The same one-way desk carries on; ordinary mentions are not one-way unless asked.
  const again=await workflows.dispatch(chat.id,{text:'@评审 再想想',isolated:true});await until(()=>!workflows.runs.size,'one-way again');
  assert.equal(store.messageById(chat.id,again.message.id).details.workflowRun.steps[0].deskChatId,isolatedDesk);
  assert.equal((await workflows.dispatch(chat.id,{text:'@评审 x',isolated:'yes'})).user.details.dispatch.isolated,undefined);
  await until(()=>!workflows.runs.size,'not one-way');

  // The conversation sees the one-way answer and where to read the desk in full; the next
  // ordinary mention catches up on it, since its own desk never saw it.
  const context=buildContext(store.messages(chat.id)).text;
  assert.match(context,/独立结论 Q7/);assert.match(context,/伙伴历史记录 · 点名 评审 · 单向可见/);assert.ok(context.includes('chatId='+isolatedDesk));
  assert.match(store.search.read({chatId:isolatedDesk},store.chat(chat.id).project_id).text,/独立结论 Q7/);
  await workflows.dispatch(chat.id,{text:'@评审 回到正常模式'});await until(()=>!workflows.runs.size,'back to normal');
  assert.match(prompts.at(-1),/后来的背景 K10/);assert.match(prompts.at(-1),/评审：我负责：独立评估 独立结论 Q7/);

  // Deleting the companion removes both of its desks.
  workflows.deleteCompanion('rv');
  assert.equal(store.chat(isolatedDesk),null);assert.equal(store.db.prepare('SELECT count(*) n FROM companion_isolated_desks').get().n,0);
});

test('exams: the model proposes, the user starts; seats answer blind and in parallel in their own folders, and the checks come back',{timeout:40000},async t=>{
  const workspace=mkdtempSync(join(tmpdir(),'hub-exam-ws-')),examRoot=join(mkdtempSync(join(tmpdir(),'hub-exam-root-')),'StarPortExams');
  for(const [path,body] of [['paper/sim.py','def run(seed): ...\n'],['paper/README.md','估计 R'],['paper/.git/HEAD','ref'],['answers/truth.txt','R=0.42'],['kb/notes.md','开卷笔记']]){
    mkdirSync(join(workspace,path,'..'),{recursive:true});writeFileSync(join(workspace,path),body);
  }
  const reply=(emit,text)=>{emit({type:'replace',text});emit({type:'final-answer',text});};
  const seats=[];let proposeArgs=null,proposal=null,mainTools=[],mainPrompt='',inFlight=0,most=0;
  const sit=async({prompt,emit,cwd,contextTools},answer)=>{
    seats.push({prompt,cwd,tools:contextTools?.definitions.map(d=>d.name)||[]});inFlight++;most=Math.max(most,inFlight);
    await new Promise(r=>setTimeout(r,200));inFlight--;
    reply(emit,await answer(cwd,emit));
  };
  const implementations={
    // The conversation's own model sets the exam.
    claude:async({prompt,emit,contextTools})=>{mainPrompt=prompt;
      mainTools=contextTools?.definitions.map(d=>d.name)||[];
      if(proposeArgs)try{proposal=await contextTools.call('starport_exam_propose',proposeArgs);}catch(error){proposal={error:error.message};}
      reply(emit,'题出好了');
    },
    // Seat 1 tunes the locked simulator and peeks at the answers; seat 3 lists the exam folder.
    codex:args=>sit(args,async(cwd,emit)=>{
      if(cwd.endsWith('考位1-解题人')){
        writeFileSync(join(cwd,'sim.py'),readFileSync(join(cwd,'sim.py'),'utf8')+'# tuned\n');writeFileSync(join(cwd,'answer.md'),'R=0.42');
        emit({type:'tool',id:'peek',name:'shell',status:'complete',input:{command:'type '+join(workspace,'answers','truth.txt')},output:'R=0.42'});
        return '答卷：R=0.42';
      }
      emit({type:'tool',id:'look',name:'shell',status:'complete',input:{command:'dir ..'},output:'考位1-解题人\n考位2-推导者\n考位3-解题人'});
      return '答卷：R≈0.4';
    }),
    deepseek:args=>sit(args,async cwd=>`答卷：开卷 ${existsSync(join(cwd,'知识库','notes.md'))}`)
  };
  const dataDir=mkdtempSync(join(tmpdir(),'hub-exam-'));
  const hub=createHub({port:0,dataDir,registry,implementations,examRoot});await hub.listen();t.after(()=>hub.close());
  const base='http://127.0.0.1:'+hub.server.address().port;
  const call=async(path,method='GET',data)=>{const res=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Hub-Token':hub.token,Origin:base},body:data===undefined?undefined:JSON.stringify(data)});const json=await res.json();if(!res.ok)throw Object.assign(new Error(json.error),{status:res.status});return json;};
  const {store,workflows}=hub;
  workflows.createCompanion({name:'解题人',avatar:'🛰',provider:'codex',access:'readonly'},{id:'sol'});
  workflows.createCompanion({name:'推导者',avatar:'🐋',provider:'deepseek'},{id:'ds'});
  await call('/context/preferences','PATCH',{revision:0,content:'偏好 PQ7X'});
  const chat=store.newChat({provider:'claude',workspace});store.updateChat(chat.id,{title:'红队机密 TQ3X'});
  store.message(chat.id,'user',null,'真值藏在 answers 里 KQ9X','complete');
  const turn=async text=>{const started=await hub.runner.start(chat.id,text,[]);await started.done;};

  // The model proposes; nothing is copied and no examinee hears anything yet.
  proposeArgs={paper:'paper',instruction:'估计 R；sim.py 不许改',seats:['解题人','推导者','sol'],knowledge:['kb/notes.md'],minutes:30,name:'B4 盲测'};
  await turn('出一道盲测题');
  assert.ok(mainTools.includes('starport_exam_propose'));assert.match(mainPrompt,/PQ7X/);assert.match(mainPrompt,/星港考场/);assert.equal(proposal.status,'proposed',JSON.stringify(proposal));
  let card=store.messageById(chat.id,proposal.messageId),run=card.details.workflowRun;
  assert.equal(run.kind,'exam');assert.equal(run.status,'proposed');assert.equal(run.exam.paper.files,2,'.git stays behind');
  assert.deepEqual(run.exam.seats.map(s=>[s.companionId,s.knowledge]),[['sol',true],['ds',true],['sol',true]]);
  assert.equal(existsSync(examRoot),false);assert.equal(seats.length,0);
  assert.match(buildContext(store.messages(chat.id)).text,/考场提议，用户还没有按「开考」/);
  await assert.rejects(workflows.proposeExam(chat.id,{...proposeArgs,seats:['没有这人']}),/现有伙伴：解题人、推导者/);
  await assert.rejects(workflows.proposeExam(chat.id,{...proposeArgs,paper:'missing'}),/试卷不存在/);

  // Only the page starts it; the user changed who reads the knowledge and lifted the time limit.
  const started=await call(`/chats/${chat.id}/exams/${proposal.messageId}/start`,'POST',{seats:[{companionId:'sol',knowledge:false},{companionId:'ds',knowledge:true},{companionId:'sol',knowledge:false}],minutes:0});
  assert.equal(started.message.details.workflowRun.status,'running');
  assert.equal(started.message.status,'complete','the page never turns a finished message back into a running one');
  await assert.rejects(call(`/chats/${chat.id}/exams/${proposal.messageId}/start`,'POST',{}),/已经开考或取消/);
  await until(()=>!workflows.runs.size,'exam',15000);
  card=store.messageById(chat.id,proposal.messageId);run=card.details.workflowRun;
  assert.equal(run.status,'done');assert.equal(most,3,'the seats sit at the same time');
  const folder=run.exam.folder,dirs=readdirSync(folder).sort();
  assert.ok(folder.startsWith(examRoot));assert.deepEqual(dirs,['考位1-解题人','考位2-推导者','考位3-解题人']);
  for(const dir of dirs){assert.ok(existsSync(join(folder,dir,'sim.py')));assert.equal(existsSync(join(folder,dir,'.git')),false);}
  assert.equal(existsSync(join(folder,'考位2-推导者','知识库','notes.md')),true);assert.equal(existsSync(join(folder,'考位1-解题人','知识库')),false);

  // Each examinee heard only the exam, in its own seat, with no tools.
  assert.equal(seats.length,3);
  for(const seat of seats){
    assert.match(seat.prompt,/估计 R；sim\.py 不许改/);assert.ok(seat.prompt.includes(seat.cwd));assert.deepEqual(seat.tools,[]);
    for(const hidden of ['KQ9X','TQ3X','PQ7X','answers',workspace])assert.equal(seat.prompt.includes(hidden),false,hidden);
  }
  assert.match(seats.find(s=>s.cwd.endsWith('考位2-推导者')).prompt,/开卷考/);assert.match(seats.find(s=>s.cwd.endsWith('考位1-解题人')).prompt,/闭卷考/);
  const [one,two,three]=run.steps;
  assert.deepEqual(run.steps.map(s=>s.status),['done','done','done']);assert.equal(two.output,'答卷：开卷 true');
  const desk=store.chat(one.deskChatId);
  assert.equal(desk.workspace,one.seat.dir);assert.equal(desk.options.desk.exam,true);assert.notEqual(one.deskChatId,three.deskChatId);
  assert.notEqual(desk.options.codex.sandbox,'read-only','a read-only companion may still write in its seat');

  // The checks: the tuned simulator, the peek at the answers, the look at the other seats.
  assert.deepEqual(one.seat.audit.modified,['sim.py']);assert.equal(one.seat.audit.added,1);assert.equal(one.seat.audit.stray.count,1);
  assert.equal(two.seat.audit.changed,0);assert.equal(two.seat.audit.stray.count,0);
  assert.equal(three.seat.audit.changed,0);assert.equal(three.seat.audit.stray.count,1);

  // The conversation's model reads every answer, where each seat is, and what the checks found.
  const context=buildContext(store.messages(chat.id)).text;
  for(const text of ['考场记录 · 考场「B4 盲测」','答卷：R=0.42','修改了 sim.py','越界：1 次',one.seat.dir,'chatId='+one.deskChatId])assert.ok(context.includes(text),text);
  assert.match(store.search.read({chatId:one.deskChatId},null).text,/答卷：R=0.42/);

  // A proposal can be cancelled, and then not started.
  await turn('再出一道');
  const second=proposal.messageId;
  assert.equal((await call(`/chats/${chat.id}/exams/${second}/cancel`,'POST',{})).message.details.workflowRun.status,'cancelled');
  await assert.rejects(call(`/chats/${chat.id}/exams/${second}/start`,'POST',{}),/已经开考或取消/);
  assert.equal(readdirSync(examRoot).length,1);
});

test('an empty desk reply shows the tool\'s reason on the run card, and desks run unattended',{timeout:30000},async t=>{
  const seen=[];
  const implementations={antigravity:async({emit,unattended})=>{seen.push(unattended);await new Promise(resolve=>setTimeout(resolve,20));emit({type:'notice',text:'命令在无人值守的工位里被自动拒绝'});emit({type:'replace',text:''});emit({type:'final-answer',text:''});}};
  const dataDir=mkdtempSync(join(tmpdir(),'hub-desk-notice-')),workspace=mkdtempSync(join(tmpdir(),'hub-desk-notice-ws-'));
  const hub=createHub({port:0,dataDir,registry,implementations});await hub.listen();t.after(()=>hub.close());
  const {store,workflows}=hub,room=store.group('科研');
  workflows.createCompanion({name:'argon',provider:'antigravity',access:'workspace'},{id:'ag'});workflows.addMember(room.id,'ag');
  const chat=store.newChat({group_id:room.id,provider:'codex',workspace});
  const sent=await workflows.dispatch(chat.id,{text:'@argon 写个脚本'});await until(()=>!workflows.runs.size,'run');
  const step=store.messageById(chat.id,sent.message.id).details.workflowRun.steps[0];
  assert.equal(step.status,'failed');assert.equal(step.error,'命令在无人值守的工位里被自动拒绝');assert.deepEqual(seen,[true]);
});

test('companions pick their tool\'s own 工作方式: every Claude mode, Codex 只读, and presets for older companions',{timeout:30000},async t=>{
  const seen=[];
  const reply=provider=>async({emit,options})=>{seen.push([provider,options.permissionMode,options.sandbox??null]);emit({type:'replace',text:'好'});emit({type:'final-answer',text:'好'});};
  const dataDir=mkdtempSync(join(tmpdir(),'hub-desk-modes-')),workspace=mkdtempSync(join(tmpdir(),'hub-desk-modes-ws-'));
  const hub=createHub({port:0,dataDir,registry,implementations:{claude:reply('claude'),codex:reply('codex')}});await hub.listen();t.after(()=>hub.close());
  const {store,workflows}=hub,room=store.group('科研'),fields=workflows.state().deskFields;
  assert.deepEqual(fields.claude.map(f=>[f.key,f.choices.map(c=>c.value)]),[['permissionMode',['default','plan','dontAsk','acceptEdits','auto','bypassPermissions']]]);
  assert.deepEqual(fields.codex.map(f=>[f.key,f.choices.map(c=>c.value)]),[['mode',['chat','plan']],['permissionMode',['read-only','ask','auto-review','full-access']]]);
  assert.deepEqual(fields.antigravity.map(f=>f.key),['mode','permissionMode','sandbox']);assert.deepEqual(fields.deepseek,[]);
  assert.match(fields.claude[0].choices.find(c=>c.value==='acceptEdits').description,/Python/);
  assert.deepEqual(workflows.createCompanion({name:'莉芙',provider:'claude',options:{permissionMode:'auto'}},{id:'cl'}).options,{permissionMode:'auto'});
  // An older companion has only a preset; reading it fills in the matching choices.
  workflows.db.prepare('INSERT INTO companions VALUES(?,?,?,?)').run('old',JSON.stringify({name:'老伙伴',avatar:'·',role:'',persona:'',provider:'codex',model:'',effort:'',service:'',access:'readonly'}),'2026-01-01','2026-01-01');
  assert.deepEqual(workflows.companion('old').options,{mode:'chat',permissionMode:'read-only'});
  for(const id of ['cl','old'])workflows.addMember(room.id,id);
  const chat=store.newChat({group_id:room.id,provider:'deepseek',workspace});
  await workflows.dispatch(chat.id,{text:'@莉芙 跑一下 python 脚本'});await until(()=>!workflows.runs.size,'claude run');
  await workflows.dispatch(chat.id,{text:'@老伙伴 看一下'});await until(()=>!workflows.runs.size,'codex run');
  assert.deepEqual(seen,[['claude','auto',null],['codex','ask','read-only']]);
  // A saved change reaches the companion's desk on its next request.
  workflows.updateCompanion('cl',{options:{permissionMode:'bypassPermissions'}});
  await workflows.dispatch(chat.id,{text:'@莉芙 再跑一次'});await until(()=>!workflows.runs.size,'second run');
  assert.deepEqual(seen.at(-1),['claude','bypassPermissions',null]);
  // A new tool without new choices starts from its safe default; choices a tool lacks are refused.
  assert.deepEqual(workflows.updateCompanion('cl',{provider:'antigravity'}).options,{mode:'auto',permissionMode:'configured',sandbox:true});
  assert.throws(()=>workflows.updateCompanion('cl',{provider:'codex',options:{permissionMode:'goal'}}),/权限选项无效/);
  assert.throws(()=>workflows.updateCompanion('cl',{options:{mode:'goal'}}),/工作方式选项无效/);
  assert.throws(()=>workflows.updateCompanion('cl',{options:'auto'}),/工作方式格式无效/);
});

test('while a companion works: others take @-requests alongside it, the chat model still answers, and a second request to it waits its turn',{timeout:30000},async t=>{
  const started=[];let finishLong;const long=new Promise(resolve=>finishLong=resolve);
  const reply=(emit,text)=>{emit({type:'replace',text});emit({type:'final-answer',text});};
  // Desk prompts carry the conversation, so look for the newest request first.
  const implementations={
    codex:async({prompt,emit})=>{const key=['第二件','并行任务','长任务'].find(word=>prompt.includes(word));started.push(key);if(key==='长任务')await long;reply(emit,'我负责：'+key+'\n完成 '+key);},
    claude:async({emit})=>{started.push('主模型');reply(emit,'主模型的回答');}};
  const dataDir=mkdtempSync(join(tmpdir(),'hub-parallel-')),workspace=mkdtempSync(join(tmpdir(),'hub-parallel-ws-'));
  // Let the long task end before closing, so a failed check does not leave the hub waiting on it.
  const hub=createHub({port:0,dataDir,registry,implementations});await hub.listen();t.after(()=>{finishLong();return hub.close();});
  const {store,workflows,runner}=hub,room=store.group('并行室');workflows.deskPollMs=20;
  workflows.createCompanion({name:'甲',avatar:'🦉',provider:'codex'},{id:'a'});workflows.addMember(room.id,'a');
  workflows.createCompanion({name:'乙',avatar:'🐙',provider:'codex'},{id:'b'});workflows.addMember(room.id,'b');
  const chat=store.newChat({group_id:room.id,provider:'claude',workspace});
  const events=[],raw=workflows.broadcastRaw;workflows.broadcastRaw=(type,data)=>{events.push([type,data]);raw(type,data);};
  const working=id=>workflows.state().running.flatMap(run=>run.steps).filter(step=>step.companionId===id);

  const first=await workflows.dispatch(chat.id,{text:'@甲 长任务'});await until(()=>started.includes('长任务'),'甲 starts');
  assert.equal(working('a').length,1);assert.equal(working('a')[0].queued,false);assert.ok(Date.parse(working('a')[0].started));
  assert.ok(workflows.state().running[0].started,'the room can count from when the run began');

  // Another companion starts at once, beside the busy one.
  const beside=await workflows.dispatch(chat.id,{text:'@乙 并行任务'});
  await until(()=>store.messageById(chat.id,beside.message.id).details.workflowRun.status==='done','乙 finishes while 甲 still works');
  assert.equal(store.messageById(chat.id,first.message.id).details.workflowRun.status,'running');

  // Without an @, the message goes to the conversation's own model, which answers now.
  await runner.start(chat.id,'不点名，直接问对话模型');await runner.active.get(chat.id)?.done;
  assert.ok(started.includes('主模型'));assert.equal(store.messages(chat.id).findLast(m=>m.role==='assistant'&&m.provider==='claude').content,'主模型的回答');

  // A second request to 甲 waits for the first and says so; its clock starts when its turn comes.
  const before=events.length;
  const second=await workflows.dispatch(chat.id,{text:'@甲 第二件'});
  const step=()=>store.messageById(chat.id,second.message.id).details.workflowRun.steps[0];
  await until(()=>step()?.queued===true,'second request queued');
  assert.equal(started.includes('第二件'),false);
  assert.deepEqual(working('a').map(s=>s.queued).sort(),[false,true]);
  assert.ok(events.slice(before).some(([type,data])=>type==='workflows'&&data.reason==='runs'),'the room hears about the queue at once');
  finishLong();
  await until(()=>!workflows.runs.size,'both finish');
  assert.deepEqual(started.filter(key=>key!=='主模型'),['长任务','并行任务','第二件']);
  const done=step(),firstStep=store.messageById(chat.id,first.message.id).details.workflowRun.steps[0];
  assert.equal(done.status,'done');assert.equal(done.queued,undefined);
  assert.ok(Date.parse(done.started)>=Date.parse(firstStep.ended),'its clock started after the first request ended');
  assert.match(done.output,/完成 第二件/);
});

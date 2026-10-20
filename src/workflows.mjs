// Companions, room rosters, reusable workflows and their per-conversation mounts.
// Every workflow step runs in a fresh hidden desk conversation through the normal
// runner; saved run-card outputs are shared with the conversation's own model.
//
// The pieces live in ./workflows/: records (validation), planning (@-mentions → order),
// cards (run-card text), prompts, desk (unattended runs), ledger, exam (seat folders and
// checks), schema, migrate, routes.
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { PROVIDERS } from './providers.mjs';
import { redact } from './process.mjs';
import { userFolders } from './folders.mjs';
import { CompanionClock, companionLimits, validateCompanionLimits } from './companion-limits.mjs';
import { fail, now, newId, clip, tail, sleep, localTime, text, oneLine } from './workflows/common.mjs';
import { KNOWLEDGE, EXAM_LIMITS, examMinutes, examSource, resolveSource, placements, prepareSeats, auditSeat, strayCalls, freshFolder, seatFolder, safeName, sizeText } from './workflows/exam.mjs';
import { DESK_FIELDS, DEFAULT_PLANNERS, companionOptions, companionData, deskOptions, workflowData, triggerData, nextSlot, assignmentsFor } from './workflows/records.mjs';
import { parseMentions, verdict, heuristicPlan, plannerPrompt, parsePlan } from './workflows/planning.mjs';
import { cardText, runContext } from './workflows/cards.mjs';
import * as prompts from './workflows/prompts.mjs';
import { runUnattended } from './workflows/desk.mjs';
import { Ledger, DEFAULT_PLAN_TEMPLATE, splitLedger } from './workflows/ledger.mjs';
import { ensureSchema } from './workflows/schema.mjs';
import { migrateBrowserData } from './workflows/migrate.mjs';
import { handleWorkflowRoutes } from './workflows/routes.mjs';

export { ACCESS, DESK_FIELDS, DEFAULT_PLANNERS, companionOptions, companionData, deskOptions, workflowData, triggerData, nextSlot } from './workflows/records.mjs';
export { parseMentions, verdict, heuristicPlan } from './workflows/planning.mjs';
export { planTable, cardText } from './workflows/cards.mjs';
export { DEFAULT_PLAN_TEMPLATE, splitLedger } from './workflows/ledger.mjs';

const TICK_MS=20000,GRACE_MS=2*60*1000;

export class Workflows {
  // examRoot is where exam folders go; by default StarPortExams on the user's desktop.
  constructor({store,runner,broadcast=()=>{},dataDir,registry=null,defaultWorkspace='',examRoot=null,clockFactory=options=>new CompanionClock(options)}){
    this.store=store;this.db=store.db;this.runner=runner;this.broadcastRaw=broadcast;this.registry=registry;this.defaultWorkspace=defaultWorkspace;this.clockFactory=clockFactory;
    this.dataDir=dataDir;this.examRoot=examRoot;this.starting=new Set();
    this.runs=new Map();
    this.ledger=new Ledger({db:this.db,store,root:join(dataDir,'ledgers'),mount:id=>this.mount(id),companionName:id=>this.companion(id)?.name});
    ensureSchema(this.db);
    this.recover();
    runner.resolveRunRef=(chatId,ref)=>this.runReference(chatId,ref);
    runner.proposeExam=(chatId,args)=>this.proposeExam(chatId,args);
  }
  broadcast(reason,chatId=null){this.broadcastRaw('workflows',{reason,...chatId?{chatId}:{}});}
  start(){
    if(this.timer)return;
    this.timer=setInterval(()=>this.tick(),TICK_MS);this.timer.unref?.();
    const first=setTimeout(()=>this.tick(),3000);first.unref?.();
  }
  async close(){
    clearInterval(this.timer);this.timer=null;this.closing=true;
    for(const run of this.runs.values())this.stopRun(run.id,'星港正在关闭，这次运行已停止');
    await Promise.allSettled([...this.runs.values()].map(run=>run.promise));
  }
  // A restart interrupts the desks; their cards must not stay "running" forever.
  recover(){
    const rows=this.db.prepare("SELECT id,chat_id FROM messages WHERE role='assistant' AND json_extract(details,'$.workflowRun.status') IN ('planning','running')").all();
    for(const row of rows){
      const message=this.store.messageById(row.chat_id,row.id),run=message.details.workflowRun;
      run.status='stopped';run.ended=now();run.notes=[...run.notes||[],'星港重启，这次运行被中断。'];
      for(const step of run.steps||[])if(['waiting','running'].includes(step.status))step.status='stopped';
      message.status='complete';message.content=cardText(run);this.store.saveMessage(message);
    }
  }

  // --- records ---
  decode(row){return row?{id:row.id,...JSON.parse(row.data),created:row.created,updated:row.updated}:null;}
  companions(){return this.db.prepare('SELECT * FROM companions ORDER BY created,id').all().map(row=>this.companionView(row));}
  companion(id){return typeof id==='string'?this.companionView(this.db.prepare('SELECT * FROM companions WHERE id=?').get(id)):null;}
  // Older companions only have a preset; a choice the tool no longer offers falls back to it too.
  companionView(row){
    const companion=this.decode(row);if(!companion)return null;
    try{companion.options=companionOptions(companion.provider,companion.options,companion.access);}
    catch{companion.options=companionOptions(companion.provider,null,companion.access);}
    return companion;
  }
  workflows(){return this.db.prepare('SELECT * FROM workflows ORDER BY created,id').all().map(row=>this.decode(row));}
  workflow(id){return typeof id==='string'?this.decode(this.db.prepare('SELECT * FROM workflows WHERE id=?').get(id)):null;}
  mountRow(row){return row?{id:row.id,chatId:row.chat_id,workflowId:row.workflow_id,...JSON.parse(row.data),created:row.created,updated:row.updated}:null;}
  mounts(chatId=null){return (chatId?this.db.prepare('SELECT * FROM workflow_mounts WHERE chat_id=? ORDER BY created').all(chatId):this.db.prepare('SELECT * FROM workflow_mounts ORDER BY created').all()).map(row=>this.mountRow(row));}
  mount(id){return typeof id==='string'?this.mountRow(this.db.prepare('SELECT * FROM workflow_mounts WHERE id=?').get(id)):null;}
  saveMount(mount){
    const {id,chatId,workflowId,created,updated,...data}=mount;
    this.db.prepare('UPDATE workflow_mounts SET data=?,updated=? WHERE id=?').run(JSON.stringify(data),now(),id);
  }
  members(groupId){return groupId?this.db.prepare('SELECT companion_id FROM room_members WHERE group_id=? ORDER BY added,rowid').all(groupId).map(row=>row.companion_id):[];}
  roomCompanions(groupId){return this.members(groupId).map(id=>this.companion(id)).filter(Boolean);}
  rooms(){
    const rooms={};
    for(const row of this.db.prepare('SELECT group_id,companion_id FROM room_members ORDER BY added,rowid').all())(rooms[row.group_id]||=[]).push(row.companion_id);
    return rooms;
  }
  roomMemory(){
    const result={};
    for(const row of this.db.prepare('SELECT group_id,companion_id,memory_read,memory_propose FROM room_members').all())(result[row.group_id]||={})[row.companion_id]={read:!!row.memory_read,propose:!!row.memory_propose};
    return result;
  }
  // Outside any room (or when not a member) a desk gets no memory tools.
  memberMemory(groupId,companionId){
    const row=groupId?this.db.prepare('SELECT memory_read,memory_propose FROM room_members WHERE group_id=? AND companion_id=?').get(groupId,companionId):null;
    return {read:!!row?.memory_read,propose:!!row?.memory_propose};
  }
  setMemberMemory(groupId,companionId,raw={}){
    if(!this.db.prepare('SELECT 1 FROM room_members WHERE group_id=? AND companion_id=?').get(groupId,companionId))throw fail('这位伙伴不在这个房间里',404);
    for(const [key,column] of [['read','memory_read'],['propose','memory_propose']]){
      if(raw[key]===undefined)continue;if(typeof raw[key]!=='boolean')throw fail('记忆开关无效');
      this.db.prepare(`UPDATE room_members SET ${column}=? WHERE group_id=? AND companion_id=?`).run(raw[key]?1:0,groupId,companionId);
    }
    this.broadcast('rooms');return this.memberMemory(groupId,companionId);
  }
  groupName(groupId){return groupId?this.db.prepare('SELECT name FROM groups WHERE id=?').get(groupId)?.name||'':'';}
  settings(){
    const saved=this.store.setting('workflows.settings',null)||{};
    return {planners:Array.isArray(saved.planners)&&saved.planners.length?saved.planners:DEFAULT_PLANNERS,verifyRetries:saved.verifyRetries??0,...companionLimits(saved)};
  }
  saveSettings(raw={}){
    const current=this.settings(),planners=raw.planners===undefined?current.planners:raw.planners;
    if(!Array.isArray(planners)||planners.length>3)throw fail('排程模型最多 3 个');
    const chain=planners.map((p,i)=>{
      const provider=p?.provider||'';if(provider&&!PROVIDERS[provider])throw fail(`第 ${i+1} 选的工具无效`);
      const effort=text(p?.effort,100,'思考强度');if(effort&&!/^[\w-]+$/.test(effort))throw fail('思考强度格式无效');
      return {provider,model:text(p?.model,200,'模型'),effort};
    });
    const verifyRetries=Number(raw.verifyRetries??current.verifyRetries),limits=validateCompanionLimits(raw,current);
    if(!Number.isInteger(verifyRetries)||verifyRetries<0||verifyRetries>3)throw fail('验收失败重试次数应为 0–3');
    this.store.setSetting('workflows.settings',{planners:chain,verifyRetries,...limits});this.broadcast('settings');
    return this.settings();
  }
  // Minutes a desk may run, or 0 when the user has not turned the step limit on.
  stepMinutes(){const limits=this.settings();return limits.stepLimitEnabled?limits.stepMinutes:0;}
  scores(){
    const scores={};
    for(const row of this.db.prepare('SELECT companion_id,COUNT(*) AS n,AVG(brier) AS brier FROM prediction_scores GROUP BY companion_id').all())scores[row.companion_id]={n:row.n,brier:Math.round(row.brier*1000)/1000};
    return scores;
  }
  running(mountId){return [...this.runs.values()].find(run=>run.mountId===mountId)||null;}
  busy(chatId){return [...this.runs.values()].some(run=>run.chatId===chatId);}
  blockers(mount){
    const chat=this.store.chat(mount.chatId);if(!chat)return ['对话不存在'];
    if(!chat.group_id)return ['对话在「未分组」，工作流已暂停'];
    const workflow=this.workflow(mount.workflowId);if(!workflow)return ['工作流已删除'];
    const members=new Set(this.members(chat.group_id)),empty=[],absent=[];
    for(const stage of workflow.stages)for(const position of stage.positions){
      const id=mount.assignments?.[position.id],companion=id?this.companion(id):null;
      if(!companion)empty.push(position.name);else if(!members.has(id))absent.push(companion.name);
    }
    return [...empty.length?[`位置空缺：${empty.join('、')}`]:[],...absent.length?[`${absent.join('、')} 不在房间里`]:[]];
  }
  mountView(mount){
    const run=this.running(mount.id),target=this.ledger.target(mount),pending=this.ledger.proposals(target,mount).filter(p=>p.status==='pending').length;
    return {...mount,blockers:this.blockers(mount),runningId:run?.id||null,runningMessageId:run?.card.id||null,pendingProposals:pending,ledgerPath:target.dir,ledgerProject:target.project?.name||null};
  }
  state(){
    return {companions:this.companions(),rooms:this.rooms(),roomMemory:this.roomMemory(),workflows:this.workflows(),mounts:this.mounts().map(mount=>this.mountView(mount)),
      settings:this.settings(),deskFields:DESK_FIELDS,scores:this.scores(),migrated:!!this.store.setting('workflows.migrated'),defaults:{planTemplate:DEFAULT_PLAN_TEMPLATE,planners:DEFAULT_PLANNERS},
      // The page offers the one-way switch only when this is present: a server not yet restarted would ignore it.
      oneWay:true,
      running:[...this.runs.values()].map(run=>({id:run.id,chatId:run.chatId,mountId:run.mountId,messageId:run.card.id,companions:[...run.companions]}))};
  }

  // --- companions and rosters ---
  createCompanion(raw,{id=null,groupId=null}={}){
    const data=companionData(raw),cid=id&&/^[\w-]{1,40}$/.test(id)&&!this.companion(id)?id:newId('c_'),time=now();
    this.db.prepare('INSERT INTO companions VALUES(?,?,?,?)').run(cid,JSON.stringify(data),time,time);
    if(groupId)this.addMember(groupId,cid,{quiet:true});
    this.broadcast('companions');return this.companion(cid);
  }
  updateCompanion(id,raw){
    const old=this.companion(id);if(!old)throw fail('伙伴不存在',404);
    const {id:_,created,updated,...previous}=old,data=companionData(raw,previous);
    this.db.prepare('UPDATE companions SET data=?,updated=? WHERE id=?').run(JSON.stringify(data),now(),id);
    this.broadcast('companions');return this.companion(id);
  }
  deleteCompanion(id){
    if(!this.companion(id))throw fail('伙伴不存在',404);
    if([...this.runs.values()].some(run=>run.companions.has(id)))throw fail('这位伙伴正在工作，请先停止它参与的运行',409);
    const desks=this.db.prepare('SELECT desk_id FROM companion_desks WHERE companion_id=? UNION SELECT desk_id FROM companion_isolated_desks WHERE companion_id=?').all(id,id).map(row=>row.desk_id);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const mount of this.mounts()){
        let changed=false;for(const [position,holder] of Object.entries(mount.assignments||{}))if(holder===id){mount.assignments[position]=null;changed=true;}
        if(changed)this.saveMount(mount);
      }
      this.db.prepare('DELETE FROM companions WHERE id=?').run(id);
      for(const desk of desks)this.db.prepare('DELETE FROM chats WHERE id=?').run(desk);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.broadcast('companions');return {ok:true};
  }
  addMember(groupId,companionId,{quiet=false}={}){
    if(!this.db.prepare('SELECT id FROM groups WHERE id=?').get(groupId))throw fail('房间不存在',404);
    if(!this.companion(companionId))throw fail('伙伴不存在',404);
    this.db.prepare('INSERT OR IGNORE INTO room_members(group_id,companion_id,added) VALUES(?,?,?)').run(groupId,companionId,now());
    if(!quiet)this.broadcast('rooms');return {ok:true,members:this.members(groupId)};
  }
  // Positions held in this room are reassigned or left empty; an empty seat pauses its workflow.
  removeMember(groupId,companionId,{reassign={}}={}){
    const changes=[];
    for(const mount of this.roomMounts(groupId)){
      let changed=false;
      for(const [position,holder] of Object.entries(mount.assignments||{})){
        if(holder!==companionId)continue;
        const next=reassign?.[mount.id]?.[position]||null;
        if(next&&(next===companionId||!this.companion(next)))throw fail('接替的伙伴无效');
        if(next)this.addMember(groupId,next,{quiet:true});
        mount.assignments[position]=next;changed=true;changes.push({mountId:mount.id,positionId:position,companionId:next});
      }
      if(changed)this.saveMount(mount);
    }
    this.db.prepare('DELETE FROM room_members WHERE group_id=? AND companion_id=?').run(groupId,companionId);
    this.broadcast('rooms');return {ok:true,changes,members:this.members(groupId)};
  }
  roomMounts(groupId){return this.db.prepare('SELECT m.* FROM workflow_mounts m JOIN chats c ON c.id=m.chat_id WHERE c.group_id=? ORDER BY m.created').all(groupId).map(row=>this.mountRow(row));}
  // Moving a conversation brings its workflows' companions into the new room.
  chatMoved(chatId){
    const chat=this.store.chat(chatId);if(!chat?.group_id)return this.broadcast('mounts',chatId);
    for(const mount of this.mounts(chatId))for(const id of Object.values(mount.assignments||{}))if(id&&this.companion(id))this.addMember(chat.group_id,id,{quiet:true});
    this.broadcast('rooms',chatId);
  }

  // --- workflows and mounts ---
  createWorkflow(raw){
    const data=workflowData(raw),id=newId('w_'),time=now();
    this.db.prepare('INSERT INTO workflows VALUES(?,?,?,?)').run(id,JSON.stringify(data),time,time);
    this.broadcast('workflows');return this.workflow(id);
  }
  updateWorkflow(id,raw){
    const old=this.workflow(id);if(!old)throw fail('工作流不存在',404);
    const {id:_,created,updated,...previous}=old,data=workflowData(raw,previous);
    this.db.prepare('UPDATE workflows SET data=?,updated=? WHERE id=?').run(JSON.stringify(data),now(),id);
    const positions=new Set(data.stages.flatMap(stage=>stage.positions.map(p=>p.id)));
    for(const mount of this.mounts().filter(m=>m.workflowId===id)){
      for(const key of Object.keys(mount.assignments||{}))if(!positions.has(key))delete mount.assignments[key];
      for(const key of positions)if(!(key in mount.assignments))mount.assignments[key]=null;
      this.saveMount(mount);
    }
    this.broadcast('workflows');return this.workflow(id);
  }
  deleteWorkflow(id){
    if(!this.workflow(id))throw fail('工作流不存在',404);
    if([...this.runs.values()].some(run=>run.workflowId===id))throw fail('这个工作流正在运行，请先停止',409);
    this.db.prepare('DELETE FROM workflows WHERE id=?').run(id);this.broadcast('workflows');return {ok:true};
  }
  assignments(workflow,raw={},old={}){return assignmentsFor(workflow,raw,old,id=>!!this.companion(id));}
  createMount(chatId,raw={}){
    const chat=this.store.chat(chatId);if(!chat||chat.options?.desk)throw fail('对话不存在',404);
    const workflow=this.workflow(raw.workflowId);if(!workflow)throw fail('工作流不存在',404);
    const data={enabled:raw.enabled===true,trigger:triggerData(raw.trigger||{type:'manual'}),missed:raw.missed==='skip'?'skip':'once',
      assignments:this.assignments(workflow,raw.assignments),nextAt:null,lastRunAt:null,lastStatus:null,lastMessageId:null,lastNote:'',proposals:[]};
    data.nextAt=data.enabled?nextSlot(data.trigger,Date.now()):null;
    const id=newId('m_'),time=now();
    this.db.prepare('INSERT INTO workflow_mounts VALUES(?,?,?,?,?,?)').run(id,chatId,workflow.id,JSON.stringify(data),time,time);
    this.joinAssigned(chat,data.assignments);
    if(workflow.ledger)this.ledger.ensure(this.mount(id),workflow).catch(()=>{});
    this.broadcast('mounts',chatId);return this.mountView(this.mount(id));
  }
  updateMount(id,raw={}){
    const mount=this.mount(id);if(!mount)throw fail('挂载不存在',404);
    const workflow=this.workflow(mount.workflowId),chat=this.store.chat(mount.chatId);
    if(raw.trigger!==undefined)mount.trigger=triggerData(raw.trigger);
    if(raw.missed!==undefined)mount.missed=raw.missed==='skip'?'skip':'once';
    if(raw.enabled!==undefined){if(typeof raw.enabled!=='boolean')throw fail('启用状态无效');mount.enabled=raw.enabled;}
    if(raw.assignments!==undefined)mount.assignments=this.assignments(workflow,raw.assignments,mount.assignments);
    if(raw.trigger!==undefined||raw.enabled!==undefined)mount.nextAt=mount.enabled?nextSlot(mount.trigger,Date.now()):null;
    this.saveMount(mount);this.joinAssigned(chat,mount.assignments);
    this.broadcast('mounts',mount.chatId);return this.mountView(this.mount(id));
  }
  deleteMount(id){
    const mount=this.mount(id);if(!mount)throw fail('挂载不存在',404);
    if(this.running(id))throw fail('这个工作流正在运行，请先停止',409);
    this.db.prepare('DELETE FROM workflow_mounts WHERE id=?').run(id);this.broadcast('mounts',mount.chatId);return {ok:true};
  }
  joinAssigned(chat,assignments){
    if(!chat?.group_id)return;
    for(const id of Object.values(assignments||{}))if(id)this.addMember(chat.group_id,id,{quiet:true});
    this.broadcast('rooms',chat.id);
  }

  // --- scheduler ---
  tick(time=Date.now()){
    if(this.closing)return;
    for(const mount of this.mounts()){
      if(!mount.enabled||mount.trigger.type==='manual')continue;
      if(!mount.nextAt){mount.nextAt=nextSlot(mount.trigger,time);this.saveMount(mount);continue;}
      if(mount.nextAt>time)continue;
      const late=time-mount.nextAt>GRACE_MS,blockers=this.blockers(mount);
      mount.nextAt=nextSlot(mount.trigger,time);
      const sharing=this.workflow(mount.workflowId)?.ledger?this.ledgerRun(this.ledger.target(mount).key):null;
      if(this.running(mount.id))mount.lastNote=`${localTime(time)} 到点时上次运行仍在进行，本次跳过`;
      else if(sharing)mount.lastNote=`${localTime(time)} 到点时同项目的对话「${clip(this.store.chat(sharing.chatId)?.title||'',30)}」正在用同一份台账运行，本次跳过`;
      else if(blockers.length)mount.lastNote=`${localTime(time)} 未运行：${blockers.join('；')}`;
      else if(late&&mount.missed==='skip')mount.lastNote=`${localTime(time)} 错过的运行已按设置跳过`;
      else{this.saveMount(mount);this.runMount(mount.id,{trigger:late?'catchup':'schedule'}).catch(()=>{});continue;}
      this.saveMount(mount);this.broadcast('mounts',mount.chatId);
    }
  }

  // --- runs ---
  createRun(chat,meta){
    const runId=newId('r_'),workflowRun={id:runId,status:'running',started:now(),ended:null,notes:[],steps:[],timeLimitMinutes:this.stepMinutes(),...meta};
    const card=this.store.message(chat.id,'assistant',null,cardText(workflowRun),'running',{liveRevision:0,workflowRun});
    const run={id:runId,chatId:chat.id,mountId:meta.mountId||null,workflowId:meta.workflowId||null,card,desks:new Set(),companions:new Set(),stopped:false};
    this.runs.set(runId,run);
    this.broadcastRaw('message',{chatId:chat.id,message:card,chat:this.store.chat(chat.id)});this.broadcastRaw('refresh',{chatId:chat.id});this.broadcast('runs',chat.id);
    return run;
  }
  saveCard(run){
    const card=run.card;card.details.workflowRun.updatedAt=now();card.details.liveRevision=(card.details.liveRevision||0)+1;card.content=cardText(card.details.workflowRun);
    this.store.saveMessage(card);
    this.broadcastRaw('message',{chatId:card.chat_id,message:card,chat:this.store.chat(card.chat_id)});
  }
  stopRun(runId,note='已手动停止'){
    const run=this.runs.get(runId);if(!run)throw fail('这次运行已经结束',404);
    if(!run.stopped){run.stopped=true;run.card.details.workflowRun.notes.push(note);for(const desk of run.desks)this.runner.stop(desk).catch(()=>{});}
    return {ok:true};
  }
  async stopChat(chatId){
    const runs=[...this.runs.values()].filter(run=>run.chatId===chatId);
    for(const run of runs)this.stopRun(run.id,'对话被删除，运行已停止');
    await Promise.allSettled(runs.map(run=>run.promise));
  }
  finish(run,meta={}){
    const result=run.card.details.workflowRun;
    if(run.stopped)result.status='stopped';
    else if(result.status==='running'||result.status==='planning')result.status=(result.steps||[]).some(s=>s.verify&&s.verdict==='pass')?'passed':'done';
    result.ended=now();run.card.status='complete';this.saveCard(run);this.runs.delete(run.id);
    if(run.mountId){const mount=this.mount(run.mountId);if(mount){mount.lastStatus=result.status;mount.lastMessageId=run.card.id;this.saveMount(mount);}}
    this.broadcastRaw('refresh',{chatId:run.chatId});this.broadcast('runs',run.chatId);
    if(!run.stopped&&!this.closing){
      const last=(result.steps||[]).filter(step=>step.output||step.error).at(-1);
      try{this.onFinished?.({chatId:run.chatId,kind:'workflow',status:result.status,label:result.title||'',text:last?.output||last?.error||result.notes.at(-1)||''});}catch{}
    }
  }
  // Runs the body in the background; any error fails the card, and the card is always finished.
  launch(run,body){
    run.promise=(async()=>{
      try{await body();}
      catch(error){run.card.details.workflowRun.status='failed';run.card.details.workflowRun.notes.push(redact(error.message).slice(0,2000));}
      finally{this.finish(run);}
    })();
  }
  addStep(run,row,attempt=0){
    const companion=this.companion(row.companionId),step={key:row.key||row.companionId,order:row.order,positionId:row.positionId||null,label:row.label||'',stageName:row.stageName||'',
      task:row.task,verify:!!row.verify,companionId:row.companionId,companionName:companion?.name||'（已删除的伙伴）',avatar:companion?.avatar||'',
      status:'waiting',attempt,deskChatId:null,deskMessageId:null,output:'',error:'',verdict:null,notes:[],ledger:null,started:null,ended:null,...row.seat?{seat:{...row.seat}}:{}};
    run.card.details.workflowRun.steps.push(step);if(companion)run.companions.add(companion.id);
    return step;
  }
  // A manual run may carry one instruction from the input box; it goes to every position of this run only.
  async runMount(mountId,{trigger='manual',text:request=''}={}){
    const mount=this.mount(mountId);if(!mount)throw fail('挂载不存在',404);
    if(request!=null&&typeof request!=='string'||String(request||'').length>100000)throw fail('本次要求最多 100000 字符');
    request=String(request||'').trim();
    if(this.running(mountId))throw fail('这个工作流正在运行',409);
    const blockers=this.blockers(mount);if(blockers.length)throw fail(blockers.join('；'),409);
    const workflow=this.workflow(mount.workflowId);let chat=this.store.chat(mount.chatId);
    const ledger=workflow.ledger?this.ledger.target(mount):null,sharing=ledger&&this.ledgerRun(ledger.key);
    if(sharing)throw fail(`同项目的对话「${clip(this.store.chat(sharing.chatId)?.title||'',30)}」正在运行这个工作流，它们共用一份台账，请等它结束`,409);
    const user=request?this.store.message(chat.id,'user',null,request,'complete',{dispatch:{mountId}}):null;
    if(user&&chat.title==='新对话')chat=this.store.updateChat(chat.id,{title:request.replace(/\s+/g,' ').slice(0,36)});
    const rows=workflow.stages.flatMap((stage,index)=>stage.positions.map(position=>{
      const companion=this.companion(mount.assignments[position.id]);
      return {key:position.id,order:index+1,positionId:position.id,stageName:stage.name,label:position.name,task:position.task,verify:position.verify,companionId:companion.id,companionName:companion.name};
    }));
    const run=this.createRun(chat,{kind:'workflow',title:`工作流「${workflow.name}」`,mountId,workflowId:workflow.id,workflowName:workflow.name,trigger,plan:{source:'workflow',rows},ledger:workflow.ledger,...user?{userMessageId:user.id}:{}});
    run.ledgerKey=ledger?.key||null;
    mount.lastRunAt=now();mount.lastNote='';this.saveMount(mount);this.broadcast('mounts',chat.id);
    const context={mode:'workflow',mount,workflow,ledger,trigger,request,retries:workflow.retries,ledgerLog:[],history:prompts.userNotes(this.store.messages(chat.id),mount.lastMessageId)};
    this.launch(run,async()=>{
      if(ledger)await this.ledger.ensure(mount,workflow,ledger);
      await this.executeRows(run,chat,context);
      if(ledger)await this.ledger.close(run,ledger,workflow,context);
    });
    return {run:run.id,message:run.card,...user?{user}:{}};
  }
  async dispatch(chatId,raw={}){
    const value=raw.text;
    if(typeof value!=='string'||!value.trim()||value.length>100000)throw fail('请输入 1–100000 字符的消息');
    const chat=this.store.chat(chatId);if(!chat||chat.options?.desk)throw fail('对话不存在',404);
    if(!chat.group_id)throw fail('这个对话不在房间里，不能点名伙伴');
    const mentions=parseMentions(value,this.roomCompanions(chat.group_id));
    if(!mentions.length)throw fail('没有点名房间里的伙伴');
    const unique=[...new Map(mentions.map(m=>[m.companion.id,m])).values()];
    // One-way: the companions get only this message; their answers still come back to the conversation.
    const isolated=raw.isolated===true,flag=isolated?{isolated:true}:{};
    const user=this.store.message(chatId,'user',null,value,'complete',{dispatch:{companions:unique.map(m=>m.companion.id),...flag}});
    if(chat.title==='新对话')this.store.updateChat(chatId,{title:value.replace(/\s+/g,' ').slice(0,36)});
    const run=this.createRun(chat,{kind:'adhoc',title:`点名 ${unique.map(m=>m.companion.name).join('、')}`,trigger:'dispatch',userMessageId:user.id,...flag,status:unique.length>1?'planning':'running',plan:null});
    for(const mention of unique)run.companions.add(mention.companion.id);
    const context={mode:'adhoc',isolated,text:value,userMessageId:user.id,cardId:run.card.id,retries:this.settings().verifyRetries};
    this.launch(run,async()=>{
      const result=run.card.details.workflowRun;
      result.plan=unique.length===1?{source:'direct',rows:[{order:1,companionId:unique[0].companion.id,task:unique[0].segment||value,verify:false}]}:await this.plan(run,chat,value,unique);
      for(const row of result.plan.rows){const companion=this.companion(row.companionId);row.companionName=companion?.name||row.companionId;row.key=row.companionId+':'+row.order;}
      if(run.stopped)return;
      result.status='running';this.saveCard(run);
      await this.executeRows(run,chat,context);
    });
    return {user,message:run.card};
  }
  // Steps sharing an order run in parallel; later orders see earlier output.
  async executeRows(run,chat,context){
    const result=run.card.details.workflowRun,orders=[...new Set(result.plan.rows.map(row=>row.order))].sort((a,b)=>a-b);
    const groups=orders.map(order=>result.plan.rows.filter(row=>row.order===order));
    let outputs=[],attempts=0,retry=null;
    for(let index=0;index<groups.length;index++){
      if(run.stopped)return;
      const steps=groups[index].map(row=>this.addStep(run,row,attempts));
      this.saveCard(run);
      await this.runGroup(run,chat,steps,{...context,rows:result.plan.rows,outputs,feedback:retry?.index===index?retry.text:''});
      if(run.stopped)return;
      // Exam seats answer side by side; one seat failing does not void the others.
      if(context.mode==='exam'){
        const failed=steps.filter(step=>step.status==='failed').length;
        if(failed===steps.length)result.status='failed';else if(failed)result.notes.push(`${failed} 个考位没有完成，其余考位已交卷`);
        return;
      }
      if(steps.some(step=>step.status==='failed')){result.status='failed';return;}
      const rejected=steps.filter(step=>step.verify&&step.verdict==='fail');
      if(rejected.length){
        let back=index-1;while(back>=0&&groups[back].every(row=>row.verify))back--;
        if(attempts>=context.retries||back<0){result.status='verify-failed';return;}
        attempts++;retry={index:back,text:rejected.map(step=>`${step.companionName}：${clip(step.output,4000)}`).join('\n\n')};
        result.notes.push(`验收未通过，从第 ${groups[back][0].order} 步重做（第 ${attempts} 次重试）`);
        outputs=outputs.filter(item=>item.index<back);index=back-1;continue;
      }
      outputs=[...outputs,...steps.filter(step=>step.output).map(step=>({index,order:step.order,label:step.label,companionName:step.companionName,avatar:step.avatar,output:step.output}))];
    }
  }
  async runGroup(run,chat,steps,context){
    const lanes=new Map();
    for(const step of steps){const key=context.mode==='adhoc'?step.companionId:step.key;if(!lanes.has(key))lanes.set(key,[]);lanes.get(key).push(step);}
    await Promise.all([...lanes.values()].map(async lane=>{for(const step of lane){if(run.stopped){step.status='stopped';continue;}await this.runStep(run,chat,step,context);}}));
  }
  newDesk(chat,{provider,options,title,meta,workspace=chat.workspace}){
    return this.store.newChat({group_id:null,title,provider,workspace,project_id:chat.project_id&&this.store.project(chat.project_id)?chat.project_id:null,options:{[provider]:options,desk:{parentChatId:chat.id,...meta}}});
  }
  // A companion keeps one persistent desk per conversation for ad-hoc requests, and a second one
  // for one-way requests, whose session never receives the conversation.
  companionDesk(companion,chat,{isolated=false}={}){
    const table=isolated?'companion_isolated_desks':'companion_desks';
    const row=this.db.prepare(`SELECT * FROM ${table} WHERE companion_id=? AND chat_id=?`).get(companion.id,chat.id),options=deskOptions(companion.provider,companion);
    let desk=row?this.store.chat(row.desk_id):null;
    if(!desk){
      desk=this.newDesk(chat,{provider:companion.provider,options,title:`[工位] ${companion.name}${isolated?' · 单向':''}`,meta:{companionId:companion.id,persistent:true,...isolated?{isolated:true}:{}}});
      this.db.prepare(`INSERT OR REPLACE INTO ${table}(companion_id,chat_id,desk_id) VALUES(?,?,?)`).run(companion.id,chat.id,desk.id);
      return {desk,cursor:null};
    }
    if(!this.runner.active.has(desk.id)&&(desk.provider!==companion.provider||desk.workspace!==chat.workspace||JSON.stringify(desk.options[companion.provider])!==JSON.stringify(options)))
      desk=this.store.updateChat(desk.id,{provider:companion.provider,workspace:chat.workspace,options:{...desk.options,[companion.provider]:options}});
    return {desk,cursor:row.cursor??null};
  }
  async waitIdle(run,deskId){
    while(this.runner.active.has(deskId)&&!run.stopped&&!this.closing)await sleep(1000);
  }
  async runStep(run,chat,step,context){
    const exam=context.mode==='exam',minutes=exam?context.minutes:this.stepMinutes();
    step.timeLimitMinutes=minutes;step.status='running';step.started=now();this.saveCard(run);
    try{
      const companion=this.companion(step.companionId);if(!companion)throw new Error('这个位置的伙伴已不存在');
      let desk,cursor=null;
      if(context.mode==='adhoc'){({desk,cursor}=this.companionDesk(companion,chat,{isolated:context.isolated}));await this.waitIdle(run,desk.id);if(run.stopped){step.status='stopped';return;}}
      // A seat is a copy made for this exam, so an examinee may always write and run things in it.
      else if(exam)desk=this.newDesk(chat,{provider:companion.provider,options:deskOptions(companion.provider,companion.access==='readonly'?{...companion,options:null,access:'workspace'}:companion),
        title:`[考位] ${companion.name} · ${context.exam.name}`,workspace:step.seat.dir,meta:{companionId:companion.id,runId:run.id,exam:true}});
      else desk=this.newDesk(chat,{provider:companion.provider,options:deskOptions(companion.provider,companion),title:`[工位] ${companion.name} · ${context.workflow.name}`,meta:{companionId:companion.id,runId:run.id,mountId:context.mount.id}});
      step.deskChatId=desk.id;step.provider=companion.provider;step.model=companion.model;
      const prompt=context.mode==='adhoc'?this.adhocPrompt(chat,companion,step,context,cursor)
        :exam?prompts.examPrompt({companion,instruction:context.exam.instruction,seat:step.seat.dir,knowledge:step.seat.knowledge})
        :this.workflowPrompt(chat,companion,step,context);
      if(context.mode==='adhoc'&&!context.isolated)this.db.prepare('UPDATE companion_desks SET cursor=? WHERE companion_id=? AND chat_id=?').run(context.userMessageId,companion.id,chat.id);
      this.saveCard(run);
      // An examinee gets no memory and none of the user's standing preferences: only the exam.
      const result=await this.execDesk(run,desk.id,prompt,{minutes,memory:exam?null:this.memberMemory(chat.group_id,companion.id),bare:exam,
        onRuntime:runtime=>{step.runtime=runtime;step.deskMessageId=runtime.messageId;this.saveCard(run);},
        onCheckpoint:checkpoint=>{step.checkpoint=checkpoint;this.saveCard(run);},
        onNote:note=>{step.notes.push(note);this.saveCard(run);}});
      step.deskMessageId=result.messageId;this.mergeMemory(run,result.memory);
      if(exam)await this.checkSeat(step,desk.id,result.messageId,context);
      const usesLedger=context.mode==='workflow'&&context.workflow.ledger;
      const split=usesLedger?splitLedger(result.output):{text:result.output,ops:null,error:''};
      step.output=clip(split.text.trim(),40000);
      // A timeout or crash fails the step so nothing downstream runs on missing input.
      if(result.status!=='complete'){step.status=run.stopped?'stopped':'failed';step.error=result.error||(result.status==='interrupted'?'被中断（超时或工具退出）':'没有完成');return;}
      // An empty answer usually has a reason the tool reported, such as a declined command.
      if(!step.output){step.status='failed';step.error=result.notices.at(-1)||'没有返回内容';return;}
      step.status='done';
      if(step.verify)step.verdict=verdict(step.output)||'unclear';
      if(split.error)step.notes.push(split.error);
      if(usesLedger){
        step.ledger=split.ops?await this.ledger.apply(context.ledger,companion.id,split.ops,run):{added:[],status:[],verifiers:[],proposal:null,rejected:[]};
        context.ledgerLog.push({step,log:step.ledger.log||null});
      }
    }catch(error){step.status='failed';step.error=redact(error.message).slice(0,2000);}
    finally{step.ended=now();this.saveCard(run);}
  }
  execDesk(run,deskId,prompt,options){return runUnattended(this,run,deskId,prompt,options);}
  // After a seat hands in, or stops: compare it with the paper and look for calls outside it.
  async checkSeat(step,deskId,messageId,context){
    try{
      const audit=await auditSeat(step.seat.dir,context.manifest,{knowledge:step.seat.knowledge});
      const siblings=context.rows.filter(row=>row.key!==step.key).map(row=>basename(row.seat.dir));
      audit.stray=strayCalls(this.store.messageById(deskId,messageId)?.details,{seat:step.seat.dir,forbidden:context.forbidden,siblings});
      step.seat.audit=audit;
    }catch(error){step.notes.push('交卷检查没有完成：'+redact(error.message).slice(0,300));}
  }
  // Memories a desk read or proposed show on the run card, where the user can review them.
  mergeMemory(run,memory){
    if(!memory?.ids?.length&&!memory?.candidates?.length)return;
    const target=run.card.details.memory||={epoch:memory.epoch,ids:[],omitted:0,candidates:[],sources:[],browsed:[],reads:[],projectId:memory.projectId||null};
    for(const key of ['ids','candidates'])target[key]=[...new Set([...target[key],...memory[key]||[]])];
    for(const item of memory.browsed||[])if(!target.browsed.some(old=>old.id===item.id))target.browsed.push(item);
    target.reads.push(...memory.reads||[]);
  }
  // The planner chain falls through on any failure; the final fallback needs no model.
  async plan(run,chat,value,mentions){
    const attempts=[],chain=this.settings().planners.filter(p=>p.provider),prompt=plannerPrompt(value,mentions);
    for(const planner of chain){
      if(run.stopped)break;
      try{
        const options=deskOptions(planner.provider,{model:planner.model,effort:planner.effort,access:'readonly'});
        const desk=this.newDesk(chat,{provider:planner.provider,options,title:'[工位] 排程',meta:{planner:true,runId:run.id}});
        const result=await this.execDesk(run,desk.id,prompt,{minutes:this.stepMinutes(),
          onNote:note=>{run.card.details.workflowRun.notes.push(note);this.saveCard(run);},
          onCheckpoint:checkpoint=>{run.card.details.workflowRun.checkpoint=checkpoint;this.saveCard(run);}});
        if(result.status!=='complete')throw new Error(result.error||'没有完成');
        const plan=parsePlan(result.output,mentions);
        if(!plan)throw new Error('输出不是有效的执行顺序表');
        return {...plan,source:'planner',planner,attempts};
      }catch(error){attempts.push({...planner,error:redact(error.message).slice(0,300)});}
    }
    return {...heuristicPlan(value,mentions),source:'heuristic',attempts};
  }

  // --- exams: the conversation's model proposes, the user starts (files and checks: ./workflows/exam.mjs) ---
  async examFolder(){
    if(this.examRoot)return this.examRoot;
    const desktop=(await userFolders()).find(place=>place.label==='桌面')?.path;
    return join(desktop||homedir(),'StarPortExams');
  }
  // Seats name companions by id or name; the same companion may take more than one seat.
  examSeats(raw,{knowledge}){
    if(!Array.isArray(raw)||!raw.length)throw fail('请至少安排一个考位');
    if(raw.length>EXAM_LIMITS.seats)throw fail(`考位最多 ${EXAM_LIMITS.seats} 个`);
    const all=this.companions();
    return raw.map(item=>{
      const ref=String((typeof item==='string'?item:item?.companionId)||'').trim().replace(/^@/,'');
      const companion=all.find(c=>c.id===ref)||all.find(c=>c.name===ref)||all.find(c=>c.name.toLowerCase()===ref.toLowerCase());
      if(!companion)throw fail(`没有叫「${clip(ref,40)}」的伙伴。现有伙伴：${all.map(c=>c.name).join('、')||'（还没有伙伴）'}`);
      const open=typeof item?.knowledge==='boolean'?item.knowledge:true;
      return {companionId:companion.id,companionName:companion.name,avatar:companion.avatar,knowledge:knowledge&&open};
    });
  }
  async examSources(paperPath,knowledgePaths){
    const exclude=[await this.examFolder()];
    const paper=await examSource(paperPath,{label:'试卷',folderOnly:true,exclude}),names=new Set(),knowledge=[];
    for(const path of knowledgePaths){
      const item=await examSource(path,{label:'知识库',exclude}),base=safeName(basename(path));
      let name=base;for(let n=2;names.has(name.toLowerCase());n++)name=`${base}-${n}`;
      names.add(name.toLowerCase());knowledge.push({...item,name});
    }
    const files=paper.files.length+knowledge.reduce((sum,item)=>sum+item.files.length,0),bytes=paper.bytes+knowledge.reduce((sum,item)=>sum+item.bytes,0);
    if(files>EXAM_LIMITS.files||bytes>EXAM_LIMITS.bytes)throw fail(`试卷和知识库合计超过 ${EXAM_LIMITS.files} 个文件或 ${sizeText(EXAM_LIMITS.bytes)}，请只放考生需要的材料`);
    if(knowledge.length&&paper.files.some(file=>file.rel===KNOWLEDGE||file.rel.startsWith(KNOWLEDGE+'/')))throw fail(`试卷里已有「${KNOWLEDGE}」；开卷资料会放在这个位置，请给试卷里的改个名字`);
    return {paper,knowledge};
  }
  // A proposal is only a card: nothing is copied and no examinee hears anything until the user
  // presses 开考 on it.
  async proposeExam(chatId,raw={}){
    const chat=this.store.chat(chatId);if(!chat||chat.options?.desk)throw fail('对话不存在',404);
    const instruction=text(raw.instruction,100000,'题目说明',true),listed=raw.knowledge??[];
    if(!Array.isArray(listed)||listed.length>EXAM_LIMITS.sources)throw fail(`知识库最多 ${EXAM_LIMITS.sources} 项`);
    const {paper,knowledge}=await this.examSources(resolveSource(raw.paper,chat.workspace,'试卷'),listed.map(value=>resolveSource(value,chat.workspace,'知识库')));
    const seats=this.examSeats(raw.seats,{knowledge:knowledge.length>0}),minutes=examMinutes(raw.minutes);
    const name=text(raw.name,40,'考场名称')||clip(oneLine(instruction),24);
    const exam={name,instruction,minutes,seats,
      paper:{path:paper.path,files:paper.files.length,bytes:paper.bytes,top:[...new Set(paper.files.map(file=>file.rel.split('/')[0]))].slice(0,40)},
      knowledge:knowledge.map(item=>({path:item.path,name:item.name,kind:item.kind,files:item.files.length,bytes:item.bytes}))};
    const workflowRun={id:newId('r_'),kind:'exam',title:`考场「${name}」`,trigger:'exam',status:'proposed',started:now(),ended:null,notes:[],steps:[],plan:null,exam};
    const card=this.store.message(chat.id,'assistant',null,cardText(workflowRun),'complete',{liveRevision:0,workflowRun});
    this.broadcastRaw('message',{chatId:chat.id,message:card,chat:this.store.chat(chat.id)});this.broadcastRaw('refresh',{chatId:chat.id});
    return {status:'proposed',messageId:card.id,title:workflowRun.title,paper:{path:paper.path,files:paper.files.length,size:sizeText(paper.bytes)},
      knowledge:exam.knowledge.map(item=>item.path),seats:seats.map(seat=>seat.companionName+(seat.knowledge?'（开卷）':'')),minutes,
      notice:'考场提议卡片已放进对话，等用户核对后按「开考」；在那之前考生收不到任何内容。不要重复提议。考完后结果会以考场卡片回到这个对话。'};
  }
  examCard(chatId,messageId){
    const chat=this.store.chat(chatId);if(!chat||chat.options?.desk)throw fail('对话不存在',404);
    const card=this.store.messageById(chatId,messageId),result=card?.details?.workflowRun;
    if(result?.kind!=='exam')throw fail('考场不存在',404);
    if(result.status!=='proposed'||this.starting.has(result.id))throw fail('这个考场已经开考或取消了',409);
    return {chat,card,result};
  }
  // The user may change the seats and the time limit on the card before starting.
  async startExam(chatId,messageId,raw={}){
    const {chat,card,result}=this.examCard(chatId,messageId),exam=result.exam;
    this.starting.add(result.id);
    try{
      const seats=this.examSeats(raw.seats??exam.seats,{knowledge:exam.knowledge.length>0}),minutes=examMinutes(raw.minutes??exam.minutes);
      // Listed again: the paper may have changed since it was proposed.
      const {paper,knowledge}=await this.examSources(exam.paper.path,exam.knowledge.map(item=>item.path));
      const folder=await freshFolder(await this.examFolder(),exam.name);
      Object.assign(exam,{seats,minutes,folder,paper:{...exam.paper,files:paper.files.length,bytes:paper.bytes}});
      const rows=seats.map((seat,index)=>({key:'seat'+(index+1),order:1,companionId:seat.companionId,companionName:seat.companionName,label:`考位 ${index+1}`,task:'独立作答',
        seat:{dir:join(folder,seatFolder(index,seat.companionName)),knowledge:seat.knowledge}}));
      // The card stays a finished message: the page never turns a finished message back into a
      // running one, so the exam's progress lives only in workflowRun.status.
      Object.assign(result,{status:'running',started:now(),plan:{source:'exam',rows},timeLimitMinutes:minutes,preparing:true});
      const run={id:result.id,chatId,mountId:null,workflowId:null,card,desks:new Set(),companions:new Set(seats.map(seat=>seat.companionId)),stopped:false};
      this.runs.set(run.id,run);this.saveCard(run);this.broadcastRaw('refresh',{chatId});this.broadcast('runs',chatId);
      // Places an examinee should not reach; its own seat inside the exam folder is taken out first.
      const context={mode:'exam',exam,minutes,manifest:null,forbidden:[chat.workspace,paper.path,...knowledge.map(item=>item.path),this.dataDir,folder]};
      this.launch(run,async()=>{
        try{context.manifest=await prepareSeats(placements(paper,knowledge),rows.map(row=>row.seat));}
        finally{delete result.preparing;}
        if(run.stopped)return;
        await this.executeRows(run,chat,context);
      });
      return {message:card};
    }finally{this.starting.delete(result.id);}
  }
  cancelExam(chatId,messageId){
    const {card,result}=this.examCard(chatId,messageId);
    Object.assign(result,{status:'cancelled',ended:now(),updatedAt:now()});
    card.details.liveRevision=(card.details.liveRevision||0)+1;card.content=cardText(result);this.store.saveMessage(card);
    this.broadcastRaw('message',{chatId,message:card,chat:this.store.chat(chatId)});this.broadcastRaw('refresh',{chatId});
    return {message:card};
  }

  // --- prompts ---
  identity(companion,chat,{isolated=false}={}){return prompts.identity(companion,{room:this.groupName(chat.group_id),title:chat.title,members:this.roomCompanions(chat.group_id),isolated});}
  adhocPrompt(chat,companion,step,context,cursor){
    const history=context.isolated?'':prompts.progressSince(this.store.messages(chat.id),cursor,{exclude:new Set([context.userMessageId,context.cardId]),companionId:companion.id});
    return prompts.adhocPrompt({intro:this.identity(companion,chat,{isolated:context.isolated}),history,cursor,step,companion,context});
  }
  workflowPrompt(chat,companion,step,context){
    const {workflow,mount}=context,intro=this.identity(companion,chat);
    const background=workflow.ledger?this.ledger.section(context.ledger||this.ledger.target(mount))
      :prompts.lastConclusion(mount.lastMessageId?this.store.messageById(mount.chatId,mount.lastMessageId)?.details?.workflowRun:null);
    return prompts.workflowPrompt({intro,step,companion,context,background});
  }

  // --- ledger (files and git live in ./workflows/ledger.mjs) ---
  // The run, if any, currently writing to this ledger (possibly from another conversation).
  ledgerRun(key){return [...this.runs.values()].find(run=>run.ledgerKey===key)||null;}
  sharedMounts(target){
    if(!target.project)return [];
    return this.mounts().filter(m=>m.id!==target.mountId&&this.ledger.target(m).key===target.key);
  }
  ledgerView(mountId){
    const mount=this.mount(mountId);if(!mount)throw fail('挂载不存在',404);
    const target=this.ledger.target(mount);
    const ledger=this.ledger.read(target);
    const sharedWith=this.sharedMounts(target).map(m=>({mountId:m.id,chatId:m.chatId,title:this.store.chat(m.chatId)?.title||''}));
    return {...ledger,changelog:tail(ledger.changelog,40000),proposals:this.ledger.proposals(target,mount),workflowId:mount.workflowId,chatId:mount.chatId,project:target.project,sharedWith};
  }
  async editLedger(mountId,raw={}){
    const mount=this.mount(mountId);if(!mount)throw fail('挂载不存在',404);
    const workflow=this.workflow(mount.workflowId);if(!workflow)throw fail('工作流不存在',404);
    const target=this.ledger.target(mount);
    if(this.running(mountId)||this.ledgerRun(target.key))throw fail('运行中不能修改台账，请等这次运行结束',409);
    await this.ledger.ensure(mount,workflow,target);
    await this.ledger.edit(target,mount,raw);
    this.broadcast('mounts',mount.chatId);return this.ledgerView(mountId);
  }

  // --- replying to a run card attaches that run to the user's message ---
  runReference(chatId,ref){
    if(typeof ref!=='string'||!/^[\w-]{1,100}$/.test(ref))throw fail('引用的运行无效');
    const card=this.store.messageById(chatId,ref),run=card?.details?.workflowRun;if(!run)throw fail('引用的运行不存在');
    if(['planning','running'].includes(run.status))throw fail('这次运行还没结束');
    const {label,context}=runContext(run);
    return {ref:{messageId:ref,label},context};
  }
  saveAsWorkflow(chatId,messageId,raw={}){
    const run=this.store.messageById(chatId,messageId)?.details?.workflowRun;
    if(!run?.plan?.rows?.length)throw fail('这张卡片没有可保存的执行顺序');
    const orders=[...new Set(run.plan.rows.map(r=>r.order))].sort((a,b)=>a-b),assignments={};
    const stages=orders.map((order,index)=>({name:`第 ${index+1} 步`,positions:run.plan.rows.filter(r=>r.order===order).map(row=>{
      const companion=this.companion(row.companionId),id=newId('p_');assignments[id]=companion?.id||null;
      return {id,name:row.label||companion?.role||companion?.name||'位置',task:row.task,verify:!!row.verify};
    })}));
    const workflow=this.createWorkflow({name:text(raw.name,80,'工作流名称')||clip(run.title,60),description:typeof raw.description==='string'?raw.description:'',stages,ledger:false,retries:this.settings().verifyRetries});
    return {workflow,assignments};
  }

  migrate(raw={}){return migrateBrowserData(this,raw);}
  handle(method,path,read){return handleWorkflowRoutes(this,method,path,read);}
}

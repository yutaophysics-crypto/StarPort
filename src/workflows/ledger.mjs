// The ledger of a ledger-enabled workflow: PLAN.md, claims.json, CHANGELOG.md, verifiers.json
// and proposals.json, with one git commit per run. A conversation in a project shares one
// ledger per workflow with the project's other conversations, kept in the project folder;
// a conversation outside any project has its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { redact } from '../process.mjs';
import { starportDir } from '../projects.mjs';
import { fail, now, newId, clip, tail, oneLine, localTime, text } from './common.mjs';
import { runLabel, TRIGGER_LABEL } from './cards.mjs';

export const DEFAULT_PLAN_TEMPLATE=`# PLAN · {name}

## 目标
{description}

## 验收标准
{acceptance}

## 关键决定
（暂无。每条写：日期 · 决定 · 理由。）

## 工作约定
- 开工顺序：先读台账，再逐条运行 verifiers，最后才开始本次工作。
- 每次运行结束，CHANGELOG 追加一笔：完成了什么、失败的尝试和原因、检查点、已知局限；然后提交一次 git。
- 命题只能新增或改状态，不能改写原文；不能判定自己提出的命题。
- 有权威来源的事实（行情、论文原文、文档内容）不抄进台账，只记来源和你的推断。
- 这份 PLAN 只有在用户确认后才会修改。
`;
const CLAIM_STATUS=['open','verified','refuted','dropped'];

// A desk asks for ledger changes with a trailing ```starport-ledger JSON block; the last one counts.
export function splitLedger(value){
  const source=String(value||''),pattern=/```starport-ledger[^\n]*\n([\s\S]*?)```/g;let last=null,match;
  while((match=pattern.exec(source)))last=match;
  if(!last)return {text:source,ops:null,error:''};
  const clean=source.replace(pattern,'').trim();
  try{const ops=JSON.parse(last[1].trim()||'{}');return ops&&typeof ops==='object'&&!Array.isArray(ops)?{text:clean,ops,error:''}:{text:clean,ops:null,error:'台账代码块应是一个 JSON 对象'};}
  catch{return {text:clean,ops:null,error:'台账代码块不是有效 JSON，本次未写入台账'};}
}

function git(cwd,args){
  return new Promise(resolve=>execFile('git',['-c','safe.directory='+cwd.replace(/\\/g,'/'),'-c','user.name=Starport','-c','user.email=starport@localhost',...args],
    {cwd,timeout:20000,windowsHide:true},(error,stdout,stderr)=>resolve({ok:!error,stdout:String(stdout||''),error:error?redact(String(stderr||error.message)).trim().slice(0,500):''})));
}
const readJson=(file,fallback)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return fallback;}};
const asList=value=>Array.isArray(value)?value:value==null?[]:[value];
const withNewline=value=>value.endsWith('\n')?value:value+'\n';

export class Ledger {
  // mount(id) and companionName(id) look up the workflow records.
  constructor({db,store,root,mount,companionName}){
    this.db=db;this.store=store;this.root=root;this.mount=mount;this.companionName=companionName;this.commitChains=new Map();
  }
  target(mount){
    const chat=this.store.chat(mount.chatId),project=chat?.project_id?this.store.project(chat.project_id):null;
    if(project?.workspace&&existsSync(project.workspace))
      return {key:`project:${project.id}:${mount.workflowId}`,dir:join(project.workspace,'.starport','ledgers',mount.workflowId),project:{id:project.id,name:project.name,workspace:project.workspace},mountId:mount.id};
    return {key:mount.id,dir:join(this.root,mount.id),project:null,mountId:mount.id};
  }
  read(target){
    const dir=target.dir,read=name=>{try{return readFileSync(join(dir,name),'utf8');}catch{return '';}};
    return {path:dir,exists:existsSync(join(dir,'PLAN.md')),plan:read('PLAN.md'),changelog:read('CHANGELOG.md'),
      claims:readJson(join(dir,'claims.json'),{next:1,claims:[]}),verifiers:readJson(join(dir,'verifiers.json'),[])};
  }
  // PLAN proposals live with the ledger so every conversation sharing it sees the same ones.
  // Older ledgers kept them on the mount.
  proposals(target,mount=this.mount(target.mountId)){
    const file=join(target.dir,'proposals.json');
    if(existsSync(file))return readJson(file,[]);
    return target.key===mount?.id?mount?.proposals||[]:[];
  }
  saveProposals(target,list){
    mkdirSync(target.dir,{recursive:true});
    writeFileSync(join(target.dir,'proposals.json'),JSON.stringify(list.slice(-30),null,2)+'\n','utf8');
  }
  // Commits to one folder run one after another, even from different conversations.
  commit(dir,message){
    const chain=resolvePath(dir).toLowerCase(),previous=this.commitChains.get(chain)||Promise.resolve();
    const next=previous.catch(()=>{}).then(async()=>{
      if(!existsSync(join(dir,'.git'))){const init=await git(dir,['init','-q']);if(!init.ok)return init;}
      const status=await git(dir,['status','--porcelain']);
      if(!status.ok)return status;
      if(!status.stdout.trim())return {ok:true};
      const added=await git(dir,['add','-A']);if(!added.ok)return added;
      return git(dir,['commit','-q','-m',message]);
    });
    this.commitChains.set(chain,next);return next;
  }
  async ensure(mount,workflow,target=this.target(mount)){
    if(target.project)starportDir(target.project.workspace);
    const dir=target.dir;if(existsSync(join(dir,'PLAN.md')))return;
    mkdirSync(dir,{recursive:true});
    const plan=(workflow.planTemplate||DEFAULT_PLAN_TEMPLATE).replaceAll('{name}',workflow.name).replaceAll('{description}',workflow.description||'（待补充）').replaceAll('{acceptance}',workflow.acceptance||'（待补充）');
    writeFileSync(join(dir,'PLAN.md'),plan,'utf8');
    writeFileSync(join(dir,'claims.json'),JSON.stringify({next:1,claims:[]},null,2),'utf8');
    writeFileSync(join(dir,'verifiers.json'),'[]\n','utf8');
    writeFileSync(join(dir,'CHANGELOG.md'),`# CHANGELOG · ${workflow.name}\n\n只追加，不改写。每次运行一节：完成了什么、失败的尝试和原因、检查点、已知局限。\n`,'utf8');
    await this.commit(dir,'初始化台账');
  }
  // The part of a desk prompt that shows the ledger and how to change it.
  section(target){
    const ledger=this.read(target),claims=ledger.claims.claims||[],today=new Date().toISOString().slice(0,10);
    const line=claim=>`${claim.id} [${claim.status}] ${claim.text}（${this.companionName(claim.by)||claim.by}${claim.depends?.length?'；依赖 '+claim.depends.join(','):''}${claim.prediction?`；预测 p=${claim.prediction.probability} 截止 ${claim.prediction.deadline} 判据：${claim.prediction.criterion}`:''}）`;
    const open=claims.filter(c=>c.status==='open'),recent=claims.filter(c=>c.status!=='open').slice(-20),due=open.filter(c=>c.prediction&&c.prediction.deadline<=today);
    const shared=target.project?`这是项目「${target.project.name}」的台账，项目里挂了这个工作流的对话共用它。\n`:'';
    return `## 台账（${ledger.path}）
${shared}开工顺序：① 读下面的台账 ② 逐条运行或检查 verifiers，在结果里报告每一条 ③ 再做本次任务。
台账由星港维护，不要直接改这些文件。需要改动时，在回复最后附一个代码块，语言标记写 starport-ledger，内容是 JSON：
- "claims_add": [{"text":"命题","depends":["C1"],"prediction":{"probability":0.6,"deadline":"YYYY-MM-DD","criterion":"判定标准"}}]（不是预测就省略 prediction）
- "claims_status": [{"id":"C3","status":"verified|refuted|dropped|open","note":"依据"}]（只能改状态；不能判定自己提出的命题）
- "log": {"done":["完成的事"],"failed":[{"tried":"试过什么","why":"为什么不行"}],"checkpoints":"markdown 表格","limitations":["已知局限"]}
- "verifiers_add": [{"name":"检查名","how":"命令或检查方法"}]（以后每次开工都要跑）
- "plan_proposal": {"summary":"想怎么改、为什么","plan":"完整的新 PLAN.md"}（用户确认后才生效）
不要记录有权威来源的事实（行情、论文原文、文档内容），只记来源和你的推断。

### PLAN.md
${clip(ledger.plan,8000)}

### 未决命题
${open.map(line).join('\n')||'（无）'}
${due.length?`\n### 已过截止日、等待判定的预测\n${due.map(line).join('\n')}\n`:''}
### 最近已决的命题
${recent.map(line).join('\n')||'（无）'}

### verifiers
${ledger.verifiers.map((v,i)=>`${i+1}. ${v.name}：${v.how}`).join('\n')||'（还没有。发现值得每次都检查的东西时，用 verifiers_add 加上。）'}

### CHANGELOG（最近部分）
${tail(ledger.changelog,8000)}`;
  }
  // Applies one desk's requested changes; anything invalid is listed in rejected instead.
  async apply(target,companionId,ops,run){
    const result={added:[],status:[],verifiers:[],proposal:null,rejected:[],log:null};
    const allowed=new Set(['claims_add','claims_status','log','verifiers_add','plan_proposal']);
    for(const key of Object.keys(ops))if(!allowed.has(key))result.rejected.push(`不支持的操作：${clip(key,40)}（命题只能新增或改状态）`);
    const dir=target.dir,ledger=this.read(target),book=ledger.claims;book.claims||=[];book.next||=book.claims.length+1;
    const known=new Set(book.claims.map(c=>c.id));
    for(const item of asList(ops.claims_add).slice(0,20)){
      try{
        const claimText=text(item?.text,2000,'命题',true),depends=asList(item?.depends).map(String);
        const missing=depends.filter(id=>!known.has(id));if(missing.length)throw fail(`依赖的命题不存在：${missing.join(',')}`);
        const claim={id:'C'+book.next++,text:claimText,by:companionId,run:run.id,created:now(),depends,status:'open',history:[]};
        if(item.prediction!=null){
          const p=item.prediction,probability=Number(p.probability);
          if(!(probability>=0&&probability<=1))throw fail('预测概率应在 0–1 之间');
          if(typeof p.deadline!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.deadline))throw fail('预测截止日期应为 YYYY-MM-DD');
          claim.prediction={probability,deadline:p.deadline,criterion:text(p.criterion,1000,'判定标准',true)};
        }
        book.claims.push(claim);known.add(claim.id);result.added.push(claim.id);
      }catch(error){result.rejected.push(`新增命题失败：${error.message}`);}
    }
    for(const change of asList(ops.claims_status).slice(0,40)){
      const outcome=this.changeClaim(target.key,book,change,companionId,run.id);
      if(outcome.error)result.rejected.push(outcome.error);else if(outcome.change)result.status.push(outcome.change);
    }
    const verifiers=ledger.verifiers;
    for(const item of asList(ops.verifiers_add).slice(0,10)){
      try{
        const name=text(item?.name,80,'检查名',true),how=text(item?.how,2000,'检查方法',true);
        if(verifiers.some(v=>v.name===name)){result.rejected.push(`verifier「${name}」已存在`);continue;}
        verifiers.push({name,how,by:companionId,added:now()});result.verifiers.push(name);
      }catch(error){result.rejected.push(error.message);}
    }
    if(ops.plan_proposal!=null){
      const proposal=typeof ops.plan_proposal==='string'?{summary:ops.plan_proposal}:ops.plan_proposal;
      try{
        const item={id:newId('pp_'),summary:text(proposal?.summary,4000,'修改理由',true),plan:text(proposal?.plan,20000,'新 PLAN'),by:companionId,runId:run.id,chatId:run.chatId,messageId:run.card.id,created:now(),status:'pending'};
        this.saveProposals(target,[...this.proposals(target),item]);result.proposal=item.id;
      }catch(error){result.rejected.push(`PLAN 提议无效：${error.message}`);}
    }
    if(ops.log&&typeof ops.log==='object'){
      const strings=(value,max)=>asList(value).filter(v=>typeof v==='string'&&v.trim()).slice(0,20).map(v=>clip(v.trim(),max));
      result.log={done:strings(ops.log.done,600),failed:asList(ops.log.failed).slice(0,20).map(f=>({tried:clip(oneLine(f?.tried),600),why:clip(oneLine(f?.why),600)})).filter(f=>f.tried),
        checkpoints:typeof ops.log.checkpoints==='string'?clip(ops.log.checkpoints.trim(),8000):'',limitations:strings(ops.log.limitations,600)};
    }
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'claims.json'),JSON.stringify(book,null,2),'utf8');
    writeFileSync(join(dir,'verifiers.json'),JSON.stringify(verifiers,null,2)+'\n','utf8');
    return result;
  }
  // Prediction scores are keyed by ledger: the claim ids C1, C2… are unique within one ledger.
  changeClaim(ledgerKey,book,change,by,runId){
    const claim=book.claims.find(c=>c.id===change?.id);
    if(!claim)return {error:`命题 ${clip(change?.id,20)} 不存在`};
    if(!CLAIM_STATUS.includes(change.status))return {error:`${claim.id} 的状态无效`};
    if(['verified','refuted'].includes(change.status)&&claim.by===by&&by!=='user')return {error:`${claim.id} 是自己提出的命题，不能自己判定`};
    if(claim.status===change.status)return {};
    const note=typeof change.note==='string'?clip(change.note.trim(),1000):'';
    claim.history.push({from:claim.status,to:change.status,by,note,run:runId,at:now()});claim.status=change.status;
    if(claim.prediction&&['verified','refuted'].includes(claim.status)){
      const outcome=claim.status==='verified'?1:0,brier=(claim.prediction.probability-outcome)**2;
      this.db.prepare('INSERT OR REPLACE INTO prediction_scores VALUES(?,?,?,?,?,?,?)').run(ledgerKey,claim.id,claim.by,claim.prediction.probability,outcome,brier,now());
    }else this.db.prepare('DELETE FROM prediction_scores WHERE mount_id=? AND claim_id=?').run(ledgerKey,claim.id);
    return {change:`${claim.id} → ${claim.status}`};
  }
  // Appends this run's CHANGELOG section and commits the ledger.
  async close(run,target,workflow,context){
    const result=run.card.details.workflowRun,dir=target.dir;
    const chat=target.project?this.store.chat(run.chatId):null;
    const section=[`## ${localTime(result.started)} · ${TRIGGER_LABEL[context.trigger]||'手动'} · ${runLabel(run.stopped?'stopped':result.status==='running'?'done':result.status)}（${run.id}${chat?` · 对话「${clip(oneLine(chat.title),40)}」`:''}）`];
    for(const {step,log} of context.ledgerLog){
      section.push(`### ${step.companionName} · ${step.label}${step.attempt?` · 第 ${step.attempt+1} 次`:''}`);
      if(!log){section.push(`- （未提交台账记录）${clip(oneLine(step.output.split('\n')[0]),200)}`);}
      else{
        for(const item of log.done)section.push(`- 完成：${item}`);
        for(const item of log.failed)section.push(`- 失败的尝试：${item.tried} —— 原因：${item.why||'未说明'}`);
        if(log.checkpoints)section.push('- 检查点：\n\n'+log.checkpoints+'\n');
        for(const item of log.limitations)section.push(`- 已知局限：${item}`);
      }
      const ledger=step.ledger||{};
      const changes=[...ledger.added?.length?[`新增 ${ledger.added.join('、')}`]:[],...ledger.status||[],...ledger.verifiers?.length?[`新 verifier：${ledger.verifiers.join('、')}`]:[],...ledger.proposal?['提出了 PLAN 修改（待确认）']:[]];
      if(changes.length)section.push(`- 台账变更：${changes.join('；')}`);
      if(ledger.rejected?.length)section.push(`- 被拒绝的台账操作：${ledger.rejected.join('；')}`);
    }
    for(const step of result.steps.filter(s=>s.status!=='done'))section.push(`- ${step.companionName}${step.label?' · '+step.label:''}：${step.status}${step.error?' —— '+step.error:''}`);
    mkdirSync(dir,{recursive:true});
    appendFileSync(join(dir,'CHANGELOG.md'),'\n'+section.join('\n')+'\n','utf8');
    const committed=await this.commit(dir,`${workflow.name} · ${localTime(result.started)} · ${run.id}`);
    result.ledgerCommit=committed.ok?'ok':committed.error;
    if(!committed.ok)result.notes.push('台账已写入，但 git 提交失败：'+committed.error);
  }
  // The user's own edits: answer a PLAN proposal, rewrite PLAN.md, or rule on a claim.
  async edit(target,mount,raw){
    const dir=target.dir;let message='';
    if(raw.proposal){
      const list=this.proposals(target,mount),item=list.find(p=>p.id===raw.proposal.id&&p.status==='pending');if(!item)throw fail('这条 PLAN 提议已处理');
      if(raw.proposal.action==='accept'){
        const plan=text(raw.proposal.plan??item.plan,20000,'新 PLAN',true);
        writeFileSync(join(dir,'PLAN.md'),withNewline(plan),'utf8');item.status='accepted';message=`PLAN：接受 ${this.companionName(item.by)||item.by} 的提议`;
      }else if(raw.proposal.action==='reject'){item.status='rejected';message=`PLAN：拒绝 ${this.companionName(item.by)||item.by} 的提议`;}
      else throw fail('提议操作无效');
      item.resolved=now();this.saveProposals(target,list);
    }else if(raw.plan!==undefined){
      const plan=text(raw.plan,20000,'PLAN',true);writeFileSync(join(dir,'PLAN.md'),withNewline(plan),'utf8');message='PLAN：用户修改';
    }else if(raw.claim){
      const book=this.read(target).claims,outcome=this.changeClaim(target.key,book,raw.claim,'user','user');
      if(outcome.error)throw fail(outcome.error);
      writeFileSync(join(dir,'claims.json'),JSON.stringify(book,null,2),'utf8');message=`命题：${outcome.change||'无变化'}（用户）`;
    }else throw fail('没有要修改的内容');
    if(message){const committed=await this.commit(dir,message);if(!committed.ok)throw fail('已写入，但 git 提交失败：'+committed.error);}
  }
}

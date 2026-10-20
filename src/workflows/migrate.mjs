// One-time import of the companions, rosters and routines older versions kept in the browser.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PROVIDERS } from '../providers.mjs';
import { now, sleep } from './common.mjs';

export async function migrateBrowserData(workflows,raw={}){
  const {store,db}=workflows;
  if(store.setting('workflows.migrated'))return {skipped:true,state:workflows.state()};
  const companions=Array.isArray(raw.companions)?raw.companions.slice(0,200):[],rooms=raw.rooms&&typeof raw.rooms==='object'?raw.rooms:{},routines=raw.routines&&typeof raw.routines==='object'?raw.routines:{};
  // A saved model the tool no longer lists is cleared, so the companion uses the tool's default.
  const models=new Map();
  const known=async(provider,model)=>{
    if(!model||!workflows.registry?.models)return true;
    if(!models.has(provider))models.set(provider,await Promise.race([workflows.registry.models(provider,workflows.defaultWorkspace).then(r=>new Set((r.models||[]).map(m=>m.id))).catch(()=>null),sleep(8000).then(()=>null)]));
    const list=models.get(provider);return !list||!list.size||list.has(model);
  };
  const report={companions:0,cleared:[],members:0,workflows:0,mounts:0};
  const duties=new Map(),created=new Map();
  for(const item of companions){
    if(!item||typeof item!=='object')continue;
    const provider=PROVIDERS[item.provider]?item.provider:'antigravity';
    const model=typeof item.model==='string'&&await known(provider,item.model)?item.model:'';
    if(item.model&&!model)report.cleared.push(`${item.name}：${item.model}`);
    try{
      const existing=typeof item.id==='string'?workflows.companion(item.id):null;
      const companion=existing||workflows.createCompanion({name:String(item.name||'伙伴').slice(0,40),avatar:String(item.avatar||'·').slice(0,16),role:String(item.role||'').slice(0,80),persona:String(item.persona||'').slice(0,4000),provider,model,effort:/^[\w-]{0,100}$/.test(item.effort||'')?item.effort||'':'',access:'readonly'},{id:item.id});
      if(!existing)report.companions++;
      created.set(item.id,companion.id);duties.set(companion.id,String(item.duty||'').slice(0,6000));
    }catch{}
  }
  for(const [groupId,ids] of Object.entries(rooms)){
    if(!db.prepare('SELECT id FROM groups WHERE id=?').get(groupId)||!Array.isArray(ids))continue;
    for(const id of ids)if(created.has(id)){workflows.addMember(groupId,created.get(id),{quiet:true});report.members++;}
  }
  for(const [groupId,routine] of Object.entries(routines)){
    const name=workflows.groupName(groupId),members=workflows.roomCompanions(groupId);
    if(!name||!routine||typeof routine.prompt!=='string'||!routine.prompt.trim()||!members.length)continue;
    try{
      const workflow=workflows.createWorkflow({name:`${name} · 每日分工`.slice(0,80),description:routine.prompt.trim().slice(0,4000),ledger:false,
        stages:[{name:'分工',positions:members.slice(0,8).map(c=>({name:(c.role||c.name).slice(0,60),task:duties.get(c.id)||`按你的角色（${c.role||c.name}）完成这项例行任务。`}))}]});
      report.workflows++;
      if(routine.enabled||routine.lastRunDate){
        const assignments={};workflow.stages[0].positions.forEach((p,i)=>{assignments[p.id]=members[i].id;});
        const workspace=typeof raw.workspace==='string'&&isAbsolute(raw.workspace)&&existsSync(raw.workspace)&&statSync(raw.workspace).isDirectory()?raw.workspace:workflows.defaultWorkspace;
        const chat=store.newChat({group_id:groupId,title:`${name} · 每日分工`,provider:members[0].provider,workspace});
        workflows.createMount(chat.id,{workflowId:workflow.id,enabled:false,trigger:{type:'daily',time:/^([01]\d|2[0-3]):[0-5]\d$/.test(routine.time)?routine.time:'15:15',days:[1,2,3,4,5,6,7]},missed:'skip',assignments});
        report.mounts++;
      }
    }catch{}
  }
  store.setSetting('workflows.migrated',{at:now(),...report});
  workflows.broadcast('migrated');workflows.broadcastRaw('refresh',{});
  return {report,state:workflows.state()};
}

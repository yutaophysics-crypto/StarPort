import {randomUUID,createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {mkdir,readdir,readFile,writeFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {directoryPath} from './folders.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const serialize=value=>JSON.stringify(value);
const digest=value=>createHash('sha256').update(typeof value==='string'?value:serialize(value)).digest('hex');
const same=(a,b)=>serialize(a)===serialize(b);
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!value.includes('\0');
const secret=value=>/(?:sk-[\w-]{16,}|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password|密码|access[_ -]?token)\s*[:=：]\s*\S{6,})/i.test(value);
const targetHash=row=>row?digest([row.kind,row.title,row.content,row.project_id]):null;
const inside=(parent,child)=>{const path=relative(parent,child);return !path||(!path.startsWith('..')&&!isAbsolute(path));};

// Each change is immutable and has explicit causal parents. No shared database,
// wall-clock winner, overwrite of another device's file, or provider credential.
export class MemorySync {
  constructor(store,{dataDir,onChange=()=>{},interval=15000}={}){
    this.store=store;this.db=store.db;this.dataDir=dataDir;this.onChange=onChange;
    this.device=randomUUID();this.name=hostname();this.lastRun=null;this.error='';this.waiting=0;
    this.tail=Promise.resolve();this.timer=null;this.interval=interval;this.closed=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_sync_changes (
      space TEXT NOT NULL,id TEXT NOT NULL,entity TEXT NOT NULL,payload TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(space,id));
      CREATE INDEX IF NOT EXISTS memory_sync_changes_entity ON memory_sync_changes(space,entity);
      CREATE TABLE IF NOT EXISTS memory_sync_entities (
      space TEXT NOT NULL,entity TEXT NOT NULL,local_id TEXT,snapshot TEXT NOT NULL,heads TEXT NOT NULL,
      conflict INTEGER NOT NULL DEFAULT 0,issue TEXT NOT NULL DEFAULT '',PRIMARY KEY(space,entity));
      CREATE TABLE IF NOT EXISTS memory_sync_candidate_bases (id TEXT PRIMARY KEY,hash TEXT);`);
    store.memorySync=this;
  }
  config(){return this.store.setting('memory.sync',{enabled:false,folder:'',space:null});}
  locked(fn){const job=this.tail.then(fn);this.tail=job.catch(()=>{});return job;}
  start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>this.sync().catch(()=>{}),this.interval);this.timer.unref();if(this.config().enabled)this.sync().catch(()=>{});}
  async close(){this.closed=true;clearInterval(this.timer);this.timer=null;await this.tail;}
  status(){
    const config=this.config(),states=config.space?this.states():[];
    return {...config,device:this.device,deviceName:this.name,lastRun:this.lastRun,error:this.error,waiting:this.waiting,epoch:this.store.memory.epoch,
      pending:config.space?Number(this.db.prepare('SELECT count(*) AS n FROM memory_sync_changes WHERE space=? AND published=0').get(config.space).n):0,
      conflicts:states.filter(row=>row.conflict).map(row=>({key:row.entity,issue:row.issue,
        versions:this.heads(row.entity).map(op=>({id:op.id,deviceName:op.deviceName,created:op.created,value:op.value}))}))};
  }
  states(){return this.db.prepare('SELECT * FROM memory_sync_entities WHERE space=?').all(this.config().space);}
  state(key){return this.db.prepare('SELECT * FROM memory_sync_entities WHERE space=? AND entity=?').get(this.config().space,key);}
  save(key,localId,value,heads,conflict=false,issue=''){
    this.db.prepare(`INSERT INTO memory_sync_entities VALUES(?,?,?,?,?,?,?) ON CONFLICT(space,entity)
      DO UPDATE SET local_id=excluded.local_id,snapshot=excluded.snapshot,heads=excluded.heads,conflict=excluded.conflict,issue=excluded.issue`)
      .run(this.config().space,key,localId,serialize(value),serialize(heads),conflict?1:0,issue);
  }
  blockedMemoryIds(){return new Set(this.states().filter(row=>row.conflict&&row.entity.startsWith('memory:')).map(row=>row.local_id));}
  blockedScope(scope){return !!this.state('instructions:'+scope)?.conflict;}
  rememberCandidate(row){if(!row.supersedes)return;const target=this.db.prepare('SELECT * FROM shared_memories WHERE id=?').get(row.supersedes);
    this.db.prepare('INSERT OR IGNORE INTO memory_sync_candidate_bases VALUES(?,?)').run(row.id,target?.revision===row.target_revision?targetHash(target):null);}
  memoryValue(row){
    if(!row)return null;this.rememberCandidate(row);
    return {kind:row.kind,title:row.title,content:row.content,status:row.status,project_id:row.project_id||null,
      source_provider:row.source_provider,source_title:row.source_title,evidence:row.evidence,origin:row.origin,
      supersedes:row.supersedes?(this.states().find(state=>state.entity.startsWith('memory:')&&state.local_id===row.supersedes)?.entity.slice(7)||row.supersedes):null,target_base:row.supersedes?this.db.prepare('SELECT hash FROM memory_sync_candidate_bases WHERE id=?').get(row.id)?.hash||null:null};
  }
  localValue(key,localId){
    if(key.startsWith('memory:'))return this.memoryValue(this.db.prepare('SELECT * FROM shared_memories WHERE id=?').get(localId||key.slice(7)));
    if(key.startsWith('project:')){const row=this.store.project(key.slice(8));return row?{name:row.name}:null;}
    const row=this.db.prepare('SELECT content FROM context_instructions WHERE scope=?').get(key.slice(13));return row?{content:row.content}:null;
  }
  validateValue(key,value){
    if(key.startsWith('project:')){if(!uuid.test(key.slice(8)))throw fail('同步项目格式无效');if(value===null)return null;if(!value||!text(value.name,120)||!value.name.trim()||Object.keys(value).length!==1)throw fail('同步项目格式无效');return {name:value.name};}
    if(key.startsWith('instructions:')){
      const scope=key.slice(13);if(scope!=='global'&&(!scope.startsWith('project:')||!uuid.test(scope.slice(8))))throw fail('同步范围无效');
      if(value===null)return null;if(!text(value?.content,12000)||Object.keys(value).length!==1||secret(value.content))throw fail('同步偏好格式无效');return {content:value.content};
    }
    if(!key.startsWith('memory:')||!uuid.test(key.slice(7)))throw fail('同步条目标识无效');if(value===null)return null;
    if(!value||!['fact','preference','goal','value','knowledge'].includes(value.kind)||!['candidate','confirmed'].includes(value.status)
      ||!text(value.title,120)||!value.title.trim()||!text(value.content,2000)||!value.content.trim()||!text(value.evidence,1500)
      ||!text(value.origin,100)||value.project_id!==null&&!uuid.test(value.project_id)
      ||value.source_provider!==null&&!['codex','claude','antigravity','deepseek'].includes(value.source_provider)
      ||value.source_title!==null&&!text(value.source_title,300)||value.supersedes!==null&&!uuid.test(value.supersedes)
      ||value.supersedes&&value.status!=='candidate'||value.target_base!==null&&!/^[a-f0-9]{64}$/.test(value.target_base)
      ||secret(value.title+'\n'+value.content+'\n'+value.evidence))throw fail('同步记忆格式无效');
    const clean={kind:value.kind,title:value.title,content:value.content,status:value.status,project_id:value.project_id,
      source_provider:value.source_provider,source_title:value.source_title,evidence:value.evidence,origin:value.origin,
      supersedes:value.supersedes,target_base:value.target_base};if(!same(value,clean))throw fail('同步记忆包含未知字段');return clean;
  }
  validate(op){
    if(!op||op.version!==1||op.space!==this.config().space||!uuid.test(op.id)||!uuid.test(op.device)||!text(op.deviceName,120)
      ||!text(op.created,40)||!Number.isFinite(Date.parse(op.created))||typeof op.key!=='string'||!Array.isArray(op.parents)
      ||op.parents.length>256||new Set(op.parents).size!==op.parents.length||op.parents.some(id=>!uuid.test(id)||id===op.id))throw fail('同步变更格式无效');
    const value=this.validateValue(op.key,op.value),clean={version:1,space:op.space,id:op.id,device:op.device,deviceName:op.deviceName,
      created:op.created,key:op.key,parents:op.parents,value};if(op.checksum!==digest(clean)||!same(op,{...clean,checksum:op.checksum}))throw fail('同步变更校验失败');return op;
  }
  ops(key){return this.db.prepare('SELECT payload FROM memory_sync_changes WHERE space=? AND entity=?').all(this.config().space,key).map(row=>JSON.parse(row.payload));}
  heads(key){const ops=this.ops(key),parents=new Set(ops.flatMap(op=>op.parents));return ops.filter(op=>!parents.has(op.id));}
  enqueue(key,value,parents,localId){
    value=this.validateValue(key,value);const op={version:1,space:this.config().space,id:randomUUID(),device:this.device,
      deviceName:this.name.slice(0,120),created:new Date().toISOString(),key,parents,value};op.checksum=digest(op);
    this.db.prepare('INSERT INTO memory_sync_changes VALUES(?,?,?,?,0)').run(op.space,op.id,key,serialize(op));
    this.save(key,localId,value,[op.id]);return op;
  }
  captureTracked(){
    for(const row of this.states()){
      const value=this.localValue(row.entity,row.local_id);
      if(!same(value,JSON.parse(row.snapshot)))this.enqueue(row.entity,value,JSON.parse(row.heads),row.local_id);
    }
  }
  captureNew(){
    const states=this.states(),memoryIds=new Set(states.filter(row=>row.entity.startsWith('memory:')).map(row=>row.local_id));
    for(const project of this.store.projects())if(!this.state('project:'+project.id))this.enqueue('project:'+project.id,{name:project.name},[],project.id);
    for(const row of this.db.prepare('SELECT * FROM shared_memories').all())if(!memoryIds.has(row.id))this.enqueue('memory:'+row.id,this.memoryValue(row),[],row.id);
    for(const row of this.db.prepare('SELECT * FROM context_instructions').all())if(!this.state('instructions:'+row.scope))this.enqueue('instructions:'+row.scope,{content:row.content},[],row.scope);
  }
  async configure(data){return this.locked(async()=>{
    if(data?.enabled!==true&&data?.enabled!==false||Object.keys(data).some(key=>!['enabled','folder'].includes(key)))throw fail('同步设置无效');
    if(!data.enabled){try{this.captureIfEnabled();}catch{}this.store.setSetting('memory.sync',{...this.config(),enabled:false});this.error='';this.onChange();return this.status();}
    const folder=await directoryPath(data.folder),canonical=await realpath(folder);
    if(this.dataDir&&inside(await realpath(this.dataDir),canonical))throw fail('请选择星港数据库目录以外的同步文件夹');
    const root=join(canonical,'StarportMemory');await mkdir(root,{recursive:true});
    if((await lstat(root)).isSymbolicLink())throw fail('同步子目录不能是符号链接');
    const marker=join(root,'space.json');let manifest;
    try{manifest=JSON.parse(await readFile(marker,'utf8'));}catch(error){
      if(error.code!=='ENOENT')throw fail('同步空间标识无法读取，请等待目录同步完成');
      manifest={format:'starport-memory-space',version:1,id:randomUUID()};
      try{await writeFile(marker,serialize(manifest),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;manifest=JSON.parse(await readFile(marker,'utf8'));}
    }
    if(manifest?.format!=='starport-memory-space'||manifest.version!==1||!uuid.test(manifest.id))throw fail('这不是有效的星港记忆同步空间');
    this.captureIfEnabled();this.store.setSetting('memory.sync',{enabled:true,folder:canonical,space:manifest.id});
    await this.run();this.onChange();return this.status();
  });}
  captureIfEnabled(){if(this.config().enabled)this.store.memory.atomic(()=>{this.captureTracked();this.captureNew();});}
  sync(){return this.locked(()=>this.run());}
  async flush(root){
    const directory=join(root,'changes');await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw fail('同步变更目录不能是符号链接');
    for(const row of this.db.prepare('SELECT * FROM memory_sync_changes WHERE space=? AND published=0').all(this.config().space)){
      const final=join(directory,row.id+'.json');let present;
      try{present=await readFile(final,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
      if(present!==undefined){if(present!==row.payload)throw fail('同步变更文件已改变，未覆盖原文件');}
      else{
        const temporary=join(directory,row.id+'.'+randomUUID()+'.tmp');
        try{await writeFile(temporary,row.payload,{flag:'wx',mode:0o600,flush:true});await rename(temporary,final);}finally{await unlink(temporary).catch(()=>{});}
      }
      this.db.prepare('UPDATE memory_sync_changes SET published=1 WHERE space=? AND id=?').run(row.space,row.id);
    }
  }
  async pull(root){
    const directory=join(root,'changes'),entries=await readdir(directory,{withFileTypes:true});if(entries.length>100000)throw fail('同步变更过多，请先备份并整理同步空间');
    const incoming=[];let waiting=0;
    for(const entry of entries){
      if(entry.name.endsWith('.tmp'))continue;
      if(!entry.isFile()||!entry.name.endsWith('.json')||!uuid.test(entry.name.slice(0,-5))){waiting++;continue;}
      if(this.db.prepare('SELECT id FROM memory_sync_changes WHERE space=? AND id=?').get(this.config().space,entry.name.slice(0,-5)))continue;
      try{
        const file=join(directory,entry.name),info=await lstat(file);if(!info.isFile()||info.size>32768)throw fail('同步变更文件无效');
        const op=this.validate(JSON.parse(await readFile(file,'utf8')));if(op.id+'.json'!==entry.name)throw fail('同步文件标识无效');incoming.push(op);
      }catch{waiting++;}
    }
    // Check again after I/O: a running assistant can have proposed a memory.
    this.store.memory.atomic(()=>{this.captureTracked();for(const op of incoming)this.db.prepare('INSERT OR IGNORE INTO memory_sync_changes VALUES(?,?,?,?,1)').run(op.space,op.id,op.key,serialize(op));});
    this.waiting=waiting;
  }
  apply(key,value,localId,created){
    if(key.startsWith('project:')){
      const id=key.slice(8);
      if(value===null){
        // Project deletion is not permission to cascade into another device's
        // conversations or independently-created memories. Defer until clear.
        if(this.db.prepare('SELECT id FROM chats WHERE project_id=? LIMIT 1').get(id))throw fail('项目仍有关联对话，请先检查这些对话');
        if(this.db.prepare('SELECT id FROM shared_memories WHERE project_id=? LIMIT 1').get(id))throw fail('项目仍有记忆，等待对应记忆的删除同步');
        this.db.prepare('DELETE FROM context_instructions WHERE scope=?').run('project:'+id);
        this.db.prepare('DELETE FROM projects WHERE id=?').run(id);return id;
      }
      this.db.prepare(`INSERT INTO projects(id,name,workspace,group_id,created) VALUES(?,?,'',NULL,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(id,value.name,created);return id;
    }
    if(key.startsWith('instructions:')){
      const scope=key.slice(13);if(value===null){this.db.prepare('DELETE FROM context_instructions WHERE scope=?').run(scope);return scope;}
      if(scope!=='global'&&!this.store.project(scope.slice(8)))throw fail('等待项目记忆同步');
      this.db.prepare(`INSERT INTO context_instructions(scope,content,revision,pending_content,updated) VALUES(?,?,1,NULL,?)
        ON CONFLICT(scope) DO UPDATE SET content=excluded.content,revision=revision+1,updated=excluded.updated`).run(scope,value?.content||'',created);return scope;
    }
    const id=localId||key.slice(7),old=this.db.prepare('SELECT * FROM shared_memories WHERE id=?').get(id);
    if(value===null){
      const values=[old,...this.ops(key).map(op=>op.value)].filter(Boolean);
      for(const row of values)this.db.prepare('INSERT OR IGNORE INTO rejected_memory_hashes VALUES(?,?)').run(digest(row.project_id?serialize([row.project_id,row.content]):row.content.trim()),created);
      this.db.prepare('DELETE FROM shared_memories WHERE id=?').run(id);return id;
    }
    if(value.project_id&&!this.store.project(value.project_id))throw fail('等待项目记忆同步');
    const contentDigest=digest(value.project_id?serialize([value.project_id,value.content]):value.content.trim());
    if(this.db.prepare('SELECT id FROM shared_memories WHERE digest=? AND id<>?').get(contentDigest,id))throw fail('另一条本地记忆已有相同内容，请核对后修改或删除重复条目');
    const targetId=value.supersedes?(this.state('memory:'+value.supersedes)?.local_id||value.supersedes):null;
    const target=targetId?this.db.prepare('SELECT * FROM shared_memories WHERE id=?').get(targetId):null;
    const revision=value.supersedes&&value.target_base===targetHash(target)?target?.revision||0:value.supersedes?0:null;
    const keepSource=old&&old.evidence===value.evidence&&old.source_title===value.source_title&&old.source_provider===value.source_provider;
    this.db.prepare(`INSERT INTO shared_memories(id,kind,title,content,status,revision,digest,source_chat,source_message,
      source_provider,source_title,evidence,origin,created,updated,project_id,supersedes,target_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,content=excluded.content,status=excluded.status,
      revision=excluded.revision,digest=excluded.digest,source_chat=excluded.source_chat,source_message=excluded.source_message,
      source_provider=excluded.source_provider,source_title=excluded.source_title,evidence=excluded.evidence,origin=excluded.origin,
      updated=excluded.updated,project_id=excluded.project_id,supersedes=excluded.supersedes,target_revision=excluded.target_revision`)
      .run(id,value.kind,value.title,value.content,value.status,(old?.revision||0)+1,contentDigest,keepSource?old.source_chat:null,
        keepSource?old.source_message:null,value.source_provider,value.source_title,value.evidence,value.origin,old?.created||created,
        created,value.project_id,targetId,revision);
    if(value.supersedes)this.db.prepare('INSERT OR REPLACE INTO memory_sync_candidate_bases VALUES(?,?)').run(id,value.target_base);
    return id;
  }
  reconcile(){
    const keys=this.db.prepare('SELECT DISTINCT entity FROM memory_sync_changes WHERE space=? ORDER BY entity').all(this.config().space).map(row=>row.entity);
    const order=key=>key.startsWith('project:')?0:key.startsWith('memory:')?(this.heads(key).some(op=>op.value?.supersedes)?2:1):3;
    keys.sort((a,b)=>order(a)-order(b));
    let changed=false;
    for(const key of keys){
      const ops=this.ops(key),known=new Map(ops.map(op=>[op.id,op])),ready=new Set(),remaining=new Map(),children=new Map(),queue=[];
      for(const op of ops){remaining.set(op.id,op.parents.length);if(!op.parents.length)queue.push(op.id);
        for(const parent of op.parents){if(!children.has(parent))children.set(parent,[]);children.get(parent).push(op.id);}}
      for(let index=0;index<queue.length;index++){const id=queue[index];ready.add(id);for(const child of children.get(id)||[]){remaining.set(child,remaining.get(child)-1);if(!remaining.get(child))queue.push(child);}}
      if(ready.size!==ops.length){this.waiting++;const state=this.state(key);if(state)this.save(key,state.local_id,JSON.parse(state.snapshot),JSON.parse(state.heads),true,'等待完整的同步变更');continue;}
      if(ops.some(op=>op.parents.some(id=>!known.has(id))))continue;
      let heads=this.heads(key),state=this.state(key),localId=state?.local_id||key.slice(key.indexOf(':')+1);
      if(!state&&key.startsWith('memory:')&&heads[0]?.value){
        const value=heads[0].value,contentDigest=digest(value.project_id?serialize([value.project_id,value.content]):value.content.trim());
        localId=this.db.prepare('SELECT id FROM shared_memories WHERE digest=?').get(contentDigest)?.id||localId;
        // One local row must never be captured under two remote identities.
        if(this.states().some(row=>row.entity!==key&&row.entity.startsWith('memory:')&&row.local_id===localId))localId=key.slice(7);
      }
      const local=this.localValue(key,localId);
      if(!state&&local!==null&&!heads.some(op=>same(op.value,local))){this.enqueue(key,local,[],localId);heads=this.heads(key);state=this.state(key);}
      // Equal concurrent values need no auto-generated merge. Keeping all heads
      // avoids two polling devices continually merging each other's merge.
      const conflict=heads.length>1&&!heads.every(op=>same(op.value,heads[0].value));
      const value=conflict?heads.some(op=>op.value===null)?null:local:heads[0].value;
      let issue=conflict?'不同电脑同时修改了这项内容，请选择保留版本':'';
      try{
        if((!conflict||value===null)&&!same(local,value))localId=this.apply(key,value,localId,heads[0].created);
      }catch(error){issue=error.message;}
      const previous=this.state(key),next=this.localValue(key,localId),blocked=conflict||!!issue;
      if(!previous||!same(JSON.parse(previous.heads),heads.map(op=>op.id))||previous.conflict!==Number(blocked)||previous.issue!==issue||!same(local,next))changed=true;
      this.save(key,localId,next,heads.map(op=>op.id),blocked,issue);
    }
    if(changed)this.store.memory.bump();return changed;
  }
  async run(){
    if(this.closed||!this.config().enabled)return this.status();
    const before=serialize(this.status());
    try{
      const config=this.config(),root=join(config.folder,'StarportMemory'),manifest=JSON.parse(await readFile(join(root,'space.json'),'utf8'));
      if(manifest.format!=='starport-memory-space'||manifest.version!==1||manifest.id!==config.space)throw fail('同步空间标识已改变，暂停同步；请核对文件夹后重新连接');
      if((await lstat(root)).isSymbolicLink())throw fail('同步子目录不能是符号链接');
      this.store.memory.atomic(()=>this.captureTracked());await this.flush(root);await this.pull(root);
      this.store.memory.atomic(()=>{this.reconcile();this.captureNew();this.reconcile();});await this.flush(root);
      this.lastRun=new Date().toISOString();this.error='';
    }catch(error){this.error=error.code?'同步文件夹暂时无法访问，保留本地内容并稍后重试':error.message;}
    if(before!==serialize(this.status()))this.onChange();return this.status();
  }
  resolve(key,{version,heads}){return this.locked(async()=>{
    if(!this.config().enabled)throw fail('请先开启记忆同步');this.store.memory.atomic(()=>this.captureTracked());
    const state=this.state(key),current=this.heads(key);if(!state?.conflict||!Array.isArray(heads)||!same([...heads].sort(),current.map(op=>op.id).sort()))throw fail('冲突已改变，请刷新后重新选择',409);
    const chosen=current.find(op=>op.id===version);if(!chosen)throw fail('请选择一个现有版本');
    this.store.memory.atomic(()=>{const localId=this.apply(key,chosen.value,state.local_id,new Date().toISOString());this.enqueue(key,chosen.value,current.map(op=>op.id),localId);this.store.memory.bump();});
    await this.run();return this.status();
  });}
}

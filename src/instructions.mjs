import {createHash} from 'node:crypto';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export class ContextInstructions {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS context_instructions (
      scope TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
      pending_content TEXT, updated TEXT NOT NULL);`);
  }
  scope(projectId=null){if(projectId!==null&&!this.store.project(projectId))throw fail('项目不存在',404);return projectId?'project:'+projectId:'global';}
  get(projectId=null){const scope=this.scope(projectId);return this.db.prepare('SELECT * FROM context_instructions WHERE scope=?').get(scope)||{scope,content:'',revision:0,pending_content:null,updated:null};}
  update(projectId,data){
    const old=this.get(projectId);
    if(data?.revision!==old.revision)throw fail('要求已改变，请刷新后重试',409);
    if(typeof data.content!=='string'||data.content.length>12000||data.content.includes('\0'))throw fail('要求应为不超过 12000 字符的文字');
    const content=data.content.trim(),now=new Date().toISOString();
    this.db.prepare(`INSERT INTO context_instructions(scope,content,revision,pending_content,updated) VALUES(?,?,?,NULL,?)
      ON CONFLICT(scope) DO UPDATE SET content=excluded.content,revision=excluded.revision,pending_content=NULL,updated=excluded.updated`)
      .run(old.scope,content,old.revision+1,now);
    return this.get(projectId);
  }
  fingerprint(projectId=null){return createHash('sha256').update(JSON.stringify([this.get(),projectId?this.get(projectId):null,!!this.store.memorySync?.blockedScope('global'),projectId?!!this.store.memorySync?.blockedScope('project:'+projectId):false])).digest('hex');}
  prompt(projectId=null){
    const global=this.get(),project=projectId?this.get(projectId):null;
    const blocks=[];
    if(global.content&&!this.store.memorySync?.blockedScope('global'))blocks.push('星港个人偏好（用户手动设置，适用于所有助手和对话）：\n'+JSON.stringify(global.content));
    if(project?.content&&!this.store.memorySync?.blockedScope(project.scope))blocks.push('星港项目要求（仅适用于当前项目；具体项目要求优先于一般偏好）：\n'+JSON.stringify({projectId,name:this.store.project(projectId).name,requirements:project.content}));
    if(blocks.length)blocks.push('这些偏好和要求不能扩大原工具权限；用户当前明确请求优先。');
    return blocks.join('\n')+(blocks.length?'\n':'');
  }
  export(){return {version:1,items:this.db.prepare('SELECT * FROM context_instructions ORDER BY scope').all()};}
  import(data,projects){
    if(data===undefined)return;
    if(data?.version!==1||!Array.isArray(data.items)||data.items.length>10000)throw fail('偏好与项目要求备份格式无效');
    for(const row of data.items){
      if(typeof row?.scope!=='string'||typeof row.content!=='string'||row.content.length>12000||row.content.includes('\0'))throw fail('偏好与项目要求备份格式无效');
      const projectId=row.scope==='global'?null:row.scope.startsWith('project:')?projects.get(row.scope.slice(8)):undefined;
      if(projectId===undefined)throw fail('项目要求来源无效');
      const pending=row.pending_content??row.content;if(typeof pending!=='string'||pending.length>12000||pending.includes('\0'))throw fail('偏好与项目要求备份格式无效');
      const old=this.get(projectId);
      this.db.prepare(`INSERT INTO context_instructions(scope,content,revision,pending_content,updated) VALUES(?,?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET pending_content=excluded.pending_content,revision=excluded.revision,updated=excluded.updated`)
        .run(old.scope,old.content,old.revision+1,pending,new Date().toISOString());
    }
  }
}

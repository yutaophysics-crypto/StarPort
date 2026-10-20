import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, delimiter, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { exec, childEnvironment } from './process.mjs';
import { ModelCatalog } from './models.mjs';
import { CODEX_PERMISSIONS, codexPermissionSelection } from './codex-permissions.mjs';
import { UsageReader } from './usage.mjs';
import { deepseekDesktopRuntime } from './deepseek-desktop.mjs';

const magi = JSON.parse(readFileSync(new URL('./magi-hosts.json', import.meta.url), 'utf8'));
const select = (key, label, values, value = '') => ({ key, label, type: 'select', default: value,
  choices: values.map(v => Array.isArray(v) ? { value: v[0], label: v[1], ...(v[2]?{description:v[2]}:{}) } : { value: v, label: v || '跟随工具默认' }) });
const model = { key: 'model', label: '模型', type: 'text', default: '', placeholder: '留空使用工具当前默认模型' };
const effort = {key:'effort',label:'思考强度',type:'effort',default:''};
export const PROVIDERS = {
  codex: { id: 'codex', name: 'Codex', color: '#367a65', initials: 'CX', transport: 'App Server',
    description: '原生目标模式、流式对话和权限审批', source: 'https://learn.chatgpt.com/docs/app-server',
    fields: [model, effort,
      select('mode','工作方式',[['chat','对话'],['plan','计划模式'],['goal','目标模式']],'chat'),
      {key:'permissionMode',label:'权限',type:'select',default:'ask',choices:CODEX_PERMISSIONS},
      { key:'objective', label:'目标', type:'textarea', default:'', when:{mode:'goal'}, placeholder:'留空时用本次消息作为目标' },
      { key:'tokenBudget',label:'目标 Token 预算',type:'number',default:'',when:{mode:'goal'},placeholder:'可选；留空不设置预算' }],
    notes: '目标模式使用 Codex 原生目标状态；本应用在目标仍有效时继续推进。关闭服务会停止执行，目标和记录会保留。' },
  claude: { id:'claude', name:magi.hosts.claude.label, color:'#b27354', initials:'CL', transport:'Claude Code CLI',
    description:'计划模式、思考强度和独立工作树', source:'https://code.claude.com/docs/en/headless',
    fields:[model,effort,
      select('permissionMode','工作方式',[
        ['default','请求批准'],['plan','计划 / 只读分析'],['dontAsk','普通对话（需审批的操作拒绝）'],['acceptEdits','允许编辑文件'],
        ['auto','自动审核','由 Claude Code 原生审核操作，减少批准请求；可用性取决于原工具的账号、模型和设置。'],
        ['bypassPermissions','跳过权限审批','大部分工具操作直接执行，可访问工作目录外的文件；系统权限和原工具的明确限制仍然生效。']
      ],'plan'),
      {key:'worktree',label:'使用独立 Git 工作树',type:'checkbox',default:false}],
    notes:'使用 Claude Code 已有登录。需要审批的操作可在星港中批准或拒绝；原工具的权限规则仍然生效。普通对话（需审批的操作拒绝）会直接拒绝此类操作。' },
  antigravity:{id:'antigravity',name:'Antigravity',color:'#5078c9',initials:'AG',transport:'Antigravity CLI',
    description:'模型、思考强度和 Agent 选择',source:'https://antigravity.google/docs/cli/headless/',
    fields:[model,effort,
      select('mode','工作方式',[['auto','对话'],['accept-edits','允许编辑工作目录'],['plan','计划模式']],'auto'),
      select('permissionMode','工具权限',[['allow-all','允许所有工具'],['configured','遵循原工具权限']],'allow-all'),
      {key:'agent',label:'Agent',type:'text',default:'',placeholder:'可选，使用已有 Agent 名称'},
      {key:'sandbox',label:'启用终端沙箱',type:'checkbox',default:true}],
    notes:'允许所有工具会自动批准命令执行和文件读写；终端沙箱独立控制。选择遵循原工具权限时，无法弹窗审批的操作会被拒绝。' },
  deepseek:{id:'deepseek',name:'DeepSeek Harness',color:'#5b68b5',initials:'DS',transport:'Native SDK JSON-RPC',
    description:'原生 Harness 会话、工具过程和结果',source:'https://github.com/deepseek-ai/deepseek-harness',
    fields:[model,{key:'provider',label:'模型服务',type:'text',default:'',placeholder:'留空使用 Harness 默认服务'},
      effort],
    notes:'通过官方 SDK 使用 Harness 的模型和工具。当前发布版每轮创建独立执行会话，由本地对话记录补充上下文；不把其他工具的内部状态伪装成原生会话。'}
};

export function validateOptions(provider, raw = {}) {
  if (!PROVIDERS[provider] || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工具选项无效');
  const result = {};
  for (const field of PROVIDERS[provider].fields) {
    let value = raw[field.key] ?? field.default;
    if(field.type==='effort'&&(typeof value!=='string'||value.length>100||value&&!/^[a-zA-Z0-9_-]+$/.test(value)))throw new Error('思考强度格式无效');
    if (field.type === 'select' && !field.choices.some(c => c.value === value)) throw new Error(`${field.label}选项无效`);
    if (['text','textarea'].includes(field.type) && (typeof value !== 'string' || value.length > (field.key === 'objective' ? 4000 : 500))) throw new Error(`${field.label}格式无效`);
    if (field.type === 'checkbox' && typeof value !== 'boolean') throw new Error(`${field.label}格式无效`);
    if (field.type === 'number' && value !== '') {
      value = Number(value); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field.label}应为正整数`);
    }
    result[field.key] = value;
  }
  if(provider==='codex')Object.assign(result,codexPermissionSelection(raw));
  return result;
}

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['.exe'] : ['']) {
      const candidate = join(dir.replace(/^"|"$/g,''), name + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
export function discover(root, id, override = {}) {
  if (override.command) {
    const command = isAbsolute(override.command) ? override.command : onPath(override.command);
    if(id==='deepseek'&&command){
      const desktop=deepseekDesktopRuntime(command);
      if(desktop){
        const args=override.prefixArgs||[],samePath=(a,b)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
        const nativeEntry=args[0]===desktop.prefixArgs[0]&&typeof args[1]==='string'&&samePath(args[1],desktop.prefixArgs[1]);
        return {...desktop,prefixArgs:nativeEntry?args:[...desktop.prefixArgs,...args]};
      }
    }
    return command && existsSync(command) ? { command, prefixArgs: override.prefixArgs || [] } : null;
  }
  const home = homedir(), local = process.env.LOCALAPPDATA || join(home,'AppData','Local');
  let command = onPath(id === 'antigravity' ? 'agy' : id === 'deepseek' ? 'dsh' : id);
  if (command) return { command, prefixArgs: [] };
  const candidates = id === 'claude' ? [join(home,'.local','bin','claude.exe')] : id === 'antigravity' ?
    [join(local,'agy','bin','agy.exe'),join(root,'.runtime','antigravity','agy.exe')] : [];
  if (id === 'codex') {
    const dir = join(local,'OpenAI','Codex','bin');
    if (existsSync(dir)) for (const entry of readdirSync(dir).reverse()) candidates.push(join(dir,entry,'codex.exe'));
  }
  command = candidates.find(existsSync);
  if (command) return { command, prefixArgs: [] };
  if (id === 'deepseek') {
    if(process.platform==='win32')for(const dir of (process.env.PATH||'').split(delimiter)){
      const desktop=deepseekDesktopRuntime(join(dir.replace(/^"|"$/g,''),'dsh.cmd'));
      if(desktop)return desktop;
    }
    const entry = join(root,'.runtime','deepseek','node_modules','@deepseek-ai','dsh','lib','bin.js');
    if (existsSync(entry)) return { command: process.execPath, prefixArgs:[entry] };
  }
  return null;
}

export function runtimeFingerprint(runtime) {
  if(!runtime)return JSON.stringify(null);
  return JSON.stringify({...runtime,command:process.platform==='win32'?runtime.command.toLowerCase():runtime.command});
}

export function claudeCapabilities(version){
  const match=version.match(/\b(\d+)\.(\d+)\.(\d+)\b/),parts=match?.slice(1).map(Number);
  return {nativeNoPrompts:!!parts&&(parts[0]>2||parts[0]===2&&(parts[1]>1||parts[1]===1&&parts[2]>=259))};
}

export class ProviderRegistry {
  constructor(root, dataDir, store) { this.root=root; this.dataDir=dataDir; this.store=store; this.cache=new Map();this.modelCatalog=new ModelCatalog(root);this.usageReader=new UsageReader(root); }
  usage(id,cwd,options={}){return this.usageReader.get(id,this.resolve(id),cwd,options);}
  models(id,cwd,refresh=false){return this.modelCatalog.get(id,this.resolve(id),cwd,refresh);}
  resolve(id) {
    if (!PROVIDERS[id]) throw new Error('未知工具');
    return discover(this.root,id,this.store.setting('providers',{})[id]);
  }
  verification(id,runtime=this.resolve(id)) {
    const saved=this.store.setting('verification',{})[id];
    if(saved&&runtime)try{if(runtimeFingerprint(JSON.parse(saved.fingerprint))===runtimeFingerprint(runtime))return saved;}catch{}
    return null;
  }
  // Read saved call outcomes for live updates without launching any CLI probes.
  verifications(){return Object.fromEntries(Object.keys(PROVIDERS).map(id=>[id,this.verification(id)]).filter(([,value])=>value));}
  async probe(id, refresh = false) {
    const found = this.resolve(id), cached = this.cache.get(id), fingerprint = runtimeFingerprint(found);
    if (!refresh && cached?.fingerprint === fingerprint) return cached.value;
    let value = { ...PROVIDERS[id], installed:!!found, command:found?.command || '', prefixArgs:found?.prefixArgs || [],
      status:found ? 'installed' : 'missing', statusLabel:found ? '已安装 · 连接待验证' : '未找到程序', version:'', nativeGoal:false,nativeAutoReview:false,nativePlan:['claude','antigravity'].includes(id) };
    if (found) {
      try {
        const result = await exec(found.command,[...found.prefixArgs,'--version'],{timeout:12000,maxBuffer:200000,windowsHide:true,env:childEnvironment(found.env)});
        value.version = result.stdout.trim().split('\n').slice(-1)[0].slice(0,150);
        if(id==='claude'){
          Object.assign(value,claudeCapabilities(value.version));
          try{
            const result=await exec(found.command,[...found.prefixArgs,'auth','status'],{timeout:12000,maxBuffer:200000,windowsHide:true,env:childEnvironment()});
            const auth=JSON.parse(result.stdout);
            if(typeof auth.loggedIn==='boolean'){
              value.loggedIn=auth.loggedIn;
              value.statusLabel=auth.loggedIn?'已登录 · 实际调用待验证':'Claude Code 尚未登录';
            }
          }catch(error){
            // CLI exits nonzero when logged out. Older releases may not expose auth status.
            try{if(JSON.parse(error.stdout).loggedIn===false){value.loggedIn=false;value.statusLabel='Claude Code 尚未登录';}}catch{}
          }
        }
        if (id === 'codex') {
          const dir = join(this.dataDir,'schema'); mkdirSync(dir,{recursive:true});
          await exec(found.command,[...found.prefixArgs,'app-server','generate-json-schema','--experimental','--out',dir],{timeout:15000,maxBuffer:200000,windowsHide:true});
          value.nativeGoal = existsSync(join(dir,'v2','ThreadGoalSetParams.json'));
          value.nativePlan=existsSync(join(dir,'v2','CollaborationModeListResponse.json'));
          value.nativeAutoReview=['ThreadStartParams.json','ThreadResumeParams.json','TurnStartParams.json'].every(file=>{
            try{return JSON.parse(readFileSync(join(dir,'v2',file),'utf8')).definitions?.ApprovalsReviewer?.enum?.includes('auto_review')===true;}catch{return false;}
          });
          if (!value.nativeGoal) value.fields=value.fields.map(f => f.key==='mode' ? {...f,choices:f.choices.filter(c=>c.value!=='goal')} : f);
          if (!value.nativePlan) value.fields=value.fields.map(f => f.key==='mode' ? {...f,choices:f.choices.filter(c=>c.value!=='plan')} : f);
        }
      } catch(e) { value.status='incompatible';value.statusLabel='程序检查失败'; value.error=String(e.message).slice(0,600); }
    }
    const verified=this.verification(id,found);if(verified)value.verification=verified;
    this.cache.set(id,{fingerprint,value}); return value;
  }
  async list(refresh = false) { return Promise.all(Object.keys(PROVIDERS).map(id=>this.probe(id,refresh))); }
  record(id,ok,error='') {
    const all=this.store.setting('verification',{}); all[id]={ok,error,date:new Date().toISOString(),revision:(all[id]?.revision||0)+1,fingerprint:runtimeFingerprint(this.resolve(id))};
    this.store.setSetting('verification',all); this.cache.delete(id);
  }
  configure(id, config) {
    if (!PROVIDERS[id] || typeof config.command!=='string' || config.command.length>2000 || !Array.isArray(config.prefixArgs) || config.prefixArgs.some(x=>typeof x!=='string'||x.length>2000)) throw new Error('程序路径或前置参数无效');
    const all=this.store.setting('providers',{}); all[id]={command:config.command,prefixArgs:config.prefixArgs};
    this.store.setSetting('providers',all);this.cache.delete(id);
  }
}

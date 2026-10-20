import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { connectCodex } from './adapters/codex.mjs';
import { exec, childEnvironment } from './process.mjs';
import { claudeModels } from './claude-models.mjs';
import { effortChoices } from './effort.mjs';
import { isDeepseekDesktop, deepseekDesktopMetadata } from './deepseek-desktop.mjs';

export function parseAntigravityModels(stdout) {
  return stdout.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).flatMap(line=>{
    const match=/^([\w][\w.:/-]*)\t+(.+)$/.exec(line.trim());
    return match?[{id:match[1],label:match[2].trim()}]:[];
  });
}

export async function codexModels(runtime,cwd) {
  const rpc=await connectCodex(runtime,cwd);
  try {
    const models=[],seen=new Set();let cursor;
    do {
      const page=await rpc.request('model/list',{limit:100,includeHidden:false,...cursor?{cursor}:{}},20000);
      for(const model of page.data||[])if(!model.hidden)models.push({id:model.model||model.id,label:model.displayName||model.model||model.id,
        effort:Array.isArray(model.supportedReasoningEfforts)?effortChoices(model.supportedReasoningEfforts.map(e=>({value:e.reasoningEffort,description:e.description})),{defaultLevel:model.defaultReasoningEffort,labels:{xhigh:'Extra high'}}):null});
      cursor=page.nextCursor;
      if(cursor&&seen.has(cursor))throw new Error('Repeated model cursor');
      if(cursor)seen.add(cursor);
      if(seen.size>20)throw new Error('Model catalog is too large');
    }while(cursor);
    return {models,source:'native'};
  }finally{await rpc.close();}
}

export function deepseekConfiguredModels(settings={},bundled=[]) {
  const models=[],add=(m,provider)=>{if(typeof m?.id==='string')models.push({id:m.id,label:m.name||m.id,provider});};
  for(const model of settings['llm-deepseek']?.models??bundled)add(model,'deepseek-official');
  for(const [provider,config] of Object.entries(settings['llm-pi-ai']?.providers||{}))
    for(const model of config.models||[])add(model,provider);
  const saved=settings['agent-default-model'];
  if(saved?.model&&saved?.provider&&!models.some(m=>m.id===saved.model&&m.provider===saved.provider))add({id:saved.model},saved.provider);
  return models;
}

async function deepseekModels(runtime,root) {
  const entry=runtime.prefixArgs.find(arg=>/\.[cm]?js$/i.test(arg))||join(root,'.runtime/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const require=createRequire(entry);
  const yaml=await import(pathToFileURL(require.resolve('js-yaml')).href);
  let settings={};
  try{settings=yaml.load(await readFile(join(process.env.DSH_HOME||join(homedir(),'.dsh'),'settings.yaml'),'utf8'))||{};}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const adapter=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
  const connection=adapter.resolveAdapterOptions(settings['llm-deepseek']||{});
  const native=new adapter.DeepSeekAdapter({options:()=>connection});
  const models=deepseekConfiguredModels(settings,connection.models);
  for(const model of models){
    if(model.provider==='deepseek-official'){
      const resolved=await native.resolveModel(model.provider,model.id),reasoning=resolved.reasoning;
      model.effort=reasoning?effortChoices(reasoning.efforts.map(e=>({value:e.id,label:e.name,description:e.description})),{defaultLevel:reasoning.defaultEffort}):effortChoices([]);
    }else{
      const configured=settings['llm-pi-ai']?.providers?.[model.provider]?.models?.find(m=>m.id===model.id);
      // An explicit gateway profile is authoritative. Missing metadata is unknown,
      // not proof that a gateway accepts another provider's reasoning levels.
      model.effort=configured?.reasoningEfforts===false?effortChoices([]):configured?.reasoningEfforts?
        effortChoices(Object.keys(configured.reasoningEfforts),{source:'configured'}):null;
    }
  }
  return {models,source:'configured'};
}

export async function loadModels(id,runtime,cwd,root) {
  if(id==='claude')return claudeModels(runtime,cwd);
  if(!runtime)return {models:[],source:'unavailable'};
  if(id==='codex')return codexModels(runtime,cwd);
  if(id==='antigravity'){
    const result=await exec(runtime.command,[...runtime.prefixArgs,'models'],{cwd,timeout:30000,maxBuffer:2*1024*1024,windowsHide:true,env:childEnvironment()});
    return {models:parseAntigravityModels(result.stdout),source:'native',effort:effortChoices(['low','medium','high'],{source:'cli'})};
  }
  if(id==='deepseek')return isDeepseekDesktop(runtime)?deepseekDesktopMetadata(runtime,cwd):deepseekModels(runtime,root);
  throw new Error('Unknown provider');
}

// Coalesce requests: SSE refreshes and multiple tabs should not start duplicate CLIs.
export class ModelCatalog {
  constructor(root,loader=loadModels){this.root=root;this.loader=loader;this.cache=new Map();}
  async get(id,runtime,cwd,refresh=false){
    const key=JSON.stringify([id,runtime,cwd]),cached=this.cache.get(key);
    if(cached?.pending||(!refresh&&cached&&Date.now()<cached.expires))return cached.promise;
    if(this.cache.size>=64)for(const [old,value]of this.cache)if(!value.pending){this.cache.delete(old);break;}
    const entry={pending:true,expires:0};
    entry.promise=Promise.resolve().then(()=>this.loader(id,runtime,cwd,this.root)).then(result=>{
      const seen=new Set();result.models=result.models.filter(model=>{
        const identity=JSON.stringify([model.provider||'',model.id]);
        if(typeof model.id!=='string'||!model.id||model.id.length>500||seen.has(identity))return false;
        seen.add(identity);return true;
      });
      return result.models.length?result:{models:[],source:'unavailable'};
    }).catch(()=>({models:[],source:'unavailable'})).then(result=>{
      entry.pending=false;entry.expires=Date.now()+(['unavailable','aliases'].includes(result.source)?30000:5*60000);return result;
    });
    this.cache.set(key,entry);return entry.promise;
  }
}

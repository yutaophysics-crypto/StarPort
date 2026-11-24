import { Context } from 'cordis';
import { readdir, stat } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PromptParts } from './prompt-parts.mjs';

// Modules in src/plugins run on Cordis (https://github.com/cordiverse/cordis): each exports name, inject
// and apply(ctx), and whatever apply registers through ctx.effect is undone when the plugin unloads.
// So an edited plugin is swapped in place while conversations keep running; a copy that fails to import
// or start leaves the previous one in service. Only the plugin file itself is imported again: modules it
// imports keep their first copy, and Node holds every imported copy in memory until the server restarts.
export const PLUGIN_DIR=fileURLToPath(new URL('./plugins/',import.meta.url));
const CODE_ROOT=fileURLToPath(new URL('..',import.meta.url)),ACTIVE=2;

// Whether code the host cannot swap (the rest of src, scripts, dependencies) changed after `since`.
export function coreChangedSince(since,{root=CODE_ROOT,skip=PLUGIN_DIR}={}){
  const newer=path=>{
    let info;try{info=statSync(path);}catch{return false;}
    if(!info.isDirectory())return info.mtimeMs>since;
    return resolve(path)!==resolve(skip)&&readdirSync(path).some(name=>newer(join(path,name)));
  };
  return ['src','scripts','package.json','package-lock.json'].some(name=>newer(join(root,name)));
}

export class PluginHost{
  constructor({dir=PLUGIN_DIR,services={}}={}){
    this.dir=dir;this.ctx=new Context();this.routes=new Map();this.loaded=new Map();this.copies=0;
    // routes and prompts are the host's own: what a plugin serves, and what it adds to a turn (prompt-parts.mjs).
    for(const[name,value]of Object.entries({prompts:new PromptParts(),...services}))this.ctx.provide(name,value);
    this.ctx.provide('routes',{add:(path,handler)=>{
      if(this.routes.has(path))throw Error(`路由 ${path} 已被占用`);
      this.routes.set(path,handler);
      return()=>{if(this.routes.get(path)===handler)this.routes.delete(path);};
    }});
    this.queue=Promise.resolve();this.reload();
  }
  // Loads new and edited files and unloads removed ones; running plugins whose file is unchanged stay as they are.
  // Calls run one at a time, and requests wait for the one in progress instead of meeting a plugin mid-swap.
  reload(){
    const run=this.queue.then(()=>this.sync()).catch(error=>({reloaded:[],removed:[],failed:[{file:basename(this.dir),error:error.message}]}));
    this.queue=run;return run;
  }
  async sync(){
    const files=new Map(),reloaded=[],removed=[],failed=[];
    let entries=[];try{entries=await readdir(this.dir,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const entry of entries.sort((a,b)=>a.name<b.name?-1:1))if(entry.isFile()&&entry.name.endsWith('.mjs')){const file=join(this.dir,entry.name);files.set(file,(await stat(file)).mtimeMs);}
    for(const[file,loaded]of this.loaded)if(!files.has(file)){await loaded.fiber.dispose();this.loaded.delete(file);removed.push(loaded.name);}
    for(const[file,mtime]of files){
      if(this.loaded.get(file)?.mtime===mtime)continue;
      try{reloaded.push(await this.swap(file,mtime));}catch(error){failed.push({file:basename(file),error:error.message});}
    }
    return {reloaded,removed,failed};
  }
  async swap(file,mtime){
    const module=await import(pathToFileURL(file).href+'?v='+ ++this.copies),old=this.loaded.get(file);
    if(old)await old.fiber.dispose();
    try{const fiber=await this.start(module);this.loaded.set(file,{name:fiber.name,module,fiber,mtime});return fiber.name;}
    catch(error){
      // The old copy keeps its old mtime, so the next reload tries the edited file again.
      if(old)try{this.loaded.set(file,{...old,fiber:await this.start(old.module)});}catch{this.loaded.delete(file);}
      throw error;
    }
  }
  async start(module){
    const fiber=this.ctx.plugin(module);
    try{await fiber;}catch(error){await fiber.dispose();throw error;}
    // Every service is provided up front, so a plugin still waiting is asking for one that does not exist.
    if(fiber.state!==ACTIVE){await fiber.dispose();throw Error(`插件 ${fiber.name} 缺少依赖`);}
    return fiber;
  }
  // A route answers {status,data} as JSON, or {status,body,headers} for other content; request carries the URL.
  async handle(method,path,read,request={}){await this.queue;const route=this.routes.get(path);return route?route(method,read,request):null;}
  async close(){await this.queue;for(const loaded of this.loaded.values())await loaded.fiber.dispose();this.loaded.clear();}
}

// Executed by the installed Electron Node runtime so its ASAR packages resolve.
// Only public model configuration leaves this process; credentials stay in dsh.
const {readFile}=require('node:fs/promises');
const {join}=require('node:path');
const {homedir}=require('node:os');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');

async function metadata(entry) {
  const requireNative=createRequire(entry),load=name=>import(pathToFileURL(requireNative.resolve(name)).href);
  const yaml=await load('js-yaml');
  // Native profile expressions must never be evaluated by a metadata query.
  const schema=yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:()=>undefined}));
  const home=process.env.DSH_HOME||join(homedir(),'.dsh'),settings={};
  for(const profile of ['desktop','sdk']){
    let source;
    try{source=await readFile(join(home,'profiles',profile,'cordis.patch.yml'),'utf8');}
    catch(error){if(error.code==='ENOENT')continue;throw error;}
    const entries=yaml.load(source,{schema});
    for(const item of Array.isArray(entries)?entries:[]){
      if(item?.disabled===true||!['agent-default-model','llm-deepseek','llm-deepseek-account'].includes(item?.id))continue;
      settings[item.id]={...settings[item.id],...item.config};
    }
  }
  const saved=settings['agent-default-model']||{},selection={
    provider:typeof saved.provider==='string'?saved.provider:'deepseek-official',
    model:typeof saved.model==='string'?saved.model:'deepseek-flash',
    ...typeof saved.reasoningEffort==='string'?{reasoningEffort:saved.reasoningEffort}:{}
  };
  const adapter=await load('@deepseek-ai/dsh-llm-deepseek');
  const provider=selection.provider;
  const config=provider==='deepseek-account'?settings['llm-deepseek-account']:settings['llm-deepseek'];
  const connection=adapter.resolveAdapterOptions(config||{}),native=new adapter.DeepSeekAdapter({options:()=>connection});
  const models=[];
  // Installed DeepSeek capabilities are advisory for the account's remote catalog.
  // Do not assign these capabilities to an unrelated gateway provider.
  if(['deepseek-official','deepseek-account'].includes(provider)){
    for(const model of connection.models){
      const resolved=await native.resolveModel(provider,model.id);
      models.push({id:model.id,label:model.name||model.id,provider,reasoning:resolved.reasoning});
    }
  }
  if(!models.some(model=>model.id===selection.model&&model.provider===provider))
    models.push({id:selection.model,label:selection.model,provider});
  return {selection,models,source:'configured'};
}

metadata(process.argv[2]).then(result=>{
  process.stdout.write(JSON.stringify(result),()=>process.exit(0));
},()=>{
  // Native loaders can include configuration values in errors. Keep them private.
  process.stderr.write('Unable to read DeepSeek desktop model configuration.\n',()=>process.exit(1));
});

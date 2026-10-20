// Isolated native smoke check: no production Store construction or chat changes.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { ProviderRegistry,validateOptions } from '../src/providers.mjs';
import { runCodex } from '../src/adapters/codex.mjs';
import { runCli } from '../src/adapters/cli.mjs';
const root=resolve(import.meta.dirname,'..'),data=join(root,'.data'),cwd=join(data,'context-smoke');mkdirSync(cwd,{recursive:true});
const db=new DatabaseSync(join(data,'hub.sqlite'),{readOnly:true});
const registry=new ProviderRegistry(root,data,{setting(key,fallback){const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}});
const results=[];
for(const provider of process.argv.slice(2)){
  const runtime=registry.resolve(provider),events=[],abort=new AbortController(),timer=setTimeout(()=>abort.abort(),60000);
  console.log(JSON.stringify({provider,runtime}));
  try{
    const options=validateOptions(provider,provider==='claude'?{permissionMode:'plan'}:{mode:'chat',sandbox:'read-only'});
    if(provider==='claude')options.nativeNoPrompts=true;
    await (provider==='codex'?runCodex:runCli)({provider,runtime,options,prompt:'Reply exactly CONTEXT_OK. Do not use tools or read any files.',cwd,signal:abort.signal,emit:e=>{if(['session','context','usage','replace','delta','tool'].includes(e.type))events.push(e);},setControl:()=>{}});
    const context=events.filter(e=>e.type==='context').at(-1)?.context;
    const result={provider,context,tools:events.filter(e=>e.type==='tool').length,reply:events.filter(e=>e.type==='replace').at(-1)?.text||events.filter(e=>e.type==='delta').map(e=>e.text).join('')};
    results.push(result);console.log(JSON.stringify(result));
  }catch(error){console.log(JSON.stringify({provider,error:error.message}));process.exitCode=1;}
  finally{clearTimeout(timer);}
}
db.close();writeFileSync(join(data,'context-smoke-results.json'),JSON.stringify(results,null,2));

import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { Store } from '../src/storage.mjs';
import { ProviderRegistry,validateOptions } from '../src/providers.mjs';
import { runCodex } from '../src/adapters/codex.mjs';
import { runCli } from '../src/adapters/cli.mjs';
import { runDeepseek } from '../src/adapters/deepseek.mjs';
const root=resolve(import.meta.dirname,'..'),data=join(root,'.data');mkdirSync(join(data,'smoke-workspace'),{recursive:true});
const store=new Store(join(data,'hub.sqlite')),registry=new ProviderRegistry(root,data,store);
const providers=process.argv.slice(2).length?process.argv.slice(2):['codex','antigravity','deepseek'];
const results=[];
for(const provider of providers){
  const abort=new AbortController(),events=[];let control;
  const timeout=setTimeout(()=>abort.abort(),90000);
  console.log(provider+': checking');
  try{
    const runtime=registry.resolve(provider);if(!runtime)throw new Error('程序未找到');
    const options=validateOptions(provider,{});
    const fn=provider==='codex'?runCodex:provider==='deepseek'?runDeepseek:runCli;
    await fn({provider,runtime,options,prompt:'这是一项连接测试。请只回复“连接成功”。不要调用任何工具、读取或修改文件。',cwd:join(data,'smoke-workspace'),signal:abort.signal,
      emit:event=>{if(['delta','replace','notice','session'].includes(event.type))events.push(event);},setControl:c=>control=c});
    const answer=events.filter(e=>e.type==='replace').at(-1)?.text||events.filter(e=>e.type==='delta').map(e=>e.text).join('');
    if(!answer.trim())throw new Error('连接完成但没有收到回答');
    registry.record(provider,true);results.push({provider,ok:true,answer});console.log(provider+': '+answer.slice(0,150));
  }catch(error){const message=abort.signal.aborted?'连接测试超过 90 秒，已停止。':error.message;registry.record(provider,false,message);results.push({provider,ok:false,error:message});console.log(provider+': '+message.slice(0,1600));}
  finally{clearTimeout(timeout);if(abort.signal.aborted)await control?.stop?.();}
}
writeFileSync(join(data,'live-check.json'),JSON.stringify(results,null,2));store.close();

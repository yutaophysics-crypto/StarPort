import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {effortChoices,validateEffort} from '../src/effort.mjs';
import {claudeModelCatalog,claudeAliases} from '../src/claude-models.mjs';
import {codexModels} from '../src/models.mjs';
import {cliArguments} from '../src/adapters/cli.mjs';
import {resolveDeepseekSelection} from '../src/adapters/deepseek.mjs';
import {Runner} from '../src/runner.mjs';
import {Store} from '../src/storage.mjs';
import {validateOptions} from '../src/providers.mjs';

const claude=()=>claudeModelCatalog([
  {value:'opus',resolvedModel:'claude-opus-5-5',supportedEffortLevels:['low','medium','high','xhigh','max']},
  {value:'sonnet',resolvedModel:'claude-sonnet-4-6',supportedEffortLevels:['low','medium','high','max']},
  {value:'haiku',resolvedModel:'claude-haiku-4-5-20251001'},
  {value:'custom',resolvedModel:'company-model',supportsEffort:true},
  {value:'capped',resolvedModel:'claude-opus-5-5',supportedEffortLevels:['low']}]);

test('Claude native efforts vary by model, retain caps and use Extra only as presentation',()=>{
  const catalog=claude(),[opus,sonnet,haiku,custom,capped]=catalog.models;
  assert.equal(opus.effort.defaultLevel,'medium');
  assert.equal(opus.effort.choices.find(c=>c.value==='xhigh').label,'Extra');
  assert.equal(sonnet.effort.defaultLevel,'high');assert.ok(!sonnet.effort.choices.some(c=>c.value==='xhigh'));
  assert.deepEqual(haiku.effort.choices,[]);assert.equal(custom.effort,null);assert.equal(capped.effort.defaultLevel,undefined);
  assert.ok(!catalog.models.find(m=>m.id==='opusplan').effort.choices.some(c=>c.value==='xhigh'));
  const args=cliArguments('claude',validateOptions('claude',{model:'opus',effort:'xhigh'}));
  assert.equal(args[args.indexOf('--effort')+1],'xhigh');assert.ok(!args.includes('Extra'));
  assert.doesNotThrow(()=>validateEffort(catalog,{model:'claude-opus-5-5',effort:'xhigh'}));
  assert.throws(()=>validateEffort(catalog,{model:'sonnet',effort:'xhigh'}),/不支持/);
  assert.throws(()=>validateEffort(catalog,{model:'haiku',effort:'high'}),/不支持/);
  assert.throws(()=>validateEffort(claudeAliases(),{model:'opus',effort:'high'}),/暂未确认/);
  assert.throws(()=>validateEffort(catalog,{model:'',effort:'high'}),/暂未确认/);
  assert.doesNotThrow(()=>validateEffort(catalog,{model:'haiku',effort:''}));
});

test('Codex catalogs retain per-model native defaults, descriptions and none without guessing max',async()=>{
  const catalog=await codexModels({command:process.execPath,prefixArgs:[resolve('tests/fixtures/models-rpc.mjs')]},process.cwd());
  assert.equal(catalog.models[0].effort.defaultLevel,'low');assert.equal(catalog.models[0].effort.choices[1].description,'Deep');
  assert.equal(catalog.models[1].effort.choices[0].value,'none');
  assert.throws(()=>validateEffort(catalog,{model:'first',effort:'max'}),/不支持/);
});

test('DeepSeek preserves explicit Off, scopes saved effort to provider and model, and disambiguates catalogs',()=>{
  const saved={provider:'a',model:'one',reasoningEffort:'max'};
  assert.equal(resolveDeepseekSelection({},saved).reasoningEffort,'max');
  assert.equal(resolveDeepseekSelection({model:'two'},saved).reasoningEffort,undefined);
  assert.equal(resolveDeepseekSelection({provider:'b'},saved).reasoningEffort,undefined);
  assert.equal(resolveDeepseekSelection({model:'two',effort:'off'},saved).reasoningEffort,'off');
  const catalog={models:[{id:'same',provider:'a',effort:effortChoices(['off','high'])},{id:'same',provider:'b',effort:effortChoices(['low'])}]};
  assert.doesNotThrow(()=>validateEffort(catalog,{provider:'a',model:'same',effort:'off'}));
  assert.throws(()=>validateEffort(catalog,{provider:'b',model:'same',effort:'off'}),/不支持/);
});

test('Runner rejects an invalid effort before history or model execution and passes valid wire values',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());let invoked=0,received;
  const registry={resolve:()=>({command:process.execPath,prefixArgs:[]}),probe:async()=>({}),models:async()=>claude(),record:()=>{}};
  const runner=new Runner(store,registry,()=>{},{claude:async({options})=>{invoked++;received=options.effort;}});
  const chat=store.newChat({provider:'claude',workspace:process.cwd(),options:{claude:{model:'sonnet',effort:'xhigh'}}});
  await assert.rejects(()=>runner.start(chat.id,'test'),/不支持/);assert.equal(invoked,0);assert.equal(store.messages(chat.id).length,0);assert.equal(runner.state(chat.id),null);
  store.updateChat(chat.id,{options:{claude:{...chat.options.claude,model:'opus'}}});
  await runner.start(chat.id,'test');await runner.active.get(chat.id)?.done;
  assert.equal(invoked,1);assert.equal(received,'xhigh');assert.equal(store.messages(chat.id).at(-1).status,'complete');
});

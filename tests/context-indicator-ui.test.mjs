import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function ui(api){
  const nodes={},all=node=>[node,...(node.children||[]).flatMap(all)];
  const el=(tag,props={},children=[])=>({tag,...props,children,style:{},classList:{toggle(){}},
    setAttribute(key,value){this[key]=value;},append(...values){this.children.push(...values);},replaceChildren(...values){this.children=values;},showModal(){this.open=true;},close(){this.open=false;}});
  nodes['#context-indicator']=el('button');nodes['#context-dialog']=el('dialog');let timer;
  const state={chat:null,workspace:'fictional-workspace',options:{model:'one'}};
  const context=vm.createContext({state,opts:()=>state.options,currentId:()=> 'codex',currentProvider:()=>({name:'Codex'}),
    el,$:selector=>nodes[selector]||all(nodes['#context-dialog']).find(n=>'#'+n.id===selector),
    t:(value,args)=>args?value.replace('{limits}',args.limits):value,i18n:{locale:'en'},toast:()=>{},api,document:{hidden:false},setInterval:callback=>timer=callback});
  vm.runInContext(readFileSync(new URL('../public/context.js',import.meta.url),'utf8'),context);
  return {state,nodes,all,context,tick:()=>timer(),binding:()=>JSON.stringify(['codex',state.workspace,false,state.options.model,''])};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('context details separate native usage, compaction and handoff, including with the previous backend',async()=>{
  let value,calls=[];const f=ui(async path=>{calls.push(path);return value;});
  f.state.chat={id:'fictional-chat',workspace:f.state.workspace};
  value={binding:f.binding(),status:'ready',usedTokens:203000,windowTokens:100000,percent:203,model:'test',
    modelWindowTokens:1000000,limits:{starportTokens:100000,modelWindowTokens:1000000,nativeAutoCompactTokens:300000,status:'ready'},limitSources:['starportTokens']};
  f.state.context=value;f.context.StarportContext.render();await flush();
  f.nodes['#context-indicator'].onclick();await flush();
  const text=f.all(f.nodes['#context-dialog']).map(n=>n.text||'').join('\n');
  assert.match(text,/模型窗口占用/);assert.match(text,/原工具自动压缩/);assert.match(text,/星港历史交接/);
  assert.match(text,/100,000 tokens/);assert.match(text,/1,000,000 tokens/);assert.match(text,/20.3%/);assert.doesNotMatch(text,/203%/);
  assert.ok(calls.some(p=>p.endsWith('refresh=1')));
  value={...value,windowTokens:50000,percent:406};f.tick();await flush();
  assert.equal(f.state.context.percent,406);assert.match(f.nodes['#context-indicator'].title,/20.3%/);
  assert.match(f.nodes['#context-indicator'].title,/1,000,000/);
  assert.ok(calls.at(-1).endsWith('refresh=1')); // Do not defer to a nearly-expired cache for another interval.
  assert.equal(f.nodes['#context-indicator'].children[0].children[0].style.width,'20.3%');
});

test('invalid native capacity shows diagnostics; missing capacity, zero and compacting remain distinct',async()=>{
  let value;const f=ui(async()=>value);f.state.chat={id:'fixture',workspace:f.state.workspace};
  const show=async data=>{value={binding:f.binding(),...data};f.state.context=value;f.context.StarportContext.render();await flush();};
  await show({status:'ready',usedTokens:250000,windowTokens:200000,percent:125});
  assert.match(f.nodes['#context-indicator'].title,/计量异常/);assert.doesNotMatch(f.nodes['#context-indicator'].title,/%/);
  assert.equal(f.nodes['#context-indicator'].children[0].children.length,0);
  f.nodes['#context-indicator'].onclick();await flush();
  const text=f.all(f.nodes['#context-dialog']).map(n=>n.text||'').join('\n');
  assert.match(text,/250,000 tokens/);assert.match(text,/200,000 tokens/);assert.match(text,/暂不显示百分比/);
  await show({status:'ready',usedTokens:50000,windowTokens:200000,modelWindowTokens:null,limits:{starportTokens:200000,nativeAutoCompactTokens:300000}});
  assert.match(f.nodes['#context-indicator'].title,/50,000 tokens/);assert.doesNotMatch(f.nodes['#context-indicator'].title,/%/);
  await show({status:'ready',usedTokens:0,modelWindowTokens:1000000});assert.match(f.nodes['#context-indicator'].title,/0%/);
  await show({status:'compacting',usedTokens:950000,modelWindowTokens:1000000});assert.match(f.nodes['#context-indicator'].title,/正在压缩/);
  await show({status:'waiting'});assert.match(f.nodes['#context-indicator'].title,/待获取/);
  await show({status:'unavailable'});assert.match(f.nodes['#context-indicator'].title,/暂不支持/);
});

test('a late limits reply cannot overwrite a different chat or model selection',async()=>{
  const pending=[];const f=ui(path=>new Promise(resolve=>pending.push({path,resolve})));
  f.state.chat={id:'first',workspace:f.state.workspace};f.context.StarportContext.render();await flush();
  const oldBinding=f.binding();f.state.options.model='two';f.context.StarportContext.render();await flush();
  pending[1].resolve({binding:f.binding(),status:'ready',usedTokens:10,windowTokens:100,percent:10});await flush();
  pending[0].resolve({binding:oldBinding,status:'ready',usedTokens:999,windowTokens:100,percent:999});await flush();
  assert.equal(f.state.context.percent,10);
  const request=f.context.StarportContext.refresh(true);await flush();f.state.chat={id:'second'};
  pending[2].resolve({binding:f.binding(),percent:777});await request;
  assert.equal(f.state.context.percent,10); // The next chat's view will fetch its own counters.
  pending.at(-1).resolve(null);await flush();
});

test('a slow refresh cannot roll back a more recent native usage event in the same chat',async()=>{
  let reply;const f=ui(()=>new Promise(resolve=>reply=resolve));
  f.state.chat={id:'fictional-chat',workspace:f.state.workspace};f.context.StarportContext.render();await flush();
  f.state.context={binding:f.binding(),status:'ready',usedTokens:200,windowTokens:1000,percent:20,updatedAt:'2026-01-01T00:00:02Z'};
  reply({binding:f.binding(),status:'ready',usedTokens:100,windowTokens:1000,percent:10,updatedAt:'2026-01-01T00:00:01Z'});await flush();
  assert.equal(f.state.context.usedTokens,200);
});

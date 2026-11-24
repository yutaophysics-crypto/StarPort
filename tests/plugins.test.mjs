import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.mjs';
import { PluginHost, coreChangedSince } from '../src/plugins.mjs';
import { DEFAULT_SNIPPETS } from '../src/plugins/prompt-snippets.mjs';

// Each write gets a later mtime, so a reload always sees the edit even on a coarse clock.
let clock=Math.floor(Date.now()/1000);
const write=(file,source)=>{writeFileSync(file,source);clock+=10;utimesSync(file,clock,clock);};
const plugin=(route,version,extra='')=>`export const name='demo';export const inject=['routes','store'];
export function apply(ctx){ctx.effect(()=>ctx.routes.add('${route}',()=>({data:{version:${version},tag:ctx.store.tag},status:200})));${extra}}`;
const get=async(host,path)=>(await host.handle('GET',path,async()=>({})))?.data??null;
const folder=()=>mkdtempSync(join(tmpdir(),'starport-plugins-'));

test('an edited plugin is swapped in place and the route its old copy registered goes away',async()=>{
  const dir=folder(),file=join(dir,'demo.mjs');
  try{
    write(file,plugin('/api/old',1));
    const host=new PluginHost({dir,services:{store:{tag:'store'}}});
    assert.deepEqual(await host.queue,{reloaded:['demo'],removed:[],failed:[]});
    assert.deepEqual(await get(host,'/api/old'),{version:1,tag:'store'});
    assert.deepEqual(await host.reload(),{reloaded:[],removed:[],failed:[]},'an unchanged file is left running');
    write(file,plugin('/api/new',2));
    assert.deepEqual((await host.reload()).reloaded,['demo']);
    assert.equal(await get(host,'/api/old'),null);
    assert.deepEqual(await get(host,'/api/new'),{version:2,tag:'store'});
    await host.close();
    assert.equal(host.routes.size,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a copy that fails to import or start leaves the running one in service, with nothing half registered',async()=>{
  const dir=folder(),file=join(dir,'demo.mjs');
  try{
    write(file,plugin('/api/demo',1));
    const host=new PluginHost({dir,services:{store:{tag:'store'}}});await host.queue;
    write(file,'export function apply(ctx){ ctx.effect(');
    let result=await host.reload();
    assert.equal(result.failed[0].file,'demo.mjs');assert.deepEqual(result.reloaded,[]);
    assert.deepEqual(await get(host,'/api/demo'),{version:1,tag:'store'});
    write(file,plugin('/api/half',2,"ctx.effect(()=>ctx.routes.add('/api/extra',()=>null));throw new Error('启动失败');"));
    result=await host.reload();
    assert.match(result.failed[0].error,/启动失败/);
    assert.deepEqual([...host.routes.keys()],['/api/demo']);
    assert.equal((await get(host,'/api/demo')).version,1);
    write(file,"export const name='demo';export const inject=['nowhere'];export function apply(){}");
    assert.match((await host.reload()).failed[0].error,/缺少依赖/);
    assert.equal((await get(host,'/api/demo')).version,1);
    write(file,plugin('/api/demo',3));
    assert.deepEqual(await host.reload(),{reloaded:['demo'],removed:[],failed:[]});
    assert.equal((await get(host,'/api/demo')).version,3);
    await host.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('plugins load, conflict and unload independently',async()=>{
  const dir=folder();
  try{
    write(join(dir,'a.mjs'),plugin('/api/shared',1).replace("'demo'","'a'"));
    write(join(dir,'b.mjs'),plugin('/api/shared',2).replace("'demo'","'b'"));
    write(join(dir,'c.mjs'),'this is not javascript');
    write(join(dir,'notes.txt'),'not a plugin');
    const host=new PluginHost({dir,services:{store:{}}}),first=await host.queue;
    assert.deepEqual(first.reloaded,['a']);
    assert.deepEqual(first.failed.map(row=>row.file),['b.mjs','c.mjs']);
    assert.match(first.failed[0].error,/已被占用/);
    assert.equal((await get(host,'/api/shared')).version,1);
    unlinkSync(join(dir,'a.mjs'));unlinkSync(join(dir,'c.mjs'));
    const next=await host.reload();
    assert.deepEqual([next.removed,next.reloaded,next.failed],[['a'],['b'],[]]);
    assert.equal((await get(host,'/api/shared')).version,2);
    await host.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a missing plugin folder loads nothing and every request falls through',async()=>{
  const host=new PluginHost({dir:join(tmpdir(),'starport-no-plugins-here'),services:{}});
  assert.deepEqual(await host.queue,{reloaded:[],removed:[],failed:[]});
  assert.equal(await get(host,'/api/prompt-snippets'),null);
});

test('the prompt snippets plugin serves its route through the host',async()=>{
  const host=new PluginHost({services:{store:new Store(':memory:')}});
  assert.deepEqual((await host.queue).failed,[]);
  assert.deepEqual((await get(host,'/api/prompt-snippets')).snippets,DEFAULT_SNIPPETS);
  const saved=await host.handle('PUT','/api/prompt-snippets',async()=>({snippets:[{id:'x',name:'验收',text:'逐条对照。'}]}));
  assert.deepEqual(saved.data.snippets,[{id:'x',name:'验收',text:'逐条对照。'}]);
  await assert.rejects(host.handle('DELETE','/api/prompt-snippets',async()=>({})),error=>error.status===405);
  await host.close();
});

test('only edits outside the plugin folder call for a restart',()=>{
  const root=folder();
  try{
    mkdirSync(join(root,'src','plugins'),{recursive:true});mkdirSync(join(root,'scripts'));
    const files=['src/server.mjs','src/plugins/demo.mjs','scripts/launch.mjs','package-lock.json'].map(name=>join(root,name));
    for(const file of files){writeFileSync(file,'');utimesSync(file,1000,1000);}
    const changed=()=>coreChangedSince(2_000_000,{root,skip:join(root,'src','plugins')});
    assert.equal(changed(),false);
    utimesSync(files[1],3000,3000);assert.equal(changed(),false);
    for(const file of [files[0],files[2],files[3]]){utimesSync(file,3000,3000);assert.equal(changed(),true);utimesSync(file,1000,1000);}
  }finally{rmSync(root,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {discover,ProviderRegistry} from '../src/providers.mjs';
import {Store} from '../src/storage.mjs';

test('Antigravity discovery prefers a user install over its bundled fallback with stale PATH, while preserving explicit choices',()=>{
  const root=mkdtempSync(join(tmpdir(),'starport-agy-discovery-'));
  const local=join(root,'user'),user=join(local,'agy','bin','agy.exe'),bundled=join(root,'.runtime','antigravity','agy.exe'),pathDir=join(root,'path'),onPath=join(pathDir,process.platform==='win32'?'agy.exe':'agy');
  const previousPath=process.env.PATH,previousLocal=process.env.LOCALAPPDATA;
  try{
    for(const path of [join(local,'agy','bin'),join(root,'.runtime','antigravity'),pathDir])mkdirSync(path,{recursive:true});
    for(const path of [user,bundled,onPath])writeFileSync(path,'fixture only');
    process.env.PATH='';process.env.LOCALAPPDATA=local;
    assert.equal(discover(root,'antigravity').command,user);
    assert.equal(discover(root,'antigravity',{command:bundled,prefixArgs:['configured']}).command,bundled);
    assert.deepEqual(discover(root,'antigravity',{command:bundled,prefixArgs:['configured']}).prefixArgs,['configured']);
    process.env.PATH=pathDir;assert.equal(discover(root,'antigravity').command,onPath);
    process.env.PATH='';unlinkSync(user);assert.equal(discover(root,'antigravity').command,bundled);
  }finally{
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousLocal===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previousLocal;
  }
});

test('live provider verification reads the latest saved result without CLI discovery and excludes changed runtimes',()=>{
  const store=new Store(':memory:'),registry=new ProviderRegistry(process.cwd(),process.cwd(),store);
  store.setSetting('providers',{antigravity:{command:process.execPath,prefixArgs:[]}});
  registry.probe=()=>{throw Error('Live verification must not probe a CLI');};
  try{
    registry.record('antigravity',false,'Old request failed');assert.equal(registry.verifications().antigravity.ok,false);
    registry.record('antigravity',true);assert.equal(registry.verifications().antigravity.ok,true);assert.equal(registry.verifications().antigravity.revision,2);
    registry.configure('antigravity',{command:process.execPath,prefixArgs:['changed']});assert.equal(registry.verifications().antigravity,undefined);
  }finally{store.close();}
});

test('a call that worked keeps the program check, a failed one checks again, and callers share one check',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'starport-provider-check-')),script=join(dir,'agy.mjs'),count=join(dir,'launches');
  writeFileSync(script,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(count)},'x');console.log('agy 9.9.9');`);
  const launches=()=>{try{return readFileSync(count,'utf8').length;}catch{return 0;}};
  const store=new Store(':memory:'),registry=new ProviderRegistry(process.cwd(),dir,store);
  try{
    registry.configure('antigravity',{command:process.execPath,prefixArgs:[script]});
    // The page's list and a turn's start asking at once.
    const [first,second]=await Promise.all([registry.probe('antigravity'),registry.probe('antigravity')]);
    assert.equal(launches(),1);assert.equal(first,second);assert.equal(first.version,'agy 9.9.9');
    registry.record('antigravity',true);
    const after=await registry.probe('antigravity');
    assert.equal(launches(),1);assert.equal(after.verification.ok,true);assert.equal(after.version,'agy 9.9.9');
    registry.record('antigravity',false,'Request failed');
    assert.equal((await registry.probe('antigravity')).verification.ok,false);assert.equal(launches(),2);
    await registry.probe('antigravity',true);assert.equal(launches(),3);
  }finally{store.close();}
});

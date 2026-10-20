import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
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

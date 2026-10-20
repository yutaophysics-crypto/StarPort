import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { acquireRestartLock } from '../scripts/restart-when-idle.mjs';

test('only one idle updater owns a data directory and an exited watcher is recoverable', async () => {
  const data=mkdtempSync(join(tmpdir(),'starport-restart-lock-'));
  const first=await acquireRestartLock(data);
  assert.equal(typeof first,'function');
  assert.equal(await acquireRestartLock(data),null);
  await first();assert.equal(existsSync(join(data,'idle-restart.lock')),false);
  writeFileSync(join(data,'idle-restart.lock'),JSON.stringify({pid:987654321,id:'exited'}));
  const recovered=await acquireRestartLock(data,{alive:()=>false});
  assert.equal(typeof recovered,'function');await recovered();
  // An owner must not delete a lock that another process has since acquired.
  const release=await acquireRestartLock(data);
  writeFileSync(join(data,'idle-restart.lock'),JSON.stringify({pid:process.pid,id:'other'}));
  await release();assert.equal(JSON.parse(readFileSync(join(data,'idle-restart.lock'))).id,'other');
});

function settingsFixture({active=2,pending=true,updated=false}={}) {
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:'',addEventListener(){}});return nodes.get(id);};
  const tabs=['general','context'].map(name=>({dataset:{settingsTab:name},setAttribute(){},getAttribute(){return 'settings-'+name;},addEventListener(){}}));
  const status=node('context-update-status');
  const dialog=node('settings-dialog');dialog.open=false;dialog.showModal=()=>{dialog.open=true;};dialog.querySelectorAll=()=>tabs;dialog.querySelector=()=>({scrollTop:0});
  const state={updated},timer={callback:null,cleared:0};
  const context=vm.createContext({document:{getElementById:node},location:{port:'3210'},t:(s,v={})=>s.replace('{count}',v.count),api:async p=>{if(p==='/context/settings'){if(!state.updated)throw new Error('没有这个接口');return {};}return {active:Array.from({length:active},(_,i)=>String(i))};},fetch:async p=>({ok:true,json:async()=>p==='/health'?{pid:123}:pending?{serverPid:123,state:'waiting-for-idle',at:new Date().toISOString()}:null}),setInterval:cb=>{timer.callback=cb;return 1;},clearInterval:()=>timer.cleared++,renderConnections(){},Date});
  vm.runInContext(readFileSync(new URL('../public/settings.js',import.meta.url),'utf8'),context);
  return {context,status,dialog,state,timer};
}
test('missing context API keeps a persistent queued-update explanation and detects recovery',async()=>{
  const {context,status,dialog,state,timer}=settingsFixture();
  context.StarportSettings.contextUnavailable();await new Promise(r=>setImmediate(r));
  assert.equal(dialog.open,true);assert.equal(status.hidden,false);
  assert.match(status.textContent,/还有 2 个对话任务/);assert.match(status.textContent,/自动更新/);
  state.updated=true;await timer.callback();assert.match(status.textContent,/后台已更新/);assert.ok(timer.cleared);
});
test('without a live updater heartbeat the UI does not claim an automatic restart is queued',async()=>{
  const {context,status}=settingsFixture({pending:false});
  context.StarportSettings.contextUnavailable();await new Promise(r=>setImmediate(r));
  assert.match(status.textContent,/关闭窗口不会停止后台任务/);assert.doesNotMatch(status.textContent,/会自动更新/);
});

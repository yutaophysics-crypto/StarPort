import test from 'node:test';
import assert from 'node:assert/strict';
import { canRestart,waitForIdle,readHubSnapshot } from '../scripts/restart-when-idle.mjs';
const root=process.cwd(),sample=active=>({health:{app:'harness-hub',root},state:{active}});
test('idle updater waits through busy runs and API failures; validates the server root',async()=>{
  assert.equal(canRestart(sample(['running']),root),false);assert.equal(canRestart(sample([]),root),true);
  assert.equal(canRestart({...sample([]),state:{active:[],collaboration:{jobId:'remote-agent-job'}}},root),false);
  assert.equal(canRestart({health:{app:'other',root},state:{active:[]}},root),false);
  assert.equal(canRestart({...sample([]),workflows:{running:[{id:'r_between_stages'}]}},root),false);
  assert.equal(canRestart({...sample([]),workflows:{running:[]}},root),true);assert.equal(canRestart({...sample([]),workflows:null},root),true);
  assert.equal(canRestart({...sample([]),profiles:{profiles:[{connection:{jobId:'account-job'}}]}},root),false);
  assert.equal(canRestart({...sample([]),profiles:{profiles:[{connection:{jobId:null}}]}},root),true);
  assert.equal(canRestart({...sample([]),profiles:{}},root),false);
  assert.equal(canRestart({...sample([]),workflows:{}},root),false);
  const sequence=[sample(['chamon']),sample([]),new Error('offline'),sample([]),sample(['current-coding-turn']),sample([]),sample([]),sample([])];
  let reads=0,waits=0;
  await waitForIdle(async()=>{const item=sequence[reads++];if(item instanceof Error)throw item;return item;},{root,wait:async()=>{waits++;},maxChecks:sequence.length});
  assert.equal(reads,8);assert.equal(waits,7);
});

test('idle snapshot includes every account worker and refuses to restart when its status cannot be checked',async t=>{
  let unavailable=false;
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  globalThis.fetch=async url=>{
    const path=new URL(url).pathname;
    const data=path==='/health'?{app:'harness-hub',root}:path==='/api/state'?{active:[]}:path==='/api/workflows/state'?{running:[]}:{profiles:[{connection:{jobId:'other-account-task'}}]};
    return {ok:!(unavailable&&path==='/api/collaboration/profiles'),status:unavailable&&path==='/api/collaboration/profiles'?503:200,
      json:async()=>data,text:async()=>'<meta name="hub-token" content="fixture-token">'};
  };
  const snapshot=await readHubSnapshot('http://127.0.0.1:9999',root);
  assert.equal(canRestart(snapshot,root),false);
  unavailable=true;await assert.rejects(readHubSnapshot('http://127.0.0.1:9999',root),/Cannot confirm account worker state/);
});

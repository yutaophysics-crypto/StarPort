// Verify the installed native goal API without starting a model turn.
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {discover} from '../src/providers.mjs';
import {connectCodex} from '../src/adapters/codex.mjs';
const root=resolve(import.meta.dirname,'..'),cwd=join(root,'.data/smoke-workspace');mkdirSync(cwd,{recursive:true});
const rpc=await connectCodex(discover(root,'codex'),cwd);let id;
try{
  const {thread}=await rpc.request('thread/start',{cwd,approvalPolicy:'on-request',sandbox:'read-only'});id=thread.id;
  const created=await rpc.request('thread/goal/set',{threadId:id,objective:'Harness Hub native API connectivity check',status:'active',tokenBudget:1000});
  assert.equal(created.goal.status,'active');assert.equal(created.goal.tokenBudget,1000);
  const paused=await rpc.request('thread/goal/set',{threadId:id,status:'paused'});assert.equal(paused.goal.status,'paused');
  const restored=await rpc.request('thread/goal/get',{threadId:id});assert.equal(restored.goal.objective,created.goal.objective);
  await rpc.request('thread/goal/clear',{threadId:id});assert.equal((await rpc.request('thread/goal/get',{threadId:id})).goal,null);
  const result={date:new Date().toISOString(),ok:true,operations:['set','pause','get','clear'],modelTurns:0};
  writeFileSync(join(root,'.data/goal-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{if(id)await rpc.request('thread/goal/clear',{threadId:id}).catch(()=>{});await rpc.close();}

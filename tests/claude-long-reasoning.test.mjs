import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {runClaude,CHECKPOINT_TOOL,LONG_REASONING_PROMPT} from '../src/adapters/claude.mjs';

const base={runtime:{command:process.execPath,prefixArgs:[]},prompt:'test',cwd:process.cwd(),setControl:()=>{}};

test('every Claude run can checkpoint long thinking, in any permission mode, without asking',async()=>{
  for(const permissionMode of ['plan','acceptEdits','default']){
    let seen,listed,called,decision;const events=[];
    const makeQuery=({prompt,options})=>({close(){},async *[Symbol.asyncIterator](){
      seen=options;await prompt[Symbol.asyncIterator]().next();
      const client=new Client({name:'long-reasoning-test',version:'1.0.0'}),server=options.mcpServers.starport_thinking.instance,[a,b]=InMemoryTransport.createLinkedPair();
      try{
        await server.connect(b);await client.connect(a);listed=(await client.listTools()).tools;
        called=await client.callTool({name:'checkpoint',arguments:{progress:'Derived the dispersion relation; next, check the k→0 limit.'}});
      }finally{await client.close();await server.close();}
      decision=await options.canUseTool(CHECKPOINT_TOOL,{progress:'stage one'},{signal:new AbortController().signal,toolUseID:'call1'});
      yield {type:'result',subtype:'success',session_id:'s',result:'done',usage:{}};
    }});
    await runClaude({...base,options:{permissionMode,effort:'max'},emit:event=>events.push(event),makeQuery});
    // The guidance explains the cap, names the tool and asks for staging rather than brevity.
    assert.equal(seen.systemPrompt.preset,'claude_code');assert.equal(seen.systemPrompt.append,LONG_REASONING_PROMPT);
    assert.match(LONG_REASONING_PROMPT,/128,000/);assert.ok(LONG_REASONING_PROMPT.includes(CHECKPOINT_TOOL));assert.match(LONG_REASONING_PROMPT,/instead of shortening/);
    assert.ok(seen.allowedTools.includes(CHECKPOINT_TOOL));
    assert.deepEqual(listed.map(item=>item.name),['checkpoint']);assert.equal(listed[0].annotations.readOnlyHint,true);
    assert.equal(called.isError,undefined);assert.match(called.content[0].text,/Continue your reasoning/);
    assert.equal(decision.behavior,'allow');assert.deepEqual(decision.updatedInput,{progress:'stage one'});
    assert.ok(!events.some(event=>event.type==='approval'),'a checkpoint never waits for approval');
  }
});

test('the checkpoint server sits beside caller-provided servers instead of replacing them',async()=>{
  let seen;const own={type:'stdio',command:process.execPath};
  const makeQuery=({options})=>{seen=options;return {close(){},async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',session_id:'s',result:'done',usage:{}};}};};
  await runClaude({...base,options:{permissionMode:'plan'},emit:()=>{},makeQuery,sdkOptions:{mcpServers:{own},allowedTools:['mcp__own__read']}});
  assert.equal(seen.mcpServers.own,own);assert.ok(seen.mcpServers.starport_thinking);
  assert.deepEqual(seen.allowedTools,['mcp__own__read',CHECKPOINT_TOOL]);
});

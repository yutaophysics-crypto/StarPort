import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const event=(method,params)=>send({method,params});
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='initialize')send({id:request.id,result:{}});
  if(request.method==='thread/start')send({id:request.id,result:{thread:{id:'parent'},model:'fixture'}});
  if(request.method==='thread/goal/get')send({id:request.id,result:{goal:null}});
  if(request.method==='turn/start'){
    send({id:request.id,result:{turn:{id:'parent-turn',status:'inProgress'}}});
    (async()=>{
      event('turn/started',{threadId:'parent',turn:{id:'parent-turn'}});
      event('item/completed',{threadId:'parent',turnId:'parent-turn',item:{id:'delegate',type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',senderThreadId:'parent',receiverThreadIds:['child'],prompt:'Review layout',agentsStates:{child:{status:'running'}}}});
      event('thread/started',{thread:{id:'child',source:{subAgent:{thread_spawn:{parent_thread_id:'parent',depth:1,agent_nickname:'Layout reviewer'}}}}});
      event('turn/started',{threadId:'child',turn:{id:'child-turn'}});
      event('item/completed',{threadId:'foreign',turnId:'foreign-turn',item:{id:'answer',type:'agentMessage',text:'FOREIGN_MESSAGE'}});
      event('item/completed',{threadId:'child',turnId:'child-turn',item:{id:'reason',type:'reasoning',summary:['Child public summary'],content:['PRIVATE_REASONING']}});
      event('item/completed',{threadId:'child',turnId:'child-turn',item:{id:'answer',type:'agentMessage',text:'Child result',phase:'final_answer'}});
      event('thread/tokenUsage/updated',{threadId:'child',tokenUsage:{total:{totalTokens:999999}}});
      event('turn/completed',{threadId:'child',turn:{id:'child-turn',status:'completed'}});
      await delay(80);
      event('item/completed',{threadId:'parent',turnId:'parent-turn',item:{id:'answer',type:'agentMessage',text:'Parent final answer',phase:'final_answer'}});
      event('turn/completed',{threadId:'parent',turn:{id:'parent-turn',status:'completed'}});
    })().catch(error=>{process.stderr.write(String(error));process.exit(1);});
  }
});

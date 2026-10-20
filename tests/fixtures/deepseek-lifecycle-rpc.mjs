import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const event=(sessionId,type,data)=>send({method:'session.event',params:{sessionId,event:{type,data}}});
const status=(sessionId,state)=>send({method:'session.status',params:{sessionId,status:state}});
const start=(id,turn)=>{status(id,'running');event(id,'turn/start',{turn});event(id,'step/start',{turn,step:1});};
const answer=(id,turn,text)=>event(id,'assistant/message',{turn,step:1,message:{id:id+':'+turn,content:[{type:'text',text}]}});
const end=(id,turn,reason='completed')=>{event(id,'step/end',{turn,step:1});event(id,'turn/end',{turn,reason:{kind:reason,...reason==='error'?{error:{message:'native parent failure'}}:{}}});status(id,'idle');};
const child=(parentId,id,mode='continuable')=>{
  send({method:'subagent.started',params:{parentSessionId:parentId,childSessionId:id}});
  event(parentId,'subagent/catalog',{version:0,childId:id,mode,label:'Task '+id});
  start(id,1);event(id,'subagent/descriptor',{mode});
};
const finished=(parentId,id,reason='completed')=>send({method:'subagent.finished',params:{parentSessionId:parentId,childSessionId:id,status:reason==='completed'?'ok':'error',stopReason:reason}});
const notice=(parentId,id)=>event(parentId,'user/message',{source:{kind:'subagent-settled',form:'notice',senderSessionId:id},content:[{type:'text',text:'Result from '+id}]});
let ready=false;
async function scenario(id,mode){
  start(id,1);
  if(mode==='no-children'){answer(id,1,'Final answer');ready=true;end(id,1);return;}
  child(id,'child');
  if(mode==='parent-error'){end(id,1,'error');return;}
  answer(id,1,'I will return when the children finish.');end(id,1);
  await delay(120);
  if(mode==='exit'){process.stderr.write('fixture connection lost');process.exit(7);}
  if(mode==='cancel')return;
  if(mode==='nested'){
    child('child','grandchild');answer('child',1,'Waiting for grandchild');end('child',1);
    await delay(100);
    answer('grandchild',1,'Grandchild result');end('grandchild',1);
    start('child',2);notice('child','grandchild');finished('child','grandchild');
    answer('child',2,'Collected grandchild');end('child',2);
  }else{
    answer('child',1,'Child result');end('child',1,mode==='child-error'?'error':'completed');
  }
  if(mode==='one-shot'){
    // This mode lacks the native continuable notice. A one-shot background
    // run's finished notification precedes asynchronous job delivery.
    event('child','subagent/descriptor',{mode:'one-shot'});
    finished(id,'child');await delay(100);start(id,2);
  }else{
    start(id,2);notice(id,'child');finished(id,'child',mode==='child-error'?'error':'completed');
  }
  if(mode==='resumed'){
    // Cold resume reuses a session id: no second subagent.started edge.
    status('child','running');event('child','turn/start',{turn:2});
    answer(id,2,'I asked the child to continue.');end(id,2);
    await delay(120);answer('child',2,'Follow-up result');end('child',2);
    start(id,3);notice(id,'child');finished(id,'child');
    await delay(80);answer(id,3,'Final answer including follow-up');ready=true;end(id,3);return;
  }
  // Finishing the last child does not finish a running parent's summary.
  await delay(80);answer(id,2,'Final answer including child results');ready=true;end(id,2);
}
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line),params=request.params||{};
  if(request.method==='initialize')send({id:request.id,result:{serverInfo:{name:'lifecycle-fixture'}}});
  if(request.method==='session/prompt'){
    send({id:request.id,result:{messageId:'prompt'}});
    scenario(params.sessionId,params.contentBlocks[0].text).catch(error=>{process.stderr.write(String(error));process.exit(8);});
  }
  if(request.method==='shutdown'){
    send({id:request.id,...ready?{result:{}}:{error:{code:-32000,message:'Premature shutdown: children or parent handoff still running'}}});
    process.stdout.end(()=>process.exit(0));
  }
});

import { createInterface } from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);if(!r.method)return;
  const result=data=>send({id:r.id,result:data});
  if(r.method==='initialize')result({userAgent:'test'});
  else if(r.method==='thread/start'||r.method==='thread/resume')result({thread:{id:'t1'},model:'m'});
  else if(r.method==='thread/goal/get')result({goal:null});
  else if(r.method==='thread/goal/set')result({goal:null});
  else if(r.method==='thread/goal/clear')result({});
  else if(r.method==='turn/start'){
    const id='turn-1';result({turn:{id}});
    send({method:'item/started',params:{threadId:'t1',item:{id:'a',type:'mcpToolCall',tool:'bash',server:'srv',arguments:{command:'dir'},status:'inProgress'}}});
    send({method:'item/completed',params:{threadId:'t1',item:{id:'a',type:'mcpToolCall',tool:'bash',server:'srv',arguments:{command:'dir'},status:'completed',result:{output:'ok'}}}});
    send({method:'item/started',params:{threadId:'t1',item:{id:'b',type:'subAgentActivity',agentPath:'planner',kind:'started'}}});
    send({method:'item/completed',params:{threadId:'t1',item:{id:'b',type:'subAgentActivity',agentPath:'planner',kind:'completed'}}});
    send({method:'item/agentMessage/delta',params:{threadId:'t1',itemId:'m',delta:'done'}});
    send({method:'turn/completed',params:{threadId:'t1',turn:{id,status:'completed'}}});
  }
});

import { createInterface } from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');let goal=null,turn=0;
const input=createInterface({input:process.stdin});
input.on('line',line=>{const r=JSON.parse(line);if(!r.method)return;
  const result=data=>send({id:r.id,result:data});
  if(r.method==='initialize')result({userAgent:'test'});
  else if(r.method==='thread/start'||r.method==='thread/resume')result({thread:{id:'native-thread'},model:'test-model'});
  else if(r.method==='thread/goal/get')result({goal});
  else if(r.method==='thread/goal/set'){goal={...goal,...r.params,objective:r.params.objective||goal?.objective,tokensUsed:10,timeUsedSeconds:1};result({goal});send({method:'thread/goal/updated',params:{threadId:'native-thread',goal}});}
  else if(r.method==='thread/goal/clear'){goal=null;result({});}
  else if(r.method==='turn/start'){
    turn++;const id='turn-'+turn;result({turn:{id}});
    setTimeout(()=>{
      send({method:'thread/tokenUsage/updated',params:{threadId:'native-thread',tokenUsage:{last:{totalTokens:1234},total:{totalTokens:999999},modelContextWindow:100000}}});
      send({method:'item/agentMessage/delta',params:{threadId:'native-thread',itemId:'item-'+turn,delta:turn===1?'第一步':'完成'}});
      if(goal&&turn===2){goal.status='complete';send({method:'thread/goal/updated',params:{threadId:'native-thread',goal}});}
      send({method:'turn/completed',params:{threadId:'native-thread',turn:{id,status:'completed'}}});
    },10);
  }else if(r.method==='turn/interrupt'){result({});send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn-'+turn,status:'interrupted'}}});}
});

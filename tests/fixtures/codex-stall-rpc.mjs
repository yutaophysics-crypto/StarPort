import {createInterface} from 'node:readline';
const scenario=process.argv[2],threadId='stall-thread',turnId='stall-turn';
const recovered=['recover','late'].includes(scenario);
let goalReads=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line),reply=result=>send({id:request.id,result});
  if(request.method==='initialize')reply({});
  else if(request.method==='thread/start')reply({thread:{id:threadId},model:'fixture-model'});
  else if(request.method==='thread/goal/get'){
    // 'late': after the recovered turn, the old turn's delta and completion
    // arrive before the next goal check is answered.
    if(scenario==='late'&&goalReads++){
      send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer',delta:'Partial answer'}});
      send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
      reply({goal:{status:'complete',objective:'Fixture'}});
    }else reply({goal:null});
  }
  else if(request.method==='thread/goal/set')reply({goal:{status:'active',objective:'Fixture'}});
  else if(request.method==='turn/start'){
    reply({turn:{id:turnId}});
    if(scenario==='late')return;
    setTimeout(()=>{
      send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer',delta:'Partial answer'}});
      if(scenario==='fatal')send({method:'error',params:{threadId,turnId,willRetry:false,error:{message:'Native stream failed',codexErrorInfo:'responseStreamDisconnected'}}});
      else if(scenario==='exit')process.exit(7);
      else if(scenario==='retry'){
        send({method:'error',params:{threadId,turnId,willRetry:true,error:{message:'Retrying connection'}}});
        setTimeout(finish,60);
      }else if(scenario==='active')setTimeout(finish,120);
      else if(scenario==='stale'){
        send({method:'turn/completed',params:{threadId,turn:{id:'old-turn',status:'completed'}}});
        setTimeout(finish,60);
      }
    },15);
  }else if(request.method==='thread/read')reply({thread:{id:threadId,turns:[{id:turnId,status:recovered?'completed':'inProgress',items:recovered?[{id:'answer',type:'agentMessage',text:'Recovered complete answer',phase:'final_answer'}]:[]}]}});
  else if(request.method==='turn/interrupt'){reply({});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted'}}});}
  function finish(){send({method:'item/completed',params:{threadId,turnId,item:{id:'answer',type:'agentMessage',text:'Complete answer',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});}
});

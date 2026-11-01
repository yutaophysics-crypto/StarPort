import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const [scenarioFile,logFile]=process.argv.slice(2);
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let threadId;
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);if(request.id==null)return;
  appendFileSync(logFile,JSON.stringify(request)+'\n');
  const scenario=readFileSync(scenarioFile,'utf8').trim(),p=request.params;
  const result=value=>send({id:request.id,result:value});
  const fail=message=>send({id:request.id,error:{code:-32000,message}});
  if(request.method==='initialize')result({});
  else if(['thread/resume','thread/start'].includes(request.method)){
    // Like Codex, a new thread is ephemeral only when asked; `no-ephemeral` is an older server.
    threadId=p.threadId||'fixture-'+randomUUID();result({thread:{id:threadId,ephemeral:request.method==='thread/start'&&p.ephemeral===true&&scenario!=='no-ephemeral'},model:'fixture-model'});
  }else if(request.method==='thread/goal/get')result({goal:null});
  else if(request.method==='turn/start'){
    result({turn:{id:'fixture-turn'}});
    // `slow` leaves time for the runner's status check to look at the turn.
    setTimeout(()=>{
      send({method:'item/agentMessage/delta',params:{threadId,itemId:'reply',delta:'Fixture answer'}});
      send({method:'turn/completed',params:{threadId,turn:{id:'fixture-turn',status:'completed'}}});
    },scenario==='slow'?300:5);
  }else fail('Unexpected method: '+request.method);
});

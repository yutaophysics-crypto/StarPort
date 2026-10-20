import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let thread,turn;
function complete(decision){
  send({method:'item/completed',params:{item:{type:'agentMessage',id:'answer',text:JSON.stringify({thread,turn,decision})}}});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});
}
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line);if(request.id==null)continue;
  if(request.id===9001){complete(request.result.decision);continue;}
  let result={};
  if(['thread/start','thread/resume'].includes(request.method)){
    thread={method:request.method,params:request.params};result={thread:{id:'native'},model:'test-model'};
  }
  if(request.method==='thread/goal/get')result={goal:null};
  if(request.method==='turn/start'){
    turn=request.params;send({id:request.id,result:{turn:{id:'turn'}}});
    if(turn.input[0].text==='ASK')send({id:9001,method:'item/commandExecution/requestApproval',params:{threadId:'native',command:'example command'}});
    else complete();
    continue;
  }
  send({id:request.id,result});
}

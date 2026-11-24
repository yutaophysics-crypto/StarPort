// agy that gives up mid-turn the way the real one does, without credentials or model requests.
// scenario.json in the working folder: {error, fails} — the first `fails` turns stop on `error`
// after some work; later turns (resumed with --conversation) finish. Every turn is logged.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const send=event=>console.log(JSON.stringify(event));
const {error,fails}=JSON.parse(readFileSync('scenario.json','utf8'));
const args=process.argv.slice(2),log=existsSync('turns.json')?JSON.parse(readFileSync('turns.json','utf8')):[];
for await (const line of createInterface({input:process.stdin})){
  const prompt=JSON.parse(line).message.content,turn=log.length+1,index=(turn-1)*10;
  log.push({args,prompt});writeFileSync('turns.json',JSON.stringify(log));
  const step=(offset,step_type,state='DONE',extra={})=>send({event:'step_update',step_update:{step_index:index+offset,step_type,state,...extra}});
  step(0,'user_input');
  if(turn<=fails){
    step(1,'agent_response','DONE',{text:'Started.'});
    step(2,'tool','DONE',{tool_name:'write_file'});
    step(3,'error_message');
    send({event:'result',result:{conversation_id:'continue-session',status:'ERROR',response:'Started.',error}});
    process.exitCode=1;
  }else{
    step(1,'agent_response','DONE',{text:'Delivered.'});
    send({event:'result',result:{conversation_id:'continue-session',status:'SUCCESS',response:'Delivered.'}});
  }
}

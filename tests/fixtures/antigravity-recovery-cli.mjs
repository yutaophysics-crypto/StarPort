// Reproduce agy's stale terminal error without credentials or model requests.
import { createInterface } from 'node:readline';
const send=event=>console.log(JSON.stringify(event));
const error='API error (attempt 1): request failed: Post "https://example.invalid/v1internal:streamGenerateContent?alt=sse": EOF';
let turn=0;
for await (const line of createInterface({input:process.stdin})){
  const prompt=JSON.parse(line).message.content.trim().split('\n').at(-1),index=turn++*10;
  const step=(offset,step_type,state,extra={})=>send({event:'step_update',step_update:{step_index:index+offset,step_type,state,...extra}});
  step(0,'user_input','DONE');
  step(1,'error_message','DONE');
  step(2,'agent_response','RUNNING',{text_delta:'Final '});
  step(2,'agent_response','RUNNING',{text_delta:prompt});
  if(prompt==='partial')step(2,'agent_response','ERROR');
  else step(2,'agent_response','DONE',{text:'Final '+prompt});
  if(prompt==='failed')step(3,'error_message','DONE');
  if(prompt==='cancel')await new Promise(()=>{});
  console.error(error);
  send({event:'result',result:{conversation_id:'recovery-session',status:'ERROR',response:'Final '+prompt,error}});
}
// Some agy versions also exit nonzero after reporting the stale error.
process.exitCode=1;

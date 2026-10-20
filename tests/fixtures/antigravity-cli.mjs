import {createInterface} from 'node:readline';
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
for await (const line of createInterface({input:process.stdin})){
  JSON.parse(line);
  console.log(JSON.stringify({event:'result',result:{conversation_id:'fixture-session',status:'SUCCESS',response:JSON.stringify({approved:args.includes('--dangerously-skip-permissions'),session:value('--conversation'),model:value('--model'),sandbox:args.includes('--sandbox')})}}));
}

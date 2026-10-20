// Reproduces scalar --settings precedence through the actual Agent SDK child.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const args=process.argv.slice(2),last=args.lastIndexOf('--settings'),source=args[last+1],settings=source.startsWith('{')?JSON.parse(source):JSON.parse(readFileSync(source,'utf8'));
if(!args.includes('--restricted')||args[args.lastIndexOf('--tools')+1]!==''||!args.includes('--no-session-persistence')||settings.disableAllHooks!==true)throw Error('Unsafe metadata arguments');
const send=response=>process.stdout.write(JSON.stringify(response)+'\n');
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line);if(request.type==='user')throw Error('Usage must not send a model prompt');
  if(request.type!=='control_request')continue;
  const response=request.request.subtype==='get_usage'?{rate_limits_available:true,subscription_type:'pro',rate_limits:settings.env?.HTTPS_PROXY&&settings.permissions?.blockReadsOutsideWorkingDirectories?{five_hour:{utilization:15,resets_at:null}}:null}:{};
  send({type:'control_response',response:{subtype:'success',request_id:request.request_id,response}});
}

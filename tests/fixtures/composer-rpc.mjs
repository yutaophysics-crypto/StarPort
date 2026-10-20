import { createInterface } from 'node:readline';
for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);if(r.id==null)continue;let result={};
  if(r.method==='thread/start'||r.method==='thread/resume')result={thread:{id:'native'},model:'test-model'};
  if(r.method==='thread/goal/get')result={goal:null};
  if(r.method==='turn/start'){
    result={turn:{id:'turn'}};process.stdout.write(JSON.stringify({id:r.id,result})+'\n');
    process.stdout.write(JSON.stringify({method:'item/completed',params:{item:{type:'plan',id:'plan',text:JSON.stringify(r.params)}}})+'\n');
    process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}})+'\n');continue;
  }
  process.stdout.write(JSON.stringify({id:r.id,result})+'\n');
}

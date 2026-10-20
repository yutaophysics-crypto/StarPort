import { createInterface } from 'node:readline';
for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);if(r.id==null)continue;
  let result={};
  if(r.method==='model/list')result=r.params.cursor?{data:[{model:'second',displayName:'Second model',supportedReasoningEfforts:[{reasoningEffort:'none',description:'No reasoning'}],defaultReasoningEffort:'none'},{model:'hidden',hidden:true}],nextCursor:null}:{data:[{model:'first',displayName:'First model',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Fast'},{reasoningEffort:'xhigh',description:'Deep'}],defaultReasoningEffort:'low'}],nextCursor:'page-two'};
  process.stdout.write(JSON.stringify({id:r.id,result})+'\n');
}

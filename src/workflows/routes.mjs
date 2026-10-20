// HTTP routes for companions, rooms, workflows, mounts, ledgers and runs.
// Returns {data,status}, or null when the path is not ours.
export async function handleWorkflowRoutes(workflows,method,path,read){
  let match;const ok=(data,status=200)=>({data,status});
  if(path==='/api/workflows/state'&&method==='GET')return ok(workflows.state());
  if(path==='/api/workflows/settings'&&method==='PUT')return ok(workflows.saveSettings(await read()));
  if(path==='/api/workflows/migrate'&&method==='POST')return ok(await workflows.migrate(await read()));
  if(path==='/api/companions'&&method==='POST'){const data=await read();return ok(workflows.createCompanion(data,{groupId:typeof data.groupId==='string'?data.groupId:null}),201);}
  if((match=path.match(/^\/api\/companions\/([\w-]+)$/))){
    if(method==='PATCH')return ok(workflows.updateCompanion(match[1],await read()));
    if(method==='DELETE')return ok(workflows.deleteCompanion(match[1]));
  }
  if((match=path.match(/^\/api\/rooms\/([\w-]+)\/members$/))&&method==='POST')return ok(workflows.addMember(match[1],(await read()).companionId));
  if((match=path.match(/^\/api\/rooms\/([\w-]+)\/members\/([\w-]+)\/remove$/))&&method==='POST')return ok(workflows.removeMember(match[1],match[2],await read()));
  if((match=path.match(/^\/api\/rooms\/([\w-]+)\/members\/([\w-]+)\/memory$/))&&method==='PATCH')return ok(workflows.setMemberMemory(match[1],match[2],await read()));
  if(path==='/api/workflows'&&method==='POST')return ok(workflows.createWorkflow(await read()),201);
  if((match=path.match(/^\/api\/workflows\/([\w-]+)$/))){
    if(method==='PATCH')return ok(workflows.updateWorkflow(match[1],await read()));
    if(method==='DELETE')return ok(workflows.deleteWorkflow(match[1]));
  }
  if((match=path.match(/^\/api\/chats\/([\w-]+)\/mounts$/))&&method==='POST')return ok(workflows.createMount(match[1],await read()),201);
  if((match=path.match(/^\/api\/chats\/([\w-]+)\/dispatch$/))&&method==='POST')return ok(await workflows.dispatch(match[1],await read()),202);
  // Only the page starts or cancels an exam; the conversation's model can merely propose one.
  if((match=path.match(/^\/api\/chats\/([\w-]+)\/exams\/([\w-]+)\/(start|cancel)$/))&&method==='POST'){
    const data=await read();
    return ok(match[3]==='start'?await workflows.startExam(match[1],match[2],data):workflows.cancelExam(match[1],match[2]),match[3]==='start'?202:200);
  }
  if((match=path.match(/^\/api\/chats\/([\w-]+)\/runs\/([\w-]+)\/save-workflow$/))&&method==='POST')return ok(workflows.saveAsWorkflow(match[1],match[2],await read()),201);
  if((match=path.match(/^\/api\/mounts\/([\w-]+)$/))){
    if(method==='PATCH')return ok(workflows.updateMount(match[1],await read()));
    if(method==='DELETE')return ok(workflows.deleteMount(match[1]));
  }
  if((match=path.match(/^\/api\/mounts\/([\w-]+)\/run$/))&&method==='POST')return ok(await workflows.runMount(match[1],{text:(await read()).text}),202);
  if((match=path.match(/^\/api\/mounts\/([\w-]+)\/ledger$/))){
    if(method==='GET')return ok(workflows.ledgerView(match[1]));
    if(method==='PATCH')return ok(await workflows.editLedger(match[1],await read()));
  }
  if((match=path.match(/^\/api\/workflow-runs\/([\w-]+)\/stop$/))&&method==='POST')return ok(workflows.stopRun(match[1]));
  return null;
}

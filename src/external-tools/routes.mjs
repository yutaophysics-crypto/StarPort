// HTTP routes for a project's external tools and persistent applications.
// Returns {data,status}, or null when the path is not ours.
import { toolPathKey } from './grants.mjs';
import { isLive } from './applications.mjs';
import { externalToolCapability } from './claude-launch.mjs';
import { runWorkspaceCommand, quotePowerShell } from './terminal.mjs';

const fail=(message,status)=>Object.assign(Error(message),{status});
// Lists the tool folder and reads the program version, inside the sandbox.
const verifyCommand=tool=>`Get-ChildItem -LiteralPath ${quotePowerShell(tool.canonical)} -Force | Select-Object -First 5 Name; `+
  (tool.canonicalExecutable?`$item=Get-Item -LiteralPath ${quotePowerShell(tool.canonicalExecutable)}; [pscustomobject]@{Executable=$item.FullName;Version=$item.VersionInfo.ProductVersion} | ConvertTo-Json -Compress`:'');

export async function handleExternalToolRoutes({store,registry,tools,applications,isBusy},method,path,read){
  let match;const ok=(data,status=200)=>({data,status});
  const projectWorkspace=id=>{const project=store.project(id);if(!project?.workspace)throw fail('项目不存在',404);return project.workspace;};
  if((match=path.match(/^\/api\/projects\/([\w-]+)\/external-applications(?:\/([\w-]+)\/(stop))?$/))){
    const workspace=projectWorkspace(match[1]),id=match[2];
    if(method==='GET'&&!id)return ok({applications:await applications.list(workspace)});
    if(method==='POST'&&id){await read(1024);return ok(await applications.stop(workspace,id));}
    throw fail('请求方法无效',405);
  }
  if(!(match=path.match(/^\/api\/projects\/([\w-]+)\/external-tools(?:\/([\w-]+)(?:\/(verify))?)?$/)))return null;
  const [,projectId,toolId,action]=match,workspace=projectWorkspace(projectId);
  const busy=()=>store.list().chats.some(chat=>toolPathKey(chat.workspace)===toolPathKey(workspace)&&isBusy(chat.id));
  const capability=await externalToolCapability(registry.resolve('claude'),workspace,registry.resolve('codex')?.command);
  const status=async()=>({...tools.view(workspace),catalog:tools.catalog(),applications:await applications.list(workspace),supported:capability.supported,reason:capability.reason||'',busy:busy()});
  if(method==='GET'&&!toolId)return ok(await status());
  if(!capability.supported)throw Error(capability.reason);
  // A running task keeps the grants it started with, so changes wait for it.
  // Checked again after reading a body, since a task may start meanwhile.
  const requireIdle=()=>{if(busy())throw fail('请等待此项目的任务结束后修改或验证工具权限',409);};
  requireIdle();
  if(method==='POST'&&!toolId){
    const input=await read(16384);requireIdle();
    if(input?.catalogId!==undefined)await tools.use(workspace,input.catalogId);else await tools.add(workspace,input);
    return ok(await status(),201);
  }
  if(method==='PATCH'&&toolId&&!action){
    const input=await read(1024);requireIdle();
    await tools.setHostApproval(workspace,toolId,input.hostApproval);return ok(await status());
  }
  if(method==='DELETE'&&toolId&&!action){
    if((await applications.list(workspace)).some(item=>item.toolId===toolId&&isLive(item)))throw fail('请先关闭此工具的常驻程序，再移除授权',409);
    await tools.remove(workspace,toolId);return ok(await status());
  }
  if(method==='POST'&&action==='verify'){
    await read(1024);const snapshot=tools.snapshot(workspace),tool=snapshot.tools.find(tool=>tool.id===toolId);
    if(!tool)throw fail('工具不存在',404);
    const result=await runWorkspaceCommand({workspace:snapshot.workspace,snapshot,command:verifyCommand(tool),sandboxExecutable:capability.sandboxExecutable,timeoutMs:20000});
    return ok({ok:result.exitCode===0&&!result.timedOut,result});
  }
  throw fail('请求方法无效',405);
}

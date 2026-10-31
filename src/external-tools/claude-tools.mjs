// Starport-hosted MCP tools for a Claude run that has external tools: the
// sandboxed workspace terminal, and approved host launches of registered
// programs. They run inside Starport, so the approval cannot be skipped by
// Claude's own permission mode.
import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { redact } from '../process.mjs';
import { hostRunnable } from './grants.mjs';
import { runWorkspaceCommand } from './terminal.mjs';
import { runExternalApplication, EXTERNAL_APPLICATION_WARNING } from './host-run.mjs';
import { externalApplicationManager } from './applications.mjs';
import {previewTools} from '../previews/mcp.mjs';

const TERMINAL_DESCRIPTION='PowerShell in the current project with Windows MXC: project writable; approved installations read-only; network disabled. Use real physical paths for external programs, not StarPort: virtual paths. Complete desktop applications may not start inside MXC; use starport_external_tools.run with project authorization. This terminal is hosted by Starport and available again each turn.';
const runDescription=applications=>'Launch a registered external application when the sandbox terminal cannot run its runtime (Electron, browsers, game engines or other installed software). '+
  'This starts the exact registered executable, with a literal argument array, in a project subdirectory. '+
  'An ask-policy tool requires explicit approval; an always-policy tool was already authorized by the user for this project and needs no repeat approval. Native auto/bypass modes never change this project policy. '+
  'The application and its descendants have normal Windows user access, including files outside the project and network. '+
  'Use real absolute paths in arguments, not StarPort: PSDrive paths. By default it waits for exit and cleans up. Set persistent=true to keep an editor/server open across turns and Starport restarts; list/stop manage it. Repeating the identical persistent launch reuses it. '+
  'Pass documented successExitCodes for tools using nonzero success codes. Available applications: '+JSON.stringify(applications.map(item=>({toolId:item.id,name:item.name,executable:item.canonicalExecutable,hostApproval:item.hostApproval||'ask'})));

const reply=(value,isError)=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}],...isError===undefined?{}:{isError}});
// The model sees the end of long output.
function compactResult(result){
  const stdout=result.stdout||'',stderr=result.stderr||'';
  return {...result,stdout:stdout.slice(-12000),stderr:stderr.slice(-4000),outputTruncated:!!result.outputTruncated||stdout.length>12000||stderr.length>4000};
}

// Returns the servers and allowed tool names to add to the SDK options.
// settled() resolves once every started command or launch has finished.
export function externalToolServers({runtime,cwd,signal:runSignal,canUseTool,emit}){
  const pending=new Set(),servers={},allowed=[],policy=runtime.externalTools;
  const track=async running=>{pending.add(running);try{return await running;}finally{pending.delete(running);}};
  const callSignal=extra=>extra?.signal?AbortSignal.any([runSignal,extra.signal]):runSignal;
  if(runtime.workspaceTerminal?.normalPolicy&&runtime.workspaceTerminal.sandboxExecutable){
    const previews=previewTools({dataDir:policy.dataDir,workspace:cwd,sandboxExecutable:runtime.workspaceTerminal.sandboxExecutable,signal:runSignal,track});
    servers.starport_preview=previews.server;allowed.push(...previews.allowed);
  }
  if(runtime.workspaceTerminal){
    const description=runtime.workspaceTerminal.normalPolicy?'PowerShell in the project filesystem sandbox, with normal development networking. Git and ordinary build processes may access their own services and local ports. This is a one-shot command: background children end when the command returns. Use starport_preview.start for a persistent built HTML/game preview, not Start-Process here. Claude/AI clients retain separate executable firewall protection and fixed proxy settings. Shell networking is not a whole-process-tree proxy restriction. Use registered host application tools for full desktop engines such as Creator; successExitCodes=[36] is its documented successful build exit code. Existing host approval policy still applies.':runtime.workspaceTerminal.runner?'PowerShell in this project through the owner-configured isolated runner. Its filesystem and network policy covers all descendants; external tool grants do not replace that policy. Network access may require the configured fixed proxy. Use starport_runtime_status and starport_reload_when_idle for Starport coordination instead of its privileged HTTP API. No unrestricted host fallback.':TERMINAL_DESCRIPTION;
    servers.starport_workspace=createSdkMcpServer({name:'starport_workspace',version:'2.0.0',tools:[tool('run_command',description,
      {command:z.string().min(1).max(20000),timeoutMs:z.number().int().min(1000).max(300000).optional()},
      async(input,extra)=>{
        try{
          const result=await track(runWorkspaceCommand({...input,workspace:cwd,snapshot:policy,...runtime.workspaceTerminal,signal:callSignal(extra)}));
          return reply(compactResult(result),result.exitCode!==0||result.timedOut||result.canceled);
        }catch(error){return reply('隔离命令未执行；权限未放宽：'+redact(error.message),true);}
      })]});
    allowed.push('mcp__starport_workspace__run_command');
  }
  const applications=runtime.workspaceTerminal?.hostExecution===false?[]:policy?.tools.filter(hostRunnable)||[];
  if(applications.length){
    const manager=externalApplicationManager(policy.dataDir);
    servers.starport_external_tools=createSdkMcpServer({name:'starport_external_tools',version:'1.0.0',tools:[
      tool('run',runDescription(applications),
        {toolId:z.enum(applications.map(item=>item.id)),args:z.array(z.string()).max(128),directory:z.string().optional(),
          timeoutMs:z.number().int().min(1000).max(900000).optional(),successExitCodes:z.array(z.number().int().min(0).max(0xffffffff)).min(1).max(16).optional(),persistent:z.boolean().optional()},
        async(input,extra)=>{
          // The approval card is a separate tool row, finished here once the launch ends.
          const approvalToolId=randomUUID();let asked=false;
          try{
            const signal=callSignal(extra);
            const result=await track(runExternalApplication({...input,workspace:cwd,snapshot:policy,manager,signal,
              approve:async request=>{
                asked=true;
                const approval=await canUseTool('mcp__starport_external_tools__run',request,{toolUseID:approvalToolId,signal,
                  title:'本机兼容运行：'+request.tool,description:EXTERNAL_APPLICATION_WARNING,decisionReason:'外部程序使用本机权限，需要逐次明确批准。',defaultToNo:true});
                return approval.behavior==='allow';
              }}));
            if(asked)emit({type:'tool',id:approvalToolId,status:result.ok?'complete':result.approved?'error':'denied'});
            return reply(compactResult(result),!result.ok);
          }catch(error){if(asked)emit({type:'tool',id:approvalToolId,status:'error'});return reply('外部程序未完成：'+redact(error.message),true);}
        }),
      tool('list','List managed persistent applications for this project, with application ids and status. Other projects are excluded.',{},
        async()=>reply({applications:await manager.list(cwd)})),
      tool('stop','Close a managed persistent application and its child processes by id. This can close an editor with unsaved changes; use only when requested or for your own disposable test.',{applicationId:z.string()},
        async({applicationId})=>{try{return reply(await manager.stop(cwd,applicationId));}catch(error){return reply(redact(error.message),true);}})
    ]});
    allowed.push('mcp__starport_external_tools__run','mcp__starport_external_tools__list','mcp__starport_external_tools__stop');
  }
  return {servers,allowed,settled:()=>Promise.allSettled(pending)};
}

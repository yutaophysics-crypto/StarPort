import { readFileSync, realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runWorkspaceCommand } from '../src/workspace-terminal.mjs';
import { validateToolSnapshot } from '../src/external-tools.mjs';

const workspace=realpathSync.native(process.cwd()),controllers=new Set();
const snapshot=process.env.STARPORT_EXTERNAL_TOOLS_MANIFEST?
  validateToolSnapshot(JSON.parse(readFileSync(process.env.STARPORT_EXTERNAL_TOOLS_MANIFEST,'utf8')),workspace):{workspace,tools:[]};
const server=new McpServer({name:'starport_workspace',version:'1.1.0'});
server.registerTool('run_command',{
  title:'当前项目的隔离终端',
  description:'Run PowerShell in the current project. Windows MXC enforces project writes and read-only access to the approved tool installations below (including running their executables). Use this terminal for tool files and builds. Cache/home folders are isolated inside .starport-claude-runtime. Network is disabled. No unrestricted fallback. Wait for GUI executables such as CocosCreator.exe with Start-Process -Wait -PassThru or Node child_process.spawnSync; direct PowerShell invocation may return before the GUI process finishes. Approved tools: '+JSON.stringify(snapshot.tools.map(tool=>({name:tool.name,directory:tool.canonical,executable:tool.canonicalExecutable}))),
  inputSchema:{command:z.string().min(1).max(20000),timeoutMs:z.number().int().min(1000).max(300000).default(120000)},
  annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
},async({command,timeoutMs},extra)=>{
  const controller=new AbortController(),cancel=()=>controller.abort();controllers.add(controller);extra.signal?.addEventListener('abort',cancel,{once:true});if(extra.signal?.aborted)cancel();
  try{const result=await runWorkspaceCommand({workspace,snapshot,command,timeoutMs,signal:controller.signal,sandboxExecutable:process.env.STARPORT_CODEX_SANDBOX});return {content:[{type:'text',text:JSON.stringify(result)}],isError:result.exitCode!==0||result.timedOut||result.canceled};}
  catch(error){return {isError:true,content:[{type:'text',text:'隔离命令未执行；权限未放宽：'+error.message}]};}
  finally{controllers.delete(controller);extra.signal?.removeEventListener('abort',cancel);}
});
process.stdin.on('end',()=>{for(const controller of controllers)controller.abort();});
await server.connect(new StdioServerTransport());

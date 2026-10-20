import {query} from '@anthropic-ai/claude-agent-sdk';
import {childEnvironment,startProcess,stopProcess,restrictToCurrentUser} from './process.mjs';
import {mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';

async function controlSettings(runtime,cwd){
  // --settings is a single value: the SDK's later argument replaces the owner's
  // settings file, including its proxy and workspace rules, unless we preserve it.
  let source;const args=runtime.prefixArgs||[];
  for(let i=0;i<args.length;i++)if(args[i]==='--settings')source=args[++i];else if(args[i].startsWith('--settings='))source=args[i].slice(11);
  if(source===undefined)return {settings:{disableAllHooks:true},cleanup:async()=>{}};
  if(typeof source!=='string'||!source.trim())throw Error('Claude 查询设置无效');
  const inline=source.trim().startsWith('{'),file=inline?null:resolve(cwd,source),raw=inline?source:await readFile(file,'utf8');
  if(Buffer.byteLength(raw)>2*1024*1024)throw Error('Claude 查询设置过大');
  let settings;try{settings=JSON.parse(raw);}catch{throw Error('Claude 查询设置不是有效 JSON');}
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('Claude 查询设置无效');
  if(settings.disableAllHooks===true)return {settings:file||source,cleanup:async()=>{}};
  // A private copy adds the metadata-only hook restriction without modifying the
  // original config or putting config secrets into the process command line.
  const directory=await mkdtemp(join(tmpdir(),'starport-claude-control-')),copy=join(directory,'settings.json');
  const cleanup=async()=>{await unlink(copy).catch(()=>{});await rmdir(directory).catch(()=>{});};
  try{
    await writeFile(copy,'',{mode:0o600});
    await restrictToCurrentUser(copy);
    await writeFile(copy,JSON.stringify({...settings,disableAllHooks:true}),{mode:0o600});return {settings:copy,cleanup};
  }catch(error){await cleanup();throw error;}
}

// Metadata-only SDK session: never yield a user message or resume a transcript.
export async function claudeControl(runtime,cwd,read,makeQuery=query,timeoutMs=25000){
  let finish,session,child,timer,prepared;
  const idle=new Promise(resolve=>finish=resolve),abortController=new AbortController();
  async function* input(){await idle;}
  try{
    prepared=await controlSettings(runtime,cwd);
    session=makeQuery({prompt:input(),options:{pathToClaudeCodeExecutable:runtime.command,cwd,abortController,
      tools:[],mcpServers:{},strictMcpConfig:true,settings:prepared.settings,settingSources:['user','project','local'],
      persistSession:false,env:childEnvironment(),extraArgs:{'disable-slash-commands':null},
      spawnClaudeCodeProcess:({args,cwd,env,signal})=>(child=startProcess(runtime.command,[...runtime.prefixArgs,...args],{cwd,env,signal}))}});
    return await Promise.race([read(session),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('原生查询超时，请稍后重试'));abortController.abort();},timeoutMs);})]);
  }finally{clearTimeout(timer);finish();session?.close();try{if(child)await stopProcess(child);}finally{await prepared?.cleanup();}}
}

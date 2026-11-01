import {createSdkMcpServer,tool} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import {previewManager} from './manager.mjs';
import {redact} from '../process.mjs';

export function previewTools({dataDir,workspace,sandboxExecutable,signal,track}){
  const manager=previewManager(dataDir),reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
  const call=async action=>{try{return reply(await track(action()));}catch(e){return {...reply({error:redact(e.message)}),isError:true};}};
  const server=createSdkMcpServer({name:'starport_preview',version:'1.0.0',tools:[
    tool('start','Start or reuse a persistent static preview for a project folder. Returns a verified localhost URL. It stays available after this call, later commands, model turns and Starport restarts. Use it for built HTML/Cocos/web games instead of Start-Process in the one-shot terminal. Serves files read-only, on loopback only, using the registered sandbox and bundled Node; no Python or external executable grant needed. This serves an existing build, and does not compile or run arbitrary application scripts.',
      {directory:z.string().min(1).max(2000).optional(),port:z.number().int().min(0).max(65535).optional()},
      async(input,extra)=>call(()=>manager.start({...input,workspace,sandboxExecutable,signal:extra?.signal?AbortSignal.any([signal,extra.signal].filter(Boolean)):signal}))),
    tool('list','List this project\'s persistent static previews and verified localhost URLs. Other projects are excluded.',{},async()=>call(async()=>({previews:await manager.list(workspace)}))),
    tool('stop','Stop one of this project\'s static previews by id. Use when finished testing or when the user requests it.',{previewId:z.string()},async({previewId})=>call(()=>manager.stop(workspace,previewId)))
  ]});
  return {server,allowed:['start','list','stop'].map(name=>'mcp__starport_preview__'+name)};
}

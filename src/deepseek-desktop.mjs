import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, childEnvironment } from './process.mjs';
import { effortChoices } from './effort.mjs';

const metadataScript=fileURLToPath(new URL('../scripts/deepseek-desktop-metadata.cjs',import.meta.url));

// Run the official desktop's Node entry directly; never execute a batch shell.
export function deepseekDesktopRuntime(launcher) {
  if(basename(launcher).toLowerCase()==='deepseek harness.exe')
    launcher=join(dirname(launcher),'resources','runtime','cli','bin','dsh.cmd');
  if(basename(launcher).toLowerCase()!=='dsh.cmd'||!existsSync(launcher))return null;
  const bin=dirname(launcher);
  if(!bin.replaceAll('\\','/').toLowerCase().endsWith('/resources/runtime/cli/bin'))return null;
  const root=resolve(bin,'../../../..'),command=join(root,'DeepSeek Harness.exe');
  if(!existsSync(command)||!existsSync(join(root,'resources','app.asar')))return null;
  return {command,prefixArgs:['--expose-internals',join(root,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js')],env:{ELECTRON_RUN_AS_NODE:'1'}};
}

export function isDeepseekDesktop(runtime) {
  return runtime?.env?.ELECTRON_RUN_AS_NODE==='1'&&runtime.prefixArgs?.[0]==='--expose-internals'&&
    /[/\\]@deepseek-ai[/\\]dsh-desktop-host[/\\]lib[/\\]cli\.js$/i.test(runtime.prefixArgs[1]||'');
}

export async function deepseekDesktopMetadata(runtime,cwd,run=exec) {
  const result=await run(runtime.command,['--expose-internals',metadataScript,runtime.prefixArgs[1]],
    {cwd,env:childEnvironment(runtime.env),timeout:15000,maxBuffer:2*1024*1024,windowsHide:true});
  const metadata=JSON.parse(result.stdout);
  return {...metadata,models:metadata.models.map(({reasoning,...model})=>({...model,effort:reasoning?
    effortChoices(reasoning.efforts.map(e=>({value:e.id,label:e.name,description:e.description})),{defaultLevel:reasoning.defaultEffort}):null}))};
}

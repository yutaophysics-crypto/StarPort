import {readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {spawnLauncher} from '../src/external-tools/processes.mjs';

// Detached owner of one persistent application, with bounded logs. The
// launcher child uses pipes, avoiding Windows PowerShell console startup with
// detached file handles.
const specFile=process.argv[2],directory=dirname(specFile);
const spec=JSON.parse(await readFile(specFile,'utf8'));
const child=spawnLauncher(spec,{cwd:spec.cwd,stdio:['pipe','pipe','pipe']});
let output='',error='',dirty=false,writes=Promise.resolve();
const log=async()=>{if(!dirty)return;dirty=false;const out=output,err=error;writes=writes.catch(()=>{}).then(()=>Promise.all([writeFile(join(directory,'stdout.log'),out),writeFile(join(directory,'stderr.log'),err)]));await writes;};
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
child.stdout.on('data',chunk=>{output=(output+chunk).slice(-64000);dirty=true;});child.stderr.on('data',chunk=>{error=(error+chunk).slice(-64000);dirty=true;});
const timer=setInterval(()=>void log().catch(()=>{}),500);timer.unref();
child.once('error',failure=>{clearInterval(timer);void writeFile(spec.statusFile,JSON.stringify({state:'error',error:failure.message,updatedAt:Date.now()})).catch(()=>{});});
child.once('close',()=>{clearInterval(timer);void log().catch(()=>{});});

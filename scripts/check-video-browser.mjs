// Inspect the local Starport bridge, or explicitly read one supplied video.
// No native models, cookies or browser history are accessed by this diagnostic.
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),config=JSON.parse(await readFile(join(root,'.data','server.json'),'utf8'));
if(resolve(config.root)!==root||!Number.isSafeInteger(config.port))throw Error('Starport server identity mismatch');
const base=`http://127.0.0.1:${config.port}`,health=await(await fetch(base+'/health',{signal:AbortSignal.timeout(5000)})).json();
if(resolve(health.root)!==root||health.app!=='harness-hub')throw Error('Starport server identity mismatch');
const html=await(await fetch(base+'/',{signal:AbortSignal.timeout(5000)})).text(),token=html.match(/name="hub-token" content="([^"]+)"/)?.[1];
if(!token)throw Error('Missing Starport token');
const headers={'X-Hub-Token':token,'Content-Type':'application/json'};
const get=async path=>{const response=await fetch(base+path,{headers,signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error(`Starport status failed: ${response.status}`);return response.json();};
const state=await get('/api/state'),edge=await get('/api/edge/status');
console.log(JSON.stringify({pid:config.pid,port:config.port,activeCount:state.active.length,chatCount:state.chats.length,edge:{paired:edge.paired,connected:edge.connected,extensionPath:edge.extensionPath}}));
if(process.argv[2]){
  const response=await fetch(base+'/api/videos/read',{method:'POST',headers,body:JSON.stringify({reference:process.argv[2]}),signal:AbortSignal.timeout(65000)}),data=await response.json();
  if(!response.ok)throw Error(data.error||'Video read failed');
  const caption=await get('/api/attachments/'+data.attachment.id+'/preview');
  console.log(JSON.stringify({attachment:data.attachment.id,title:data.attachment.name,characters:caption.text.length,timestampedLines:caption.text.split('\n').filter(line=>/^\[\d\d:\d\d:\d\d/.test(line)).length}));
}

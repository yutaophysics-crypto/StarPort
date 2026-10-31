import {createStaticPreview} from '../src/previews/static-server.mjs';
try{
  const spec=JSON.parse(process.argv[2]);
  const server=await createStaticPreview(spec);
  console.log(JSON.stringify({event:'starport-preview-ready',nonce:spec.nonce,port:server.address().port}));
  const close=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};
  process.once('SIGTERM',close);process.once('SIGINT',close);
}catch(error){console.error('Preview startup failed: '+(error.code||error.message));process.exitCode=1;}

let input='';for await(const chunk of process.stdin)input+=chunk;
const send=e=>console.log(JSON.stringify(e));
const at=process.argv.indexOf('--resume');send({type:'system',subtype:'init',session_id:at<0?'fresh-native':process.argv[at+1],model:'fixture'});
if(input==='slow')await new Promise(()=>setInterval(()=>{},1000));
if(input==='blocked'){send({type:'result',subtype:'error_during_execution',is_error:true,errors:["Your account is on hold and can't use Claude Code."]});process.exitCode=1;}
else{send({type:'stream_event',event:{delta:{type:'text_delta',text:'你好，星港'}}});send({type:'assistant',message:{content:[{type:'text',text:'你好，星港'}]}});send({type:'result',subtype:'success',result:'你好，星港'});}

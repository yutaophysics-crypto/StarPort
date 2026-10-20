import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const event=(sessionId,type,data)=>send({method:'session.event',params:{sessionId,event:{type,data}}});
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line),params=request.params||{};
  if(request.method==='initialize')send({id:request.id,result:{serverInfo:{name:'fixture'}}});
  if(request.method==='session/prompt'){
    const id=params.sessionId;send({id:request.id,result:{}});
    send({method:'session.status',params:{sessionId:id,status:'running'}});
    event(id,'turn/start',{turn:1});event(id,'step/start',{turn:1,step:1});
    send({method:'subagent.started',params:{parentSessionId:id,childSessionId:'child'}});
    event('child','step/start',{turn:1,step:1});
    event('child','assistant/message',{turn:1,step:1,message:{content:[{type:'reasoning',text:'Child summary'},{type:'text',text:'Child reply'}]}});
    event('child','tool/call',{callId:'t',name:'read_file',arguments:'{"path":"a"}'});
    event('child','tool/result',{message:{content:[{type:'tool-result',toolCallId:'t',isError:true,content:[{type:'text',text:'not found'}]}]}});
    send({method:'subagent.finished',params:{parentSessionId:id,childSessionId:'child',status:'error',stopReason:'failed'}});
    event(id,'assistant/message',{turn:1,step:1,message:{content:[{type:'reasoning',text:'Parent summary'},{type:'text',text:'Parent answer'}]}});
    event(id,'step/end',{turn:1,step:1});event(id,'turn/end',{reason:{kind:'completed'}});
    send({method:'session.status',params:{sessionId:id,status:'idle'}});
  }
  if(request.method==='shutdown'){send({id:request.id,result:{}});break;}
}

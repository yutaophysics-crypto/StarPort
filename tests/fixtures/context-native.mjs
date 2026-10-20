// Exercises real child transports without credentials or a model request.
import {createInterface} from 'node:readline';
const mode=process.argv[2],memoryMode=process.argv[3]==='memory',send=data=>process.stdout.write(JSON.stringify(data)+'\n');let tools=[];
async function search(){
  const call=async(name,args)=>{const result=await fetch(process.env.STARPORT_CONTEXT_URL,{method:'POST',headers:{'Content-Type':'application/json','X-Starport-Context':process.env.STARPORT_CONTEXT_TOKEN},body:JSON.stringify({name,arguments:args})});if(!result.ok)throw Error('Bridge '+result.status);return result.json();};
  const found=await call(memoryMode?'starport_memory_search':'starport_history_search',{query:memoryMode?'釉料':'采购预算'});
  return memoryMode?call('starport_memory_read',{ids:[found.items[0].id],reason:'当前陶艺工作需要已确认的釉料记录。'}):found;
}
const input=createInterface({input:process.stdin});
input.on('line',async line=>{try{
  const r=JSON.parse(line);
  if(mode==='antigravity'){const result=await search();send({event:'result',result:{conversation_id:'fixture-context',status:'SUCCESS',response:JSON.stringify(result)}});return;}
  const respond=result=>send({id:r.id,result});
  if(mode==='codex'){
    if(r.method==='initialize')respond({});
    else if(r.method==='thread/start'||r.method==='thread/resume'){tools=r.params.dynamicTools||[];respond({thread:{id:'context-native'},model:'fixture'});}
    else if(r.method==='thread/goal/get')respond({goal:null});
    else if(r.method==='turn/start'){respond({turn:{id:'turn-context'}});setTimeout(()=>send({id:'context-call',method:'item/tool/call',params:{threadId:'context-native',turnId:'turn-context',callId:'fixture-call',tool:memoryMode?'starport_memory_search':'starport_history_search',arguments:{query:memoryMode?'釉料':'采购预算'}}}),10);}
    else if(r.id==='context-call'&&memoryMode&&r.result.success){const found=JSON.parse(r.result.contentItems[0].text);send({id:'memory-read',method:'item/tool/call',params:{threadId:'context-native',turnId:'turn-context',callId:'fixture-memory-read',tool:'starport_memory_read',arguments:{ids:[found.items[0].id],reason:'当前陶艺工作需要已确认的釉料记录。'}}});}
    else if(r.id==='context-call'||r.id==='memory-read'){
      const response={registered:tools.map(t=>({type:t.type,name:t.name})),...r.result};send({method:'item/agentMessage/delta',params:{threadId:'context-native',itemId:'answer',delta:JSON.stringify(response)}});send({method:'turn/completed',params:{threadId:'context-native',turn:{id:'turn-context',status:'completed'}}});
    }
  }else if(mode==='deepseek'){
    if(r.method==='initialize')respond({serverInfo:{name:'context-fixture'}});
    else if(r.method==='session/prompt'){
      respond({messageId:'fixture'});const id=r.params.sessionId,event=(type,data)=>send({method:'session.event',params:{sessionId:id,event:{type,data}}});
      send({method:'session.status',params:{sessionId:id,status:'running'}});event('turn/start',{turn:1});const result=await search();event('assistant/message',{turn:1,step:1,message:{id:'answer',content:[{type:'text',text:JSON.stringify(result)}]}});event('turn/end',{turn:1,reason:{kind:'completed'}});send({method:'session.status',params:{sessionId:id,status:'idle'}});
    }else if(r.method==='shutdown'){respond({});process.stdout.end(()=>process.exit(0));}
  }
}catch(error){process.stderr.write(String(error));process.exit(9);}});

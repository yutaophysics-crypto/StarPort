// Only native protocol fixtures: no credentials, network calls or real tools.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const provider=process.argv[2],owner=process.argv[3],send=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(process.env.STARPORT_CONTEXT_URL||process.env.STARPORT_CONTEXT_TOKEN)throw Error('Private context bridge leaked to group child');
const record=prompt=>{writeFileSync(join(process.cwd(),provider+'.json'),JSON.stringify({owner,cwd:process.cwd(),prompt}));return provider+' '+owner+' native reply';};
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line),params=request.params||{},respond=value=>send({id:request.id,result:value});
  if(provider==='codex'){
    if(request.method==='initialize')respond({});
    else if(request.method==='thread/start'){if(params.dynamicTools?.length)throw Error('Private tools published');respond({thread:{id:'group-native'},model:'fixture'});}
    else if(request.method==='thread/goal/get')respond({goal:null});
    else if(request.method==='turn/start'){respond({turn:{id:'group-turn'}});const text=record(params.input[0].text);send({method:'item/agentMessage/delta',params:{threadId:'group-native',itemId:'answer',delta:text}});send({method:'turn/completed',params:{threadId:'group-native',turn:{id:'group-turn',status:'completed'}}});}
  }else if(provider==='antigravity'){
    send({event:'result',result:{conversation_id:'group-native',status:'SUCCESS',response:record(request.message.content)}});
  }else if(provider==='deepseek'){
    if(request.method==='initialize')respond({serverInfo:{name:'fixture'}});
    else if(request.method==='session/prompt'){
      respond({});const id=params.sessionId,event=(type,data)=>send({method:'session.event',params:{sessionId:id,event:{type,data}}});
      send({method:'session.status',params:{sessionId:id,status:'running'}});event('turn/start',{turn:1});
      event('assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:record(params.contentBlocks[0].text)}]}});
      event('turn/end',{turn:1,reason:{kind:'completed'}});send({method:'session.status',params:{sessionId:id,status:'idle'}});
    }else if(request.method==='shutdown'){respond({});break;}
  }else if(provider==='claude'){
    if(request.type==='control_request'){send({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{}}});}
    else if(request.type==='user'){
      send({type:'system',subtype:'init',session_id:'group-native',model:'fixture',uuid:randomUUID()});
      send({type:'result',subtype:'success',is_error:false,result:record(request.message.content),session_id:'group-native',uuid:randomUUID(),duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{},permission_denials:[]});
    }
  }
}

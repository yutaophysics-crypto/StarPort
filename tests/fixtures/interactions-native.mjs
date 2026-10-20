// Protocol-only child processes. No credentials, network or real model calls.
import {createInterface} from 'node:readline';
const mode=process.argv[2],send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let starts=0,prompts=0,busy=false,thread='fixture-thread',nativeTurn=0;
const event=(sessionId,type,data={})=>send({method:'session.event',params:{sessionId,event:{type,data}}});
const status=(sessionId,state)=>send({method:'session.status',params:{sessionId,status:state}});
const begin=id=>{nativeTurn++;status(id,'running');event(id,'turn/start',{turn:nativeTurn});};
const end=id=>{event(id,'turn/end',{turn:nativeTurn,reason:{kind:'completed'}});status(id,'idle');};
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line),params=request.params||{};
  if(mode==='codex'){
    const result=value=>send({id:request.id,result:value});
    if(!request.method){
      if(request.id==='native-question'){
        send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'answer',delta:JSON.stringify(request.result)}});
        send({method:'turn/completed',params:{threadId:thread,turn:{id:'live-turn',status:'completed'}}});
      }return;
    }
    if(request.method==='initialize')result({userAgent:'fixture'});
    else if(request.method==='thread/start'||request.method==='thread/resume')result({thread:{id:thread},model:'fixture'});
    else if(request.method==='thread/goal/get')result({goal:null});
    else if(request.method==='turn/start'){
      starts++;if(starts>1){send({id:request.id,error:{code:-32000,message:'Unexpected extra turn/start'}});return;}
      result({turn:{id:'live-turn'}});send({method:'turn/started',params:{threadId:thread,turn:{id:'live-turn'}}});
      if(params.input[0].text==='QUESTION')send({id:'native-question',method:process.argv[3]||'item/tool/requestUserInput',params:{threadId:thread,questions:[{id:'tests',question:'Which checks?',options:[{label:'Unit'},{label:'Browser'}],multiSelect:true}]}});
    }else if(request.method==='turn/steer'){
      if(params.threadId!==thread||params.expectedTurnId!=='live-turn'){send({id:request.id,error:{code:-32000,message:'Stale turn'}});return;}
      result({turnId:'live-turn'});send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'guidance',delta:JSON.stringify(params)}});
      if(params.input[0].text==='finish')setTimeout(()=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'live-turn',status:'completed'}}}),20);
    }else if(request.method==='turn/interrupt')send({id:request.id,error:{code:-32000,message:'Unexpected interrupt'}});
  }else if(mode==='agy'){
    if(request.event!=='user'||busy){process.stderr.write('Invalid or overlapping native prompt');process.exit(7);}
    busy=true;prompts++;
    setTimeout(()=>{busy=false;send({event:'result',result:{conversation_id:'same-session',status:'SUCCESS',response:JSON.stringify({text:request.message.content,pid:process.pid,number:prompts})}});},100);
  }else if(mode==='deepseek'){
    if(request.method==='initialize')send({id:request.id,result:{serverInfo:{name:'fixture'}}});
    else if(request.method==='session/prompt'){
      if(busy){send({id:request.id,error:{code:-32000,message:'Prompt sent before child result handoff'}});return;}
      busy=true;prompts++;const number=prompts,id=params.sessionId;
      send({id:request.id,result:{messageId:'prompt-'+number}});
      // A stale idle notification before the next native turn must not close it.
      if(number>1)status(id,'idle');
      setTimeout(()=>{
        begin(id);
        if(number===1){
          send({method:'subagent.started',params:{parentSessionId:id,childSessionId:'child'}});
          event('child','subagent/descriptor',{mode:'continuable'});end(id);
        }
        setTimeout(()=>{
          if(number===1){begin(id);event(id,'user/message',{source:{kind:'subagent-settled',senderSessionId:'child'}});send({method:'subagent.finished',params:{parentSessionId:id,childSessionId:'child',status:'ok',stopReason:'completed'}});}
          event(id,'assistant/message',{turn:nativeTurn,message:{id:'answer-'+number,content:[{type:'text',text:JSON.stringify({pid:process.pid,number,text:params.contentBlocks[0].text,images:params.contentBlocks.slice(1).map(block=>block.mimeType)})}]}});
          busy=false;end(id);
        },100);
      },10);
    }else if(request.method==='shutdown'){
      send({id:request.id,...busy?{error:{code:-32000,message:'Premature shutdown'}}:{result:{}}});process.stdout.end(()=>process.exit(0));
    }
  }
});

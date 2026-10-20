// A completed turn is only one boundary in a resident SDK session. Children
// can keep working while their parent is idle, then wake it for another turn.
export class DeepseekLifecycle {
  constructor(sessionId) {
    this.sessionId=sessionId;
    this.parent={started:false,open:false,status:null,turn:0,end:null,requiredTurn:0};
    this.children=new Map();
  }
  owns(id){return id===this.sessionId||this.children.has(id);}
  observe(method,params){
    const parent=this.parent,children=this.children;
    if(method==='subagent.started'&&this.owns(params.parentSessionId)){
      if(!children.has(params.childSessionId))children.set(params.childSessionId,{
        parentId:params.parentSessionId,depth:params.parentSessionId===this.sessionId?0:children.get(params.parentSessionId).depth+1,
        state:{},active:true,delivered:false
      });
      return;
    }
    if(method==='subagent.finished'){
      const child=children.get(params.childSessionId);
      if(!child?.active)return;
      child.active=false;
      // One-shot background jobs announce completion before delivering their
      // notice. An already-ended parent turn cannot account for that result.
      if(parent.end&&child.parentId===this.sessionId&&!child.delivered)
        parent.requiredTurn=Math.max(parent.requiredTurn,parent.turn+1);
      return;
    }
    if(!this.owns(params.sessionId))return;
    const child=children.get(params.sessionId);
    if(method==='session.status'){
      if(child){
        // Idle may mean waiting for grandchildren. Only subagent.finished
        // closes residency; a cold-resumed child becomes active again.
        if(params.status==='running'&&!child.active){child.active=true;child.delivered=false;}
      }else parent.status=params.status;
      return;
    }
    if(method!=='session.event')return;
    const event=params.event,data=event?.data||{};
    if(child&&event?.type==='subagent/descriptor')child.mode=data.mode;
    if(event?.type==='subagent/catalog'){
      const known=children.get(data.childId);
      if(known?.parentId===params.sessionId){known.mode=data.mode;known.name=data.label;}
    }
    if(event?.type==='user/message'&&data.source?.kind==='subagent-settled'){
      const sender=children.get(data.source.senderSessionId);
      if(sender?.parentId===params.sessionId)sender.delivered=true;
    }
    if(child)return;
    if(event?.type==='turn/start'){
      parent.started=true;parent.open=true;parent.end=null;parent.turn++;
    }
    if(event?.type==='turn/end'&&parent.started){
      parent.open=false;parent.end=typeof data.reason==='string'?{kind:data.reason}:data.reason||{kind:'unknown'};
    }
  }
  completion(){
    const parent=this.parent;
    if(!parent.end)return null;
    // A fatal parent outcome cannot perform a later handoff. Preserve the
    // native failure and let the owner close the failed execution tree.
    if(parent.end.kind!=='completed')return parent.end;
    if(parent.open||parent.status!=='idle'||parent.turn<parent.requiredTurn)return null;
    for(const child of this.children.values()){
      if(child.active||child.mode==='continuable'&&!child.delivered)return null;
    }
    return parent.end;
  }
}

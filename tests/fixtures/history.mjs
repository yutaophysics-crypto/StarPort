export const historyThreads=Array.from({length:5},(_,i)=>({id:'history-'+i,name:i===4?'Archived sample':i===3?'Unavailable record':['星港导入示例','论文讨论 <script>unsafe()</script>','Folder-independent group'][i],cwd:i===1?'C:\\research\\paper':'C:\\projects\\starport',createdAt:1700000000+i,updatedAt:1700001000+i,historyMode:'paginated',preview:'Hello',archived:i===4}));
export function fixtureHistoryConnect(calls=[]){return async()=>({
  async request(method,params){
    calls.push({method,params});
    if(method==='thread/list'){
      const all=historyThreads.filter(t=>t.archived===params.archived&&(!params.searchTerm||t.name.toLowerCase().includes(params.searchTerm.toLowerCase())));
      const offset=Number(params.cursor||0);return {data:all.slice(offset,offset+2),nextCursor:all.length>offset+2?String(offset+2):null};
    }
    const thread=historyThreads.find(t=>t.id===params.threadId);if(!thread||thread.id==='history-3')throw new Error('Fixture record unavailable');
    if(method==='thread/read')return {thread:{...thread,turns:[]}};
    if(method==='thread/turns/list'){
      const second=!!params.cursor;
      return {data:[{id:second?'turn-2':'turn-1',status:'completed',itemsView:'full',startedAt:1700000001,completedAt:1700000003,
        items:[{id:second?'u2':'u1',type:'userMessage',content:[{type:'text',text:second?'Continue with context':'Hello <script>window.__historyXss=true</script>'},{type:'localImage',path:'C:\\missing.png'}]},
          {id:second?'a2':'a1',type:'agentMessage',text:second?'Second page answer':'A reply with $E=mc^2$'},
          {id:'tool',type:'commandExecution',command:'NEVER RUN'}, {id:'reason',type:'reasoning',content:['private reasoning']}]}],nextCursor:second?null:'page-2'};
    }
    throw new Error('Unexpected native method: '+method);
  },async close(){calls.push({method:'close'});}
});}

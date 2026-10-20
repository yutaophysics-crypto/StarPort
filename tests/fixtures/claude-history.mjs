import { ClaudeHistory } from '../../src/claude-history.mjs';
export const claudeId=i=>'10000000-0000-4000-8000-'+String(i).padStart(12,'0');
export const claudeSessions=Array.from({length:35},(_,i)=>({sessionId:claudeId(i),summary:i===0?'Claude 星港导入示例':i===1?'Claude 论文 <script>unsafe()</script>':i===33?'Claude unavailable':'Claude history '+i,
  cwd:i===1?'C:\\research\\paper':'C:\\projects\\starport',createdAt:1700000000000+i,lastModified:1700001000000-i,fileSize:10000}));
export const claudeRecords=[
  {type:'user',uuid:'u1',timestamp:'2023-11-14T22:13:21.000Z',message:{content:'Hello <script>window.__historyXss=true</script>'}},
  {type:'assistant',uuid:'a1',message:{content:[{type:'text',text:'Claude answer with $E=mc^2$'},{type:'thinking',thinking:'Native thinking summary'},{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'NEVER RUN'}}]}},
  {type:'user',uuid:'tool',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'NEVER RUN'}]}},
  {type:'assistant',uuid:'child',parent_tool_use_id:'nested',message:{content:[{type:'text',text:'nested private text'}]}},
  {type:'user',uuid:'u2',message:{content:[{type:'text',text:'Continue with context'},{type:'image',source:{data:'BASE64_SECRET'}}]}},
  {type:'assistant',uuid:'a2',message:{content:[{type:'text',text:'Final Claude answer'}]}}
];
export function fixtureClaudeReader(){return {
  listSessions:async()=>structuredClone(claudeSessions),
  getSessionInfo:async id=>structuredClone(claudeSessions.find(s=>s.sessionId===id)),
  getSessionMessages:async id=>{if(id===claudeId(33))throw new Error('Fixture Claude record unavailable');return structuredClone(claudeRecords);}
};}
export const fixtureClaudeHistory=()=>new ClaudeHistory(fixtureClaudeReader());

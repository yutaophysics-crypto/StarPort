// Isolated test fixture only. Never connects to the production port.
const base='http://127.0.0.1:3211';
const html=await(await fetch(base)).text(),token=/name="hub-token" content="([^"]+)"/.exec(html)[1];
const pair=await(await fetch(base+'/api/edge/pair',{method:'POST',headers:{'X-Hub-Token':token}})).json();
const headers={'Content-Type':'application/json','X-Starport-Extension':'a'.repeat(32),Origin:'chrome-extension://'+'a'.repeat(32)};
const {key}=await(await fetch(base+'/bridge/pair',{method:'POST',headers,body:JSON.stringify({code:pair.code})})).json();headers['X-Starport-Key']=key;
console.log('Isolated Edge fixture connected');let count=0;
while(count<2){
  const data=await(await fetch(base+'/bridge/poll',{method:'POST',headers})).json();
  for(const command of data.commands){count++;const result=command.action==='tabs'?[{id:42,title:'Edge integration fixture',url:'https://example.com/fixture'}]:{title:'Edge integration fixture',url:'https://example.com/fixture',text:'Test page text supplied by the isolated bridge fixture.'};
    await fetch(base+'/bridge/result',{method:'POST',headers,body:JSON.stringify({id:command.id,result})});
  }
}
console.log('Tab listing and capture completed');

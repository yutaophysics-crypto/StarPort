import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountHub } from '../src/accounts/server.mjs';
import { createCollaborationHub } from '../src/collaboration/server.mjs';
import { createHub } from '../src/server.mjs';
const folder=await mkdtemp(join(tmpdir(),'starport-accounts-ui-')),accounts=createAccountHub({port:3221,dataDir:join(folder,'accounts')});await accounts.listen();
const alice=await accounts.store.register({username:'demo-alice',name:'Alice',password:'fixture-password-alice'}),bob=await accounts.store.register({username:'demo-bob',name:'Bob',password:'fixture-password-bob'}),group=createCollaborationHub({port:3222,dataDir:join(folder,'groups'),accountCenter:accounts.origin(),eventsTransport:'poll'});await group.listen();
function importUser(user){group.store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(user.id,user.username,user.name,'','',Date.now());group.store.db.prepare('INSERT INTO account_identities VALUES(?,?,?)').run(accounts.origin(),user.id,user.id);}
importUser(alice.user);importUser(bob.user);const room=group.store.createRoom(alice.user.id,{name:'界面验证群'}),invite=group.store.invite(alice.user.id,room.id);group.store.join(bob.user.id,{token:invite.token});
const registry={list:async()=>[],resolve:()=>null,probe:async()=>({installed:false}),verifications:()=>({}),getConfiguration:()=>({}),models:async()=>({models:[]})},desktop=createHub({port:3223,dataDir:join(folder,'desktop'),accountCenter:accounts.origin(),registry});await desktop.listen();
console.log(JSON.stringify({desktop:'http://127.0.0.1:3223',accounts:accounts.origin(),server:group.origin(),folder,invite:invite.token}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await desktop.close();await group.close();await accounts.close();process.exit(0);});

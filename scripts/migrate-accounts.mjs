import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountStore } from '../src/accounts/store.mjs';
import { CollaborationStore } from '../src/collaboration/store.mjs';
import { accountUrl } from '../src/accounts/protocol.mjs';
export function migrateAccounts({groupFile,accountFile,issuer}){issuer=accountUrl(issuer);const group=new CollaborationStore(groupFile),accounts=new AccountStore(accountFile);
 try{const rows=group.db.prepare('SELECT * FROM users').all(),fresh=rows.filter(r=>r.password_hash);accounts.importUsers(fresh);
   for(const row of rows){const account=accounts.db.prepare('SELECT id,username FROM users WHERE id=?').get(row.id);if(!account||account.username!==row.username)throw Error('账号中心缺少对应旧账号，未修改群聊身份');const identity=group.db.prepare('SELECT * FROM account_identities WHERE user_id=?').get(row.id);if(identity&&(identity.issuer!==issuer||identity.subject!==row.id))throw Error('旧账号已绑定其他账号中心，未覆盖');}
   group.transaction(()=>{for(const row of rows){group.db.prepare('INSERT OR IGNORE INTO account_identities VALUES(?,?,?)').run(issuer,row.id,row.id);group.db.prepare("UPDATE users SET salt='',password_hash='' WHERE id=?").run(row.id);}});return {users:rows.length,rooms:group.db.prepare('SELECT count(*) AS n FROM rooms').get().n,members:group.db.prepare('SELECT count(*) AS n FROM members').get().n};
 }finally{accounts.close();group.close();}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const root=resolve(import.meta.dirname,'..'),data=process.env.HARNESS_HUB_DATA||join(root,'.data');console.log(JSON.stringify(migrateAccounts({groupFile:process.env.STARPORT_COLLAB_DATABASE||join(data,'collaboration/collaboration.sqlite'),accountFile:process.env.STARPORT_ACCOUNT_DATABASE||join(data,'accounts/accounts.sqlite'),issuer:process.env.STARPORT_ACCOUNT_URL})));}

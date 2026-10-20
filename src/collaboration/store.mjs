import { DatabaseSync } from 'node:sqlite';
import { randomBytes,randomUUID,createHash,createHmac,scrypt,timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const derive=promisify(scrypt),now=()=>Date.now(),uuid=()=>randomUUID(),secret=()=>randomBytes(32).toString('base64url');
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const text=(value,name,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw fail(name+'无效');return value.trim();};
const id=value=>text(value,'标识',100);
const providers=new Set(['codex','claude','antigravity','deepseek']);
const terminal=new Set(['complete','error','interrupted','canceled']);
const publicUser=row=>({id:row.id,username:row.username,name:row.name});

export class CollaborationStore {
  constructor(file,{clock=now}={}){
    if(file!==':memory:')mkdirSync(dirname(file),{recursive:true});this.clock=clock;this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=8000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf_hash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_settings(room_id TEXT PRIMARY KEY REFERENCES rooms(id),description TEXT NOT NULL DEFAULT '',dissolved INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members(room_id TEXT NOT NULL REFERENCES rooms(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,joined INTEGER NOT NULL,PRIMARY KEY(room_id,user_id));
      CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),creator_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,remaining INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL DEFAULT 0,boot_id TEXT,published TEXT NOT NULL DEFAULT '{}',created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(user_id TEXT PRIMARY KEY REFERENCES users(id),device_id TEXT NOT NULL REFERENCES devices(id));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,room_id TEXT NOT NULL REFERENCES rooms(id),user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,provider TEXT,job_id TEXT,client_id TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,client_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),caller_id TEXT NOT NULL REFERENCES users(id),device_id TEXT NOT NULL REFERENCES devices(id),workspace_id TEXT NOT NULL,provider TEXT NOT NULL,options TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),assistant_id TEXT NOT NULL REFERENCES messages(id),status TEXT NOT NULL,claim_hash TEXT,lease_until INTEGER NOT NULL DEFAULT 0,last_seq INTEGER NOT NULL DEFAULT 0,last_hash TEXT,details TEXT NOT NULL DEFAULT '{}',stop_requested INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),client_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created INTEGER NOT NULL,UNIQUE(job_id,client_id));
      CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id,seq);
      CREATE INDEX IF NOT EXISTS jobs_device ON jobs(device_id,status,created);
      CREATE TABLE IF NOT EXISTS account_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT UNIQUE NOT NULL REFERENCES users(id),PRIMARY KEY(issuer,subject));
      CREATE TABLE IF NOT EXISTS login_challenges(nonce TEXT PRIMARY KEY,client_hash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS window_tickets(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_session_scopes(session_hash TEXT PRIMARY KEY,selection_token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_window_scopes(ticket_hash TEXT PRIMARY KEY,selection_token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invitation_policies(room_id TEXT PRIMARY KEY REFERENCES rooms(id),seed TEXT NOT NULL,interval_ms INTEGER,anchor INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1);
    `);
    this.db.prepare('INSERT OR IGNORE INTO room_settings(room_id,updated) SELECT id,created FROM rooms').run();
    this.db.prepare('INSERT OR IGNORE INTO invitation_policies(room_id,seed,interval_ms,anchor) SELECT id,lower(hex(randomblob(32))),86400000,? FROM rooms').run(this.clock());
    this.rotateInvitations();
  }
  close(){this.db.close();}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  username(value){value=text(value,'账号',64).toLowerCase();if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value))throw fail('账号使用 3–64 位字母、数字、点、下划线或短横线');return value;}
  async register({username,name,password}={}){
    username=this.username(username);name=text(name||username,'显示名称',80);
    if(typeof password!=='string'||password.length<12||password.length>256)throw fail('密码需要 12–256 个字符');
    const salt=randomBytes(16).toString('hex'),key=await derive(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
    const user={id:uuid(),username,name};
    try{this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(user.id,username,name,salt,key.toString('hex'),this.clock());}
    catch(error){if(error.code?.includes('CONSTRAINT'))throw fail('这个账号已被使用',409);throw error;}
    return this.newSession(user);
  }
  async login({username,password}={}){
    username=this.username(username);if(typeof password!=='string'||password.length>256)throw fail('账号或密码错误',401);
    const row=this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const key=await derive(password,row?.salt||'no-such-starport-user',64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
    if(!row||!timingSafeEqual(key,Buffer.from(row.password_hash,'hex')))throw fail('账号或密码错误',401);
    return this.newSession(publicUser(row));
  }
  csrf(token){return hash(token+'.csrf');}
  newSession(user,selectionToken){const token=secret(),csrf=this.csrf(token);this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),user.id,hash(csrf),this.clock()+30*86400000);if(selectionToken)this.db.prepare('INSERT INTO group_session_scopes VALUES(?,?)').run(hash(token),selectionToken);return {user,token,csrf};}
  selectionToken(user){return this.db.prepare('SELECT selection_token AS token FROM group_session_scopes WHERE session_hash=?').get(user.sessionHash)?.token||null;}
  session(token){const row=this.db.prepare('SELECT s.*,u.id,u.username,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(hash(token||''),this.clock());if(!row)throw fail('请登录星港账号',401);return {...publicUser(row),csrfHash:row.csrf_hash,sessionHash:row.token_hash};}
  checkCsrf(user,csrf){const a=Buffer.from(hash(csrf||'')),b=Buffer.from(user.csrfHash);if(a.length!==b.length||!timingSafeEqual(a,b))throw fail('请求已失效，请刷新后重试',403);}
  logout(user){this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.sessionHash);}
  member(userId,roomId){const row=this.db.prepare('SELECT m.*,r.name,r.owner_id,s.description,s.dissolved FROM members m JOIN rooms r ON r.id=m.room_id JOIN room_settings s ON s.room_id=r.id WHERE m.user_id=? AND m.room_id=?').get(userId,roomId);if(!row)throw fail('你不在这个群聊中',403);return row;}
  activeMember(userId,roomId){const row=this.member(userId,roomId);if(row.dissolved)throw fail('群聊已解散，请群主恢复后再操作',409);return row;}
  owner(userId,roomId){const row=this.member(userId,roomId);if(row.owner_id!==userId||row.role!=='owner')throw fail('只有群主可以管理群聊',403);return row;}
  room(userId,roomId){const row=this.member(userId,roomId);return {id:roomId,name:row.name,description:row.description,dissolved:!!row.dissolved,role:row.role,ownerId:row.owner_id,members:this.db.prepare('SELECT u.id,u.username,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.joined').all(roomId)};}
  createRoom(userId,{name}={}){name=text(name,'群聊名称',100);if(this.db.prepare('SELECT count(*) AS n FROM members WHERE user_id=?').get(userId).n>=100)throw fail('最多加入 100 个群聊');return this.transaction(()=>{const roomId=uuid(),time=this.clock();this.db.prepare('INSERT INTO rooms VALUES(?,?,?,?)').run(roomId,name,userId,time);this.db.prepare('INSERT INTO room_settings(room_id,updated) VALUES(?,?)').run(roomId,time);this.db.prepare('INSERT INTO members VALUES(?,?,?,?)').run(roomId,userId,'owner',time);this.db.prepare('INSERT INTO invitation_policies(room_id,seed,interval_ms,anchor) VALUES(?,?,86400000,?)').run(roomId,secret(),time);return this.room(userId,roomId);});}
  updateRoom(userId,roomId,changes){const row=this.owner(userId,roomId);this.activeMember(userId,roomId);
    if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length||Object.keys(changes).some(k=>!['name','description'].includes(k)))throw fail('群聊设置无效');
    const name='name' in changes?text(changes.name,'群聊名称',100):row.name,description='description' in changes?changes.description:row.description;
    if(typeof description!=='string'||description.length>2000||description.includes('\0'))throw fail('群简介最多 2000 个字符');
    return this.transaction(()=>{this.db.prepare('UPDATE rooms SET name=? WHERE id=?').run(name,roomId);this.db.prepare('UPDATE room_settings SET description=?,updated=? WHERE room_id=?').run(description.trim(),this.clock(),roomId);return this.room(userId,roomId);});
  }
  dissolveRoom(userId,roomId,{confirmName}={}){const row=this.owner(userId,roomId);if(confirmName!==row.name)throw fail('请输入当前群聊名称以确认解散');
    return this.transaction(()=>{this.db.prepare('UPDATE room_settings SET dissolved=1,updated=? WHERE room_id=?').run(this.clock(),roomId);this.db.prepare('DELETE FROM invites WHERE room_id=?').run(roomId);
      for(const job of this.db.prepare("SELECT * FROM jobs WHERE room_id=? AND status IN ('queued','claimed','running')").all(roomId)){this.finish(job,job.status==='queued'?'canceled':'interrupted','群聊已解散，任务已停止；已有回复保留。');this.db.prepare("UPDATE actions SET status='error',error=? WHERE job_id=? AND status='pending'").run('群聊已解散',job.id);}return this.room(userId,roomId);});
  }
  restoreRoom(userId,roomId){const row=this.owner(userId,roomId);if(!row.dissolved)return this.room(userId,roomId);
    this.transaction(()=>{this.db.prepare('UPDATE room_settings SET dissolved=0,updated=? WHERE room_id=?').run(this.clock(),roomId);this.db.prepare('UPDATE invitation_policies SET seed=?,generation=0,anchor=? WHERE room_id=?').run(secret(),this.clock(),roomId);});this.rotateInvitations();return this.room(userId,roomId);
  }
  invitationToken(policy){return createHmac('sha256',policy.seed).update(policy.room_id+':'+policy.generation).digest('base64url');}
  rotateInvitations(){const time=this.clock();for(const row of this.db.prepare('SELECT p.*,r.owner_id FROM invitation_policies p JOIN rooms r ON r.id=p.room_id JOIN room_settings s ON s.room_id=r.id WHERE p.enabled=1 AND s.dissolved=0').all()){
    const generation=row.interval_ms?Math.max(0,Math.floor((time-row.anchor)/row.interval_ms)):row.generation;
    const token=this.invitationToken({...row,generation}),expires=row.interval_ms?row.anchor+(generation+1)*row.interval_ms:Number.MAX_SAFE_INTEGER;
    if(generation!==row.generation||!this.db.prepare('SELECT 1 FROM invites WHERE token_hash=?').get(hash(token)))this.transaction(()=>{
      this.db.prepare('UPDATE invitation_policies SET generation=? WHERE room_id=?').run(generation,row.room_id);
      this.db.prepare('DELETE FROM invites WHERE room_id=?').run(row.room_id);
      this.db.prepare('INSERT INTO invites VALUES(?,?,?,?,?)').run(hash(token),row.room_id,row.owner_id,expires,2147483647);
    });
  }}
  invitePolicy(userId,roomId,changes){const room=this.owner(userId,roomId);if(changes!==undefined)this.activeMember(userId,roomId);
    this.db.prepare('INSERT OR IGNORE INTO invitation_policies(room_id,seed,interval_ms,anchor) VALUES(?,?,86400000,?)').run(roomId,secret(),this.clock());
    if(changes!==undefined){if(!changes||typeof changes!=='object'||Object.keys(changes).some(k=>!['intervalHours','rotate','enabled'].includes(k)))throw fail('邀请设置无效');
      const old=this.db.prepare('SELECT * FROM invitation_policies WHERE room_id=?').get(roomId);
      let interval=old.interval_ms;if('intervalHours' in changes){if(changes.intervalHours!==null&&(!Number.isInteger(changes.intervalHours)||changes.intervalHours<1||changes.intervalHours>8760))throw fail('更新间隔需为 1–8760 小时，或选择永久');interval=changes.intervalHours===null?null:changes.intervalHours*3600000;}
      if(('enabled' in changes&&typeof changes.enabled!=='boolean')||('rotate' in changes&&typeof changes.rotate!=='boolean'))throw fail('邀请设置无效');
      const enabled='enabled' in changes?Number(changes.enabled):old.enabled,rotate=!!changes.rotate||interval!==old.interval_ms||enabled!==old.enabled;
      this.transaction(()=>{this.db.prepare('UPDATE invitation_policies SET seed=?,interval_ms=?,anchor=?,generation=?,enabled=? WHERE room_id=?').run(rotate?secret():old.seed,interval,rotate?this.clock():old.anchor,rotate?0:old.generation,enabled,roomId);if(rotate||!enabled)this.db.prepare('DELETE FROM invites WHERE room_id=?').run(roomId);});
    }
    this.rotateInvitations();const row=this.db.prepare('SELECT * FROM invitation_policies WHERE room_id=?').get(roomId),enabled=!!row.enabled&&!room.dissolved;return {token:enabled?this.invitationToken(row):null,enabled,intervalHours:row.interval_ms===null?null:row.interval_ms/3600000,expires:enabled&&row.interval_ms?row.anchor+(row.generation+1)*row.interval_ms:null};
  }
  invite(userId,roomId){return this.invitePolicy(userId,roomId,{enabled:true});}
  join(userId,{token}={}){token=text(token,'邀请',100);this.rotateInvitations();return this.transaction(()=>{const invite=this.db.prepare('SELECT i.* FROM invites i JOIN room_settings s ON s.room_id=i.room_id WHERE i.token_hash=? AND i.expires>? AND i.remaining>0 AND s.dissolved=0').get(hash(token),this.clock());if(!invite)throw fail('邀请已失效或已撤销',404);const existing=this.db.prepare('SELECT 1 FROM members WHERE room_id=? AND user_id=?').get(invite.room_id,userId);if(!existing){if(this.db.prepare('SELECT count(*) AS n FROM members WHERE room_id=?').get(invite.room_id).n>=100)throw fail('群聊已满');if(this.db.prepare('SELECT count(*) AS n FROM members WHERE user_id=?').get(userId).n>=100)throw fail('最多加入 100 个群聊');this.db.prepare('INSERT INTO members VALUES(?,?,?,?)').run(invite.room_id,userId,'member',this.clock());this.db.prepare('UPDATE invites SET remaining=remaining-1 WHERE token_hash=?').run(hash(token));}return this.room(userId,invite.room_id);});}
  revokeInvites(userId,roomId){this.invitePolicy(userId,roomId,{enabled:false});}
  challenge(){const nonce=secret(),client=secret();this.db.prepare('DELETE FROM login_challenges WHERE expires<=?').run(this.clock());this.db.prepare('INSERT INTO login_challenges VALUES(?,?,?)').run(nonce,hash(client),this.clock()+300000);return {nonce,client};}
  federationSession(claims,client){return this.transaction(()=>{const row=this.db.prepare('SELECT * FROM login_challenges WHERE nonce=? AND expires>?').get(claims.nonce,this.clock());if(!row||row.client_hash!==hash(client||''))throw fail('登录验证已失效，请重新登录',401);
    const identity=this.db.prepare('SELECT u.* FROM account_identities a JOIN users u ON u.id=a.user_id WHERE issuer=? AND subject=?').get(claims.iss,claims.sub);let user=identity;
    if(!user){if(this.db.prepare('SELECT 1 FROM users WHERE id=? OR username=?').get(claims.sub,claims.username))throw fail('此服务的旧账号尚未迁移到账号中心，请联系管理员',409);user={id:claims.sub,username:claims.username,name:claims.name};this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(user.id,user.username,user.name,'','',this.clock());this.db.prepare('INSERT INTO account_identities VALUES(?,?,?)').run(claims.iss,claims.sub,user.id);}
    this.db.prepare('UPDATE users SET name=? WHERE id=?').run(claims.name,user.id);this.db.prepare('DELETE FROM login_challenges WHERE nonce=?').run(claims.nonce);return this.newSession({...publicUser(user),name:claims.name},claims.selectionToken);});}
  windowTicket(userId,selectionToken){if(selectionToken!==undefined&&selectionToken!==null&&(typeof selectionToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(selectionToken)))throw fail('群聊访问记录授权无效');const token=secret();this.db.prepare('DELETE FROM window_tickets WHERE expires<=?').run(this.clock());this.db.prepare('INSERT INTO window_tickets VALUES(?,?,?)').run(hash(token),userId,this.clock()+30000);if(selectionToken)this.db.prepare('INSERT INTO group_window_scopes VALUES(?,?)').run(hash(token),selectionToken);return {token};}
  redeemWindow(token,existingToken){return this.transaction(()=>{const row=this.db.prepare('SELECT u.*,w.token_hash FROM window_tickets w JOIN users u ON u.id=w.user_id WHERE w.token_hash=? AND w.expires>?').get(hash(token||''),this.clock());if(!row)throw fail('打开窗口的凭证已失效，请从星港重新打开',401);const scope=this.db.prepare('SELECT selection_token FROM group_window_scopes WHERE ticket_hash=?').get(row.token_hash);this.db.prepare('DELETE FROM window_tickets WHERE token_hash=?').run(row.token_hash);this.db.prepare('DELETE FROM group_window_scopes WHERE ticket_hash=?').run(row.token_hash);let existing;try{existing=this.session(existingToken);}catch{}if(existing?.id===row.id){if(scope)this.db.prepare('INSERT INTO group_session_scopes VALUES(?,?) ON CONFLICT(session_hash) DO UPDATE SET selection_token=excluded.selection_token').run(existing.sessionHash,scope.selection_token);return {user:publicUser(row),token:existingToken,csrf:this.csrf(existingToken)};}return this.newSession(publicUser(row),scope?.selection_token);});}
  removeMember(userId,roomId,targetId=userId){const room=this.member(userId,roomId);if(userId!==targetId&&room.role!=='owner')throw fail('只有群主可以移除成员',403);if(room.owner_id===targetId)throw fail('群主不能退出或移除自己');this.transaction(()=>{this.db.prepare('DELETE FROM members WHERE room_id=? AND user_id=?').run(roomId,targetId);for(const job of this.db.prepare("SELECT * FROM jobs WHERE room_id=? AND caller_id=? AND status NOT IN ('complete','error','interrupted','canceled')").all(roomId,targetId))this.finish(job,job.status==='queued'?'canceled':'interrupted','调用者已退出或被移出群聊。');});}
  roomMessages(userId,roomId,{after=0,before=0,limit=100}={}){
    this.member(userId,roomId);after=Number(after);before=Number(before);limit=Number(limit);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(limit)||limit<1||limit>200||after&&before)throw fail('分页参数无效');
    const candidates=after?this.db.prepare('SELECT seq,length(content) AS chars FROM messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?').all(roomId,after,limit):this.db.prepare('SELECT seq,length(content) AS chars FROM messages WHERE room_id=? AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT ?').all(roomId,before,before,limit);
    let chars=0;const selected=[];for(const row of candidates){if(selected.length&&chars+row.chars>2000000)break;chars+=row.chars;selected.push(row.seq);}if(!selected.length)return [];
    return this.db.prepare('SELECT m.*,u.name AS author FROM messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=? AND m.seq BETWEEN ? AND ? ORDER BY m.seq').all(roomId,Math.min(...selected),Math.max(...selected)).map(row=>this.messageView(row));
  }
  messagePage(userId,roomId,options){const messages=this.roomMessages(userId,roomId,options);return {messages,hasOlder:!!messages.length&&!!this.db.prepare('SELECT 1 FROM messages WHERE room_id=? AND seq<? LIMIT 1').get(roomId,messages[0].seq)};}
  messageView(row){return {id:row.id,seq:row.seq,roomId:row.room_id,userId:row.user_id,author:row.author,kind:row.kind,content:row.content,status:row.status,provider:row.provider,jobId:row.job_id,created:row.created,updated:row.updated};}
  insertMessage(userId,roomId,content,{kind='user',status='complete',provider=null,jobId=null,clientId=null}={}){const messageId=uuid(),time=this.clock();this.db.prepare('INSERT INTO messages(id,room_id,user_id,kind,content,status,provider,job_id,client_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(messageId,roomId,userId,kind,content,status,provider,jobId,clientId,time,time);return messageId;}
  send(userId,roomId,{content,clientId}={}){this.activeMember(userId,roomId);content=text(content,'消息',20000);clientId=id(clientId);const old=this.db.prepare('SELECT * FROM messages WHERE user_id=? AND client_id=?').get(userId,clientId);if(old){if(old.room_id!==roomId||old.content!==content||old.job_id)throw fail('消息标识已用于其他请求',409);return this.getMessage(old.id);}return this.getMessage(this.insertMessage(userId,roomId,content,{clientId}));}
  getMessage(messageId){return this.messageView(this.db.prepare('SELECT m.*,u.name AS author FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(messageId));}
  registerDevice(userId,{name}={}){name=text(name,'电脑名称',100);if(this.db.prepare('SELECT count(*) AS n FROM devices WHERE user_id=? AND revoked=0').get(userId).n>=20)throw fail('最多连接 20 台电脑');const deviceId=uuid(),token=secret();this.db.prepare('INSERT INTO devices(id,user_id,name,token_hash,created) VALUES(?,?,?,?,?)').run(deviceId,userId,name,hash(token),this.clock());return {id:deviceId,name,token};}
  device(token){const row=this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked=0').get(hash(token||''));if(!row)throw fail('电脑连接已失效，请重新登录连接',401);return row;}
  ownedDevice(userId,deviceId){const row=this.db.prepare('SELECT * FROM devices WHERE id=? AND user_id=? AND revoked=0').get(deviceId,userId);if(!row)throw fail('这台电脑不属于当前账号',403);return row;}
  deviceView(row){return {id:row.id,name:row.name,online:row.last_seen>this.clock()-30000,lastSeen:row.last_seen,...JSON.parse(row.published)};}
  devices(userId){return this.db.prepare('SELECT * FROM devices WHERE user_id=? AND revoked=0 ORDER BY created').all(userId).map(row=>this.deviceView(row));}
  bind(userId,{deviceId}={}){deviceId=id(deviceId);this.ownedDevice(userId,deviceId);this.db.prepare('INSERT INTO bindings VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET device_id=excluded.device_id').run(userId,deviceId);return {deviceId};}
  revokeDevice(userId,deviceId){this.ownedDevice(userId,deviceId);this.transaction(()=>{this.db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(deviceId);this.db.prepare('DELETE FROM bindings WHERE device_id=?').run(deviceId);for(const job of this.db.prepare("SELECT * FROM jobs WHERE device_id=? AND status NOT IN ('complete','error','interrupted','canceled')").all(deviceId))this.finish(job,'interrupted','电脑已断开绑定，任务没有自动重复执行。');});}
  publication(input){
    if(!input||!Array.isArray(input.workspaces)||input.workspaces.length>20||!Array.isArray(input.providers)||input.providers.length>4)throw fail('电脑能力格式无效');
    const workspaces=input.workspaces.map(row=>({id:id(row.id),name:text(row.name,'目录名称',100)}));if(new Set(workspaces.map(x=>x.id)).size!==workspaces.length)throw fail('目录标识重复');
    const rows=input.providers.map(row=>{if(!providers.has(row.id))throw fail('未知模型供应商');return {id:row.id,name:text(row.name,'工具名称',100),available:row.available===true,models:(Array.isArray(row.models)?row.models:[]).slice(0,100).map(m=>({id:text(m.id,'模型',500),name:text(m.name||m.id,'模型名称',200),...m.provider?{provider:text(m.provider,'模型服务',500)}:{}}))};});
    return {workspaces,providers:rows};
  }
  expire(){const time=this.clock();this.rotateInvitations();this.db.prepare('DELETE FROM login_challenges WHERE expires<=?').run(time);this.db.prepare('DELETE FROM window_tickets WHERE expires<=?').run(time);this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(time);this.db.prepare('DELETE FROM group_session_scopes WHERE session_hash NOT IN (SELECT token_hash FROM sessions)').run();this.db.prepare('DELETE FROM group_window_scopes WHERE ticket_hash NOT IN (SELECT token_hash FROM window_tickets)').run();for(const job of this.db.prepare("SELECT * FROM jobs WHERE status IN ('claimed','running') AND lease_until<?").all(time))this.finish(job,'interrupted','电脑连接中断，已有回复已保留。为避免重复执行，请确认后重新发起。');}
  state(user){this.expire();const rows=this.db.prepare('SELECT r.*,s.description,s.dissolved,m.role,u.username AS owner_username,(SELECT max(seq) FROM messages WHERE room_id=r.id) AS lastSeq FROM members m JOIN rooms r ON r.id=m.room_id JOIN room_settings s ON s.room_id=r.id JOIN users u ON u.id=r.owner_id WHERE m.user_id=? ORDER BY COALESCE((SELECT max(updated) FROM messages WHERE room_id=r.id),r.created) DESC').all(user.id);return {user:publicUser(user),rooms:rows.map(r=>({id:r.id,name:r.name,description:r.description,dissolved:!!r.dissolved,role:r.role,ownerId:r.owner_id,ownerUsername:r.owner_username,lastSeq:r.lastSeq||0})),devices:this.devices(user.id),binding:this.db.prepare('SELECT device_id AS deviceId FROM bindings WHERE user_id=?').get(user.id)||null};}
  invoke(userId,roomId,{content,clientId,provider,workspaceId,options={}}={}){
    this.activeMember(userId,roomId);content=text(content,'消息',20000);clientId=id(clientId);workspaceId=id(workspaceId);if(!providers.has(provider))throw fail('未知模型供应商');
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['model','effort','provider'].includes(key)))throw fail('手机只能选择模型与思考强度，权限由电脑设置');
    for(const [key,value] of Object.entries(options))if(typeof value!=='string'||value.length>500||/[\0\r\n]/.test(value)||value.trim().startsWith('-'))throw fail(key+'无效');
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM messages WHERE user_id=? AND client_id=?').get(userId,clientId);
      if(old){const job=old.job_id&&this.db.prepare('SELECT * FROM jobs WHERE id=?').get(old.job_id);if(!job||old.room_id!==roomId||old.content!==content||job.provider!==provider||job.workspace_id!==workspaceId||job.options!==JSON.stringify(options))throw fail('消息标识已用于其他请求',409);return this.jobView(userId,job);}
      const binding=this.db.prepare('SELECT device_id FROM bindings WHERE user_id=?').get(userId);if(!binding)throw fail('请先绑定你自己的电脑',409);
      const device=this.ownedDevice(userId,binding.device_id),published=JSON.parse(device.published);
      if(!published.workspaces?.some(x=>x.id===workspaceId)||!published.providers?.some(x=>x.id===provider&&x.available))throw fail('所选电脑未开放这个工作目录或工具',409);
      if(this.db.prepare("SELECT count(*) AS n FROM jobs WHERE caller_id=? AND status IN ('queued','claimed','running')").get(userId).n>=10)throw fail('已有 10 个等待或运行中的调用，请稍后再发');
      const jobId=uuid(),messageId=this.insertMessage(userId,roomId,content,{clientId,jobId}),assistantId=this.insertMessage(userId,roomId,'',{kind:'agent',status:'queued',provider,jobId}),time=this.clock();
      this.db.prepare('INSERT INTO jobs(id,room_id,caller_id,device_id,workspace_id,provider,options,message_id,assistant_id,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId,roomId,userId,device.id,workspaceId,provider,JSON.stringify(options),messageId,assistantId,'queued',time,time);
      return this.job(userId,jobId);
    });
  }
  job(userId,jobId){const row=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);if(!row)throw fail('调用不存在',404);this.member(userId,row.room_id);return this.jobView(userId,row);}
  jobView(userId,row){const details=JSON.parse(row.details);return {id:row.id,roomId:row.room_id,callerId:row.caller_id,provider:row.provider,status:row.status,assistantId:row.assistant_id,message:this.getMessage(row.assistant_id),updated:row.updated,progress:details.progress||[],error:details.error||null,...userId===row.caller_id?{deviceId:row.device_id,workspaceId:row.workspace_id,approvals:details.approvals||[],notices:details.notices||[],actions:this.db.prepare('SELECT id,status,error FROM actions WHERE job_id=? ORDER BY created').all(row.id)}:{}};}
  finish(job,status,error=''){const details=JSON.parse(job.details);details.approvals=[];if(error)details.error=error;this.db.prepare('UPDATE jobs SET status=?,details=?,updated=? WHERE id=?').run(status,JSON.stringify(details),this.clock(),job.id);this.db.prepare('UPDATE messages SET status=?,updated=? WHERE id=?').run(status,this.clock(),job.assistant_id);}
  cancelRow(job){if(terminal.has(job.status))return;if(job.status==='queued')this.finish(job,'canceled');else this.db.prepare('UPDATE jobs SET stop_requested=1 WHERE id=?').run(job.id);}
  action(userId,jobId,{clientId,action,requestId,decision,answers}={}){
    const job=this.db.prepare('SELECT * FROM jobs WHERE id=? AND caller_id=?').get(jobId,userId);if(!job)throw fail('只有调用者可以控制这个任务',403);this.member(userId,job.room_id);clientId=id(clientId);
    if(!['stop','approval'].includes(action))throw fail('任务操作无效');
    const payload={action};if(action==='approval'){if(!['accept','decline','skip'].includes(decision))throw fail('审批选项无效');payload.requestId=id(String(requestId||''));payload.decision=decision;if(answers!==undefined){if(!answers||typeof answers!=='object'||Array.isArray(answers)||JSON.stringify(answers).length>20000)throw fail('问题回答无效');payload.answers=answers;}}
    const encoded=JSON.stringify(payload),old=this.db.prepare('SELECT * FROM actions WHERE job_id=? AND client_id=?').get(jobId,clientId);if(old){if(old.payload!==encoded)throw fail('操作标识已被使用',409);return {id:old.id,status:old.status};}
    if(terminal.has(job.status))throw fail('任务已经结束',409);
    if(action==='approval'&&!JSON.parse(job.details).approvals?.some(x=>String(x.id)===payload.requestId))throw fail('审批请求已经失效',409);
    const actionId=uuid();this.db.prepare('INSERT INTO actions(id,job_id,client_id,payload,created) VALUES(?,?,?,?,?)').run(actionId,jobId,clientId,encoded,this.clock());if(action==='stop')this.cancelRow(job);if(job.status==='queued')this.db.prepare("UPDATE actions SET status='done' WHERE id=?").run(actionId);return {id:actionId,status:job.status==='queued'?'done':'pending'};
  }
  poll(device,{bootId,published,claim=true}={}){
    bootId=id(bootId);const publication=this.publication(published);this.expire();
    return this.transaction(()=>{
      const current=this.db.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').get(device.id);if(!current)throw fail('电脑连接已撤销',401);
      if(current.boot_id&&current.boot_id!==bootId)for(const job of this.db.prepare("SELECT * FROM jobs WHERE device_id=? AND status IN ('claimed','running')").all(device.id))this.finish(job,'interrupted','电脑执行服务已重启，未自动重复执行旧任务。');
      this.db.prepare('UPDATE devices SET last_seen=?,boot_id=?,published=? WHERE id=?').run(this.clock(),bootId,JSON.stringify(publication),device.id);
      this.db.prepare("UPDATE jobs SET lease_until=? WHERE device_id=? AND status IN ('claimed','running')").run(this.clock()+120000,device.id);
      const controls=this.db.prepare("SELECT j.id,j.stop_requested FROM jobs j WHERE j.device_id=? AND j.status IN ('claimed','running')").all(device.id).map(row=>({jobId:row.id,stopRequested:!!row.stop_requested,actions:this.db.prepare("SELECT id,payload FROM actions WHERE job_id=? AND status='pending' ORDER BY created").all(row.id).map(a=>({id:a.id,...JSON.parse(a.payload)}))}));
      let job=null;
      if(claim&&!controls.length){const row=this.db.prepare("SELECT j.* FROM jobs j JOIN members m ON m.room_id=j.room_id AND m.user_id=j.caller_id WHERE j.device_id=? AND j.status='queued' ORDER BY j.created,j.rowid LIMIT 1").get(device.id);if(row){const claimToken=secret();this.db.prepare("UPDATE jobs SET status='claimed',claim_hash=?,lease_until=?,updated=? WHERE id=?").run(hash(claimToken),this.clock()+120000,this.clock(),row.id);this.db.prepare("UPDATE messages SET status='claimed',updated=? WHERE id=?").run(this.clock(),row.assistant_id);
        const userSeq=this.db.prepare('SELECT seq FROM messages WHERE id=?').get(row.message_id).seq;
        const candidates=this.db.prepare("SELECT seq,length(content) AS chars FROM messages WHERE room_id=? AND seq<=? AND status='complete' ORDER BY seq DESC LIMIT 120").all(row.room_id,userSeq);let chars=0,lowest=userSeq;for(const item of candidates){if(chars+item.chars>160000&&chars)break;chars+=item.chars;lowest=item.seq;}
        const messages=this.db.prepare("SELECT m.*,u.name AS author FROM messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=? AND m.seq BETWEEN ? AND ? AND m.status='complete' ORDER BY m.seq").all(row.room_id,lowest,userSeq);
        const omitted=this.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=? AND seq<? AND status='complete'").get(row.room_id,lowest).n;
        job={id:row.id,roomId:row.room_id,callerId:row.caller_id,provider:row.provider,workspaceId:row.workspace_id,options:JSON.parse(row.options),claimToken,message:this.getMessage(row.message_id),history:messages.map(m=>this.messageView(m)),omitted};}}
      return {job,controls};
    });
  }
  deviceJob(device,jobId,claimToken){const job=this.db.prepare('SELECT * FROM jobs WHERE id=? AND device_id=? AND caller_id=?').get(jobId,device.id,device.user_id);if(!job||job.claim_hash!==hash(claimToken||''))throw fail('任务不属于这台电脑',403);return job;}
  start(device,jobId,{claimToken}={}){const job=this.deviceJob(device,jobId,claimToken);if(job.status==='running')return {status:'running'};if(job.status!=='claimed'||job.lease_until<this.clock())throw fail('任务领取已失效',409);if(job.stop_requested||!this.db.prepare('SELECT 1 FROM members WHERE room_id=? AND user_id=?').get(job.room_id,job.caller_id)){this.finish(job,'canceled');throw fail('任务已取消',409);}this.db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(this.clock(),jobId);this.db.prepare("UPDATE messages SET status='running',updated=? WHERE id=?").run(this.clock(),job.assistant_id);return {status:'running'};}
  update(device,jobId,{claimToken,seq,status,content='',progress=[],approvals=[],notices=[],error=''}={}){
    const job=this.deviceJob(device,jobId,claimToken);if(!Number.isSafeInteger(seq)||seq<1||!['running','complete','error','interrupted'].includes(status)||typeof content!=='string'||content.length>2000000||content.includes('\0')||!Array.isArray(progress)||progress.length>100||!Array.isArray(approvals)||approvals.length>20||typeof error!=='string'||error.length>8000)throw fail('执行结果格式无效');
    const safeProgress=progress.map(x=>({id:String(x.id||'').slice(0,100),name:String(x.name||x.kind||'').slice(0,200),status:String(x.status||'').slice(0,30)}));
    if(JSON.stringify(approvals).length>100000)throw fail('审批内容过长');
    if(!Array.isArray(notices)||notices.length>10||notices.some(x=>typeof x!=='string'||x.length>5000))throw fail('工具提示格式无效');
    const details={progress:safeProgress,approvals:status==='running'?approvals:[],notices,error},encoded=JSON.stringify({status,content,details}),digest=hash(encoded);
    if(seq<job.last_seq)return {seq:job.last_seq,status:job.status};if(seq===job.last_seq){if(digest!==job.last_hash)throw fail('相同事件序号携带不同内容',409);return {seq,status:job.status};}
    if(terminal.has(job.status)||job.status!=='running'||job.lease_until<this.clock())throw fail('任务已经结束或连接失效',409);if(seq!==job.last_seq+1)throw fail('执行事件序号不连续',409);
    this.transaction(()=>{this.db.prepare('UPDATE jobs SET status=?,last_seq=?,last_hash=?,details=?,updated=? WHERE id=?').run(status,seq,digest,JSON.stringify(details),this.clock(),jobId);this.db.prepare('UPDATE messages SET content=?,status=?,updated=? WHERE id=?').run(content,status,this.clock(),job.assistant_id);});return {seq,status};
  }
  acknowledge(device,jobId,actionId,{error=''}={}){const job=this.db.prepare('SELECT * FROM jobs WHERE id=? AND device_id=?').get(jobId,device.id);if(!job)throw fail('任务不属于这台电脑',403);if(typeof error!=='string'||error.length>1000)throw fail('操作结果无效');this.db.prepare("UPDATE actions SET status=?,error=? WHERE id=? AND job_id=?").run(error?'error':'done',error,actionId,jobId);return {ok:true};}
}

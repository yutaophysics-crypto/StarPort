import {randomUUID,createHash} from 'node:crypto';
import {validateInput,validateReply} from './interactions.mjs';
const conflict=message=>Object.assign(new Error(message),{status:409});

// Unsent drafts are separate from conversation history and native input queues.
export class MessageQueue {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS queued_messages (
      id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,
      client_id TEXT NOT NULL,details TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,
      UNIQUE(chat_id,client_id));
      CREATE INDEX IF NOT EXISTS queue_chat ON queued_messages(chat_id,created);
      CREATE TABLE IF NOT EXISTS queue_versions (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,version INTEGER NOT NULL);`);
    for(const row of this.db.prepare("SELECT DISTINCT chat_id FROM queued_messages WHERE state!='held'").all())
      this.hold(row.chat_id,'服务已重新启动，请确认后继续发送。',true);
  }
  decode(row){return row?{...row,details:JSON.parse(row.details)}:null;}
  list(chatId){return this.db.prepare('SELECT * FROM queued_messages WHERE chat_id=? ORDER BY rowid').all(chatId).map(row=>this.decode(row));}
  get(chatId,id){return this.decode(this.db.prepare('SELECT * FROM queued_messages WHERE chat_id=? AND id=?').get(chatId,id));}
  receipt(chatId,clientId){return this.decode(this.db.prepare('SELECT * FROM queued_messages WHERE chat_id=? AND client_id=?').get(chatId,clientId));}
  snapshot(chatId){return {queue:this.list(chatId),queueVersion:this.db.prepare('SELECT version FROM queue_versions WHERE chat_id=?').get(chatId)?.version||0};}
  bump(chatId){this.db.prepare('INSERT INTO queue_versions VALUES(?,1) ON CONFLICT(chat_id) DO UPDATE SET version=version+1').run(chatId);}
  // attachments: metadata of rows the caller has already checked; they go out with the message.
  add(chatId,{text,clientId,replyTo,attachments=[]}={}){
    validateInput(text);if(typeof clientId!=='string'||!/^[-\w]{1,100}$/.test(clientId))throw new Error('排队消息标识无效');
    const inputHash=createHash('sha256').update(attachments.length?text+'\0'+attachments.map(row=>row.id).join(','):text).digest('hex');
    const old=this.receipt(chatId,clientId);if(old){if((old.details.inputHash||createHash('sha256').update(old.content).digest('hex'))!==inputHash)throw conflict('消息标识已用于另一条消息');return old;}
    const sent=this.db.prepare("SELECT * FROM messages WHERE chat_id=? AND json_extract(details,'$.queuedMessage.clientId')=? ORDER BY rowid DESC LIMIT 1").get(chatId,clientId);
    if(sent){const message=this.decode(sent);if(message.details.queuedMessage.inputHash!==inputHash)throw conflict('消息标识已用于另一条消息');return {id:message.details.queuedMessage.id,state:'delivered',message};}
    const chat=this.store.chat(chatId);if(!chat)throw Object.assign(new Error('对话不存在'),{status:404});
    if(this.list(chatId).length>=64)throw conflict('队列已满，请先处理待发送消息');
    const reply=validateReply(this.store,chatId,replyTo),now=new Date().toISOString(),id=randomUUID();
    this.db.prepare('INSERT INTO queued_messages VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,chatId,chat.provider,text,'queued',0,clientId,JSON.stringify({inputHash,...reply?{replyTo:reply}:{},...attachments.length?{attachments}:{}}),now,now);this.bump(chatId);return this.get(chatId,id);
  }
  editable(chatId,id,revision){
    const row=this.get(chatId,id);if(!row)throw Object.assign(new Error('排队消息已发送或删除'),{status:404});
    if(!Number.isSafeInteger(revision)||row.revision!==revision||!['queued','held','editing'].includes(row.state))throw conflict('消息已改变或正在发送，请刷新队列');
    return row;
  }
  change(row,state,details=row.details,content=row.content){
    const updated=this.db.prepare('UPDATE queued_messages SET state=?,details=?,content=?,revision=revision+1,updated=? WHERE id=? AND chat_id=? AND revision=?').run(state,JSON.stringify(details),content,new Date().toISOString(),row.id,row.chat_id,row.revision);
    if(!updated.changes)throw conflict('消息已改变，请刷新队列');this.bump(row.chat_id);return this.get(row.chat_id,row.id);
  }
  beginEdit(chatId,id,revision){const row=this.editable(chatId,id,revision);return this.change(row,'editing',{...row.details,editingFrom:row.state==='editing'?row.details.editingFrom||'held':row.state});}
  cancelEdit(chatId,id,revision){const row=this.editable(chatId,id,revision);return row.state==='editing'?this.change(row,row.details.editingFrom||'held',{...row.details,editingFrom:undefined}):row;}
  edit(chatId,id,revision,text){validateInput(text);const row=this.editable(chatId,id,revision);return this.change(row,row.state==='editing'?row.details.editingFrom||'held':row.state,{...row.details,error:undefined,editingFrom:undefined},text);}
  remove(chatId,id,revision){const row=this.editable(chatId,id,revision);this.erase(row);}
  erase(row){this.db.prepare('DELETE FROM queued_messages WHERE id=? AND chat_id=?').run(row.id,row.chat_id);this.bump(row.chat_id);}
  hold(chatId,error,all=false){
    const changed=this.db.prepare("UPDATE queued_messages SET state='held',revision=revision+1,details=json_set(json_remove(details,'$.editingFrom'),'$.error',?),updated=? WHERE chat_id=? AND "+(all?"state!='held'":"state IN ('queued','editing')")).run(error,new Date().toISOString(),chatId);
    if(changed.changes)this.bump(chatId);
  }
  consume(row,details={}){
    const current=this.get(row.chat_id,row.id);if(!current||current.revision!==row.revision||current.state!=='dispatching')throw conflict('排队消息已改变');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const user=this.store.message(row.chat_id,'user',row.provider,row.content,'complete',{...details,queuedMessage:{id:row.id,clientId:row.client_id,inputHash:row.details.inputHash},...row.details.replyTo?{replyTo:row.details.replyTo}:{}});
      this.erase(row);this.db.exec('COMMIT');return user;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}

// Read receipts belong to Starport, independent of the selected harness.
export class ChatStatus {
  constructor(store){
    this.store=store;
    const exists=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_read_marks'").get();
    store.db.exec(`CREATE TABLE IF NOT EXISTS chat_read_marks (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS messages_chat_role ON messages(chat_id,role);`);
    // Do not turn the entire pre-existing history into unread notifications.
    if(!exists)store.db.exec(`INSERT INTO chat_read_marks(chat_id,message_id)
      SELECT chat_id,id FROM messages m WHERE role='assistant'
      AND rowid=(SELECT rowid FROM messages WHERE chat_id=m.chat_id AND role='assistant' ORDER BY rowid DESC LIMIT 1);`);
  }
  rows(id){
    return this.store.db.prepare(`SELECT c.*, m.id AS last_assistant_id,
      COALESCE(m.rowid,0) AS last_assistant_sequence, m.status AS last_assistant_status,
      r.message_id AS read_message_id, COALESCE(r.revision,0) AS read_revision
      FROM chats c LEFT JOIN messages m ON m.rowid=(SELECT rowid FROM messages
        WHERE chat_id=c.id AND role='assistant' ORDER BY rowid DESC LIMIT 1)
      LEFT JOIN chat_read_marks r ON r.chat_id=c.id
      ${id?'WHERE c.id=?':''} ORDER BY c.updated DESC`).all(...id?[id]:[])
      .map(row=>({...this.store.decodeChat(row),unread:row.last_assistant_status==='complete'&&row.last_assistant_id!==row.read_message_id}));
  }
  summaries(){return this.rows().map(({id,last_assistant_id,last_assistant_sequence,last_assistant_status,read_message_id,read_revision,unread})=>({id,last_assistant_id,last_assistant_sequence,last_assistant_status,read_message_id,read_revision,unread}));}
  read(chatId,messageId){
    if(typeof chatId!=='string'||!chatId)throw Object.assign(new Error('对话不存在'),{status:404});
    const chat=this.rows(chatId)[0];
    if(!chat)throw Object.assign(new Error('对话不存在'),{status:404});
    if(typeof messageId!=='string'||messageId!==chat.last_assistant_id||chat.last_assistant_status!=='complete')throw Object.assign(new Error('回答已更新，请重新查看'),{status:409});
    if(chat.read_message_id!==messageId)this.store.db.prepare(`INSERT INTO chat_read_marks(chat_id,message_id) VALUES(?,?)
      ON CONFLICT(chat_id) DO UPDATE SET message_id=excluded.message_id,revision=chat_read_marks.revision+1`).run(chatId,messageId);
    return this.rows(chatId)[0];
  }
}

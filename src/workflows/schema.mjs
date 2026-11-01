// Tables for companions, room rosters, workflows, their mounts, companion desks and prediction scores.
export function ensureSchema(db){
  db.exec(`CREATE TABLE IF NOT EXISTS companions (id TEXT PRIMARY KEY, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS room_members (group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      added TEXT NOT NULL, PRIMARY KEY(group_id,companion_id));
    CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_mounts (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS companion_desks (companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      desk_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, cursor TEXT, PRIMARY KEY(companion_id,chat_id));
    -- One-way calls use a separate desk whose session never sees the conversation.
    CREATE TABLE IF NOT EXISTS companion_isolated_desks (companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      desk_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, PRIMARY KEY(companion_id,chat_id));
    CREATE TABLE IF NOT EXISTS prediction_scores (mount_id TEXT NOT NULL, claim_id TEXT NOT NULL, companion_id TEXT NOT NULL, probability REAL NOT NULL,
      outcome INTEGER NOT NULL, brier REAL NOT NULL, resolved TEXT NOT NULL, PRIMARY KEY(mount_id,claim_id));
    -- Per room, whom each caller (the conversation's own model, 'main', or a member) may call mid-task.
    CREATE TABLE IF NOT EXISTS room_calls (group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, caller_id TEXT NOT NULL,
      callee_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE, PRIMARY KEY(group_id,caller_id,callee_id));
    CREATE INDEX IF NOT EXISTS workflow_mounts_chat ON workflow_mounts(chat_id);
    CREATE TRIGGER IF NOT EXISTS desk_chats_follow_parent AFTER DELETE ON chats BEGIN
      DELETE FROM chats WHERE json_extract(options,'$.desk.parentChatId')=OLD.id; END;`);
  // Per room, each companion may read confirmed long-term memory and/or propose candidates.
  const columns=new Set(db.prepare('PRAGMA table_info(room_members)').all().map(row=>row.name));
  if(!columns.has('memory_read'))db.exec('ALTER TABLE room_members ADD COLUMN memory_read INTEGER NOT NULL DEFAULT 1');
  if(!columns.has('memory_propose'))db.exec('ALTER TABLE room_members ADD COLUMN memory_propose INTEGER NOT NULL DEFAULT 0');
}

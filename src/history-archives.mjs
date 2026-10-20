// Per-conversation history files follow the conversation, independently of project markers
// and shared workflow ledgers. SQLite remains the authoritative conversation record.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const historyArchivePath = chat => join(chat.workspace, '.starport', 'history', `${chat.id}.md`);
const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const valid = workspace => typeof workspace === 'string' && !!workspace && isAbsolute(workspace);

// Prepare the new file before changing SQLite. Keep the source and any overwritten target
// until the database update succeeds, so a permission error cannot silently change folders.
function place(source, target, save) {
  mkdirSync(dirname(target), { recursive: true });
  const ignore = join(dirname(dirname(target)), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Starport history archives\n*\n');
  const temp = target + '.' + randomUUID() + '.tmp';
  const backup = existsSync(target) ? target + '.' + randomUUID() + '.bak' : null;
  let installed = false, discardBackup = false;
  try {
    if (backup) copyFileSync(target, backup);
    copyFileSync(source, temp);
    renameSync(temp, target);
    installed = true;
    save();
    discardBackup = true;
  } catch (error) {
    if (installed) {
      if (backup) renameSync(backup, target);
      else rmSync(target, { force: true });
    }
    discardBackup = true;
    throw error;
  } finally {
    try { rmSync(temp, { force: true }); } catch {}
    if (backup && discardBackup) try { rmSync(backup, { force: true }); } catch {}
  }
}

export class HistoryArchives {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    // Retain paths whose cleanup failed, so retry/deletion never forgets a stranded file.
    this.db.exec(`CREATE TABLE IF NOT EXISTS history_archive_locations (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      workspace TEXT NOT NULL, PRIMARY KEY(chat_id,workspace))`);
  }
  remember(chat, workspace) {
    if (valid(workspace) && existsSync(historyArchivePath({ ...chat, workspace })))
      this.db.prepare('INSERT OR IGNORE INTO history_archive_locations VALUES(?,?)').run(chat.id, workspace);
  }
  owners(chats) {
    return chats.flatMap(chat => [chat, ...this.db.prepare('SELECT workspace FROM history_archive_locations WHERE chat_id=?').all(chat.id).map(row => ({ id: chat.id, workspace: row.workspace }))]);
  }
  cleanup(chat) {
    const target = historyArchivePath(chat);
    for (const { workspace } of this.db.prepare('SELECT workspace FROM history_archive_locations WHERE chat_id=?').all(chat.id)) {
      const file = historyArchivePath({ ...chat, workspace });
      try {
        if (key(file) !== key(target)) rmSync(file, { force: true });
        this.db.prepare('DELETE FROM history_archive_locations WHERE chat_id=? AND workspace=?').run(chat.id, workspace);
      } catch { /* A later startup or conversation deletion retries this exact owned path. */ }
    }
  }
  change(chat, workspace, save) {
    if (!valid(chat.workspace) || !valid(workspace) || key(chat.workspace) === key(workspace)) return save();
    let source = historyArchivePath(chat);
    const target = historyArchivePath({ ...chat, workspace });
    this.remember(chat, chat.workspace);
    if (!existsSync(source)) {
      const pending = this.owners([chat]).map(owner => historyArchivePath(owner)).filter(file => existsSync(file));
      pending.sort((a,b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      source = pending[0] || source;
    }
    if (existsSync(source)) place(source, target, save);
    else save();
    if (existsSync(target)) this.cleanup({ ...chat, workspace });
  }
  // Repair archives left by older Starport versions. Check only this chat's own filename at
  // known workspace paths (including native-session bindings); never recursively scan files.
  reconcile() {
    const result = { moved: 0, errors: [] };
    for (const chat of this.db.prepare('SELECT id,workspace FROM chats').all()) {
      if (!valid(chat.workspace) || !existsSync(chat.workspace)) continue;
      try {
        const folders = new Set([chat.workspace, ...this.db.prepare('SELECT workspace FROM history_archive_locations WHERE chat_id=?').all(chat.id).map(row => row.workspace)]);
        for (let dir = dirname(resolve(chat.workspace)); ; dir = dirname(dir)) {
          folders.add(dir);
          if (dirname(dir) === dir) break;
        }
        for (const row of this.db.prepare("SELECT DISTINCT json_extract(details,'$.context.binding') AS binding FROM messages WHERE chat_id=? AND json_extract(details,'$.context.binding') IS NOT NULL").all(chat.id)) {
          try { const workspace = JSON.parse(row.binding)[1]; if (valid(workspace)) folders.add(workspace); } catch {}
        }
        for (const folder of folders) this.remember(chat, folder);
        const target = historyArchivePath(chat);
        if (!existsSync(target)) {
          const sources = [...folders].map(workspace => historyArchivePath({ ...chat, workspace })).filter(file => existsSync(file));
          sources.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
          if (sources.length) { place(sources[0], target, () => {}); result.moved++; }
        }
        if (existsSync(target)) this.cleanup(chat);
      } catch (error) { result.errors.push({ chatId: chat.id, error: error.message }); }
    }
    return result;
  }
}

import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { validateOptions } from './providers.mjs';
import { redact } from './process.mjs';
import { settleActivity } from './activity.mjs';

export const MAX_TRANSFER_BYTES = 120 * 1024 * 1024;
const providers = new Set(['codex', 'claude', 'antigravity', 'deepseek']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !value.includes('\0');
const date = value => string(value, 40) && Number.isFinite(Date.parse(value));
const invalid = () => { throw new Error('星港会话文件内容无效或不完整'); };

// Only display data crosses machines. Session controls, memory ids, context
// bridge metadata and credentials are deliberately absent from this schema.
function displayValue(value, depth = 0) {
  if (depth > 24) invalid();
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(item => displayValue(item, depth + 1));
  if (!object(value)) invalid();
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(__proto__|constructor|prototype|env|environment|authorization|cookie|password|secret|token|api[_-]?key|sessionId|native_id)$/i.test(key) || /(?:token|secret|password|credential)$/i.test(key)) continue;
    result[key] = displayValue(item, depth + 1);
  }
  return result;
}
function displayDetails(source = {}) {
  if (!object(source) || Buffer.byteLength(JSON.stringify(source)) > 4 * 1024 * 1024) invalid();
  const result = {};
  for (const key of ['activity', 'tools', 'subagents', 'notices']) {
    if (source[key] === undefined) continue;
    if (!Array.isArray(source[key]) || source[key].length > 10000 || key === 'notices' && source[key].some(item => typeof item !== 'string')) invalid();
    if (key !== 'notices' && source[key].some(item => !object(item))) invalid();
    result[key] = displayValue(source[key]);
  }
  for (const key of ['error', 'model', 'finalAnswer']) if (source[key] !== undefined) {
    if (!string(source[key], 2000000, true)) invalid();
    result[key] = redact(source[key]);
  }
  for (const key of ['startedAt', 'endedAt']) if (Number.isFinite(source[key])) result[key] = source[key];
  if (string(source.runId, 200)) result.runId = source.runId;
  if (source.skippedQuestions !== undefined) {
    if (!Array.isArray(source.skippedQuestions) || source.skippedQuestions.length > 64 || source.skippedQuestions.some(id => !string(id, 200))) invalid();
    result.skippedQuestions = [...source.skippedQuestions];
  }
  if (source.replyTo !== undefined) {
    if (!object(source.replyTo) || !string(source.replyTo.messageId, 200) || !Array.isArray(source.replyTo.questions) || source.replyTo.questions.length > 64 || source.replyTo.questions.some(id => !string(id, 200))) invalid();
    result.replyTo = { messageId: source.replyTo.messageId, questions: [...source.replyTo.questions] };
  }
  for (const key of ['guidance', 'nativeQuestionReply']) if (object(source[key]) && string(source[key].runId, 200)) {
    result[key] = { runId: source[key].runId };
    if (key === 'guidance') result[key].state = ['accepted', 'delivered'].includes(source[key].state) ? 'delivered' : 'not-delivered';
    else if (source[key].skipped === true) result[key].skipped = true;
  }
  settleActivity(result, 'interrupted');
  for (const row of result.subagents || []) if (['running', 'pending', 'paused'].includes(row.status)) row.status = 'interrupted';
  return result;
}
function portableOptions(options = {}) {
  if (!object(options)) invalid();
  const result = {};
  for (const provider of providers) if (options[provider] !== undefined) {
    if (!object(options[provider])) invalid();
    const selected = {};
    for (const key of ['model', 'effort']) if (options[provider][key] !== undefined) selected[key] = options[provider][key];
    // Validate using the harness schema, but export only model/effort.
    const checked = validateOptions(provider, selected);
    result[provider] = { model: checked.model, effort: checked.effort };
  }
  return result;
}

export class ChatTransfer {
  constructor(store, attachments) {
    this.store = store;
    this.attachments = attachments;
    store.db.exec(`CREATE TABLE IF NOT EXISTS chat_transfers (
      digest TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, imported_at TEXT NOT NULL)`);
  }
  export(chatId) {
    const chat = this.store.chat(chatId);
    if (!chat) throw Object.assign(new Error('对话不存在'), { status: 404 });
    const linked = new Map();
    const messages = this.store.messages(chatId).map(message => {
      const ids = (message.details.attachments || []).map(ref => {
        const row = this.attachments.raw(ref.id);
        if (!row) throw new Error('对话附件缺失，无法完整导出');
        linked.set(row.id, { id: row.id, name: row.name, kind: row.kind, data: row.data, ...['web', 'folder'].includes(row.kind) ? { path: row.path } : {} });
        return row.id;
      });
      return { id: message.id, role: message.role, provider: message.provider, content: message.content,
        status: message.status === 'running' ? 'interrupted' : message.status, created: message.created,
        details: displayDetails(message.details), attachmentIds: ids };
    });
    const group = this.store.list().groups.find(row => row.id === chat.group_id);
    const result = { format: 'starport-conversation', version: 1, exported: new Date().toISOString(),
      chat: { id: chat.id, title: chat.title, provider: chat.provider, workspace: chat.workspace,
        groupName: group?.name || '', created: chat.created, updated: chat.updated, options: portableOptions(chat.options) },
      messages, attachments: [...linked.values()] };
    this.validate(result);
    return result;
  }
  validate(data) {
    if (!object(data) || data.format !== 'starport-conversation') throw new Error('请选择星港导出的会话文件（.starport.json）');
    if (data.version !== 1) throw new Error('此会话文件版本尚不支持，请更新星港后重试');
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_TRANSFER_BYTES) throw Object.assign(new Error('会话文件超过 120 MB'), { status: 413 });
    const chat = data.chat;
    if (!object(chat) || !string(chat.id, 200) || !string(chat.title, 300) || !providers.has(chat.provider) || !string(chat.workspace, 2000, true) || !string(chat.groupName, 120, true) || !date(chat.created) || !date(chat.updated)) invalid();
    if (!Array.isArray(data.messages) || data.messages.length > 20000 || !Array.isArray(data.attachments) || data.attachments.length > 1024) invalid();
    const attachmentIds = new Set(), attachments = [];
    for (const row of data.attachments) {
      if (!object(row) || !string(row.id, 200) || attachmentIds.has(row.id) || !string(row.name, 240) || !['image', 'file', 'sketch', 'web', 'folder'].includes(row.kind)) invalid();
      attachmentIds.add(row.id);
      if (row.kind === 'folder') {
        if (!string(row.path, 2000)) invalid();
        attachments.push({ id: row.id, name: row.name, kind: 'folder', path: row.path, data: '' });
      } else if (row.kind === 'web') {
        let url; try { url = new URL(row.path); } catch { invalid(); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !string(row.data, 100000, true)) invalid();
        attachments.push({ id: row.id, name: row.name, kind: 'web', path: url.href, data: row.data });
      } else {
        this.attachments.fileRow(row); // Derives a safe filename and sniffs bytes; ignores imported paths/mime.
        attachments.push({ id: row.id, name: row.name, kind: row.kind, data: row.data });
      }
    }
    const ids = new Set(), referenced = new Set(); let textBytes = 0;
    const messages = data.messages.map(row => {
      if (!object(row) || !string(row.id, 200) || ids.has(row.id) || !['user', 'assistant', 'system'].includes(row.role) || row.provider !== null && !providers.has(row.provider) || !string(row.content, 2000000, true) || !date(row.created) || !['complete', 'error', 'interrupted', 'running'].includes(row.status)) invalid();
      ids.add(row.id); textBytes += Buffer.byteLength(row.content);
      if (textBytes > 64 * 1024 * 1024 || !Array.isArray(row.attachmentIds) || row.attachmentIds.length > 16 || row.attachmentIds.some(id => !attachmentIds.has(id)) || new Set(row.attachmentIds).size !== row.attachmentIds.length) invalid();
      row.attachmentIds.forEach(id => referenced.add(id));
      return { id: row.id, role: row.role, provider: row.provider, content: row.content, created: row.created,
        status: row.status === 'running' ? 'interrupted' : row.status, details: displayDetails(row.details), attachmentIds: [...row.attachmentIds] };
    });
    if (referenced.size !== attachments.length) invalid();
    return { format: 'starport-conversation', version: 1, chat: { ...Object.fromEntries(['id', 'title', 'provider', 'workspace', 'groupName', 'created', 'updated'].map(key => [key, chat[key]])), options: portableOptions(chat.options) }, messages, attachments };
  }
  digest(data) { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
  existing(digest) { return this.store.db.prepare('SELECT chat_id FROM chat_transfers WHERE digest=?').get(digest)?.chat_id || null; }
  preview(input) {
    const data = this.validate(input);
    return { title: data.chat.title, provider: data.chat.provider, workspace: data.chat.workspace, groupName: data.chat.groupName,
      messages: data.messages.length, attachments: data.attachments.filter(row => row.kind !== 'folder').length,
      externalFolders: data.attachments.filter(row => row.kind === 'folder').length,
      interrupted: data.messages.filter(row => row.status === 'interrupted').length,
      alreadyImportedChatId: this.existing(this.digest(data)),
      preview: data.messages.slice(0, 6).map(row => ({ role: row.role, provider: row.provider, content: row.content.slice(0, 2000) })) };
  }
  async import(input, { group_id = null, group_name = '', workspace } = {}) {
    const data = this.validate(input), digest = this.digest(data);
    if (!string(workspace, 2000) || group_id !== null && (!string(group_id, 200) || !this.store.db.prepare('SELECT id FROM groups WHERE id=?').get(group_id)) || !string(group_name, 120, true) || group_id && group_name) throw new Error('导入位置无效，请重新选择分组和工作目录');
    const existing = this.existing(digest);
    if (existing) return { status: 'skipped', chatId: existing };
    const prepared = new Map(), written = [];
    try {
      for (const source of data.attachments) {
        if (source.kind === 'folder') continue;
        let row;
        if (source.kind === 'web') row = { ...source, id: randomUUID(), mime: 'text/plain', size: Buffer.byteLength(source.data), created: new Date().toISOString() };
        else {
          row = this.attachments.fileRow(source);
          const dir = join(this.attachments.dir, row.id);
          await mkdir(dir, { recursive: true }); written.push(dir);
          await writeFile(row.path, Buffer.from(row.data, 'base64'), { flag: 'wx' });
        }
        prepared.set(source.id, row);
      }
      // No await inside the transaction: concurrent uploads/imports cannot share
      // this connection's transaction. Recheck after filesystem staging.
      this.store.db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const duplicate = this.existing(digest);
        if (duplicate) { this.store.db.exec('ROLLBACK'); await this.cleanup(written); return { status: 'skipped', chatId: duplicate }; }
        const groupId = group_name.trim() ? this.store.group(group_name.trim()).id : group_id;
        const options = {};
        for (const provider of providers) options[provider] = validateOptions(provider, { ...data.chat.options[provider],
          ...provider === 'claude' ? { permissionMode: 'default' } : provider === 'antigravity' ? { permissionMode: 'configured', sandbox: true } : {} });
        const chat = this.store.newChat({ title: data.chat.title, provider: data.chat.provider, group_id: groupId, workspace, options });
        for (const row of prepared.values()) this.attachments.insert(row);
        const runs = new Map(), messageIds = new Map(data.messages.map(row => [row.id, randomUUID()]));
        const remap = id => { if (!runs.has(id)) runs.set(id, randomUUID()); return runs.get(id); };
        const insert = this.store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)');
        for (const message of data.messages) {
          const details = message.details;
          if (details.runId) details.runId = remap(details.runId);
          for (const key of ['guidance', 'nativeQuestionReply']) if (details[key]) details[key].runId = remap(details[key].runId);
          if (details.replyTo) {
            if (messageIds.has(details.replyTo.messageId)) details.replyTo.messageId = messageIds.get(details.replyTo.messageId);
            else delete details.replyTo;
          }
          const rows = message.attachmentIds.map(id => prepared.get(id)).filter(Boolean);
          if (rows.length) { details.attachments = rows.map(row => this.attachments.metadata(row)); details.attachmentContext = this.attachments.context(rows); }
          const folders = message.attachmentIds.map(id => data.attachments.find(row => row.id === id)).filter(row => row.kind === 'folder');
          if (folders.length) details.notices = [...details.notices || [], ...folders.map(row => `原电脑文件夹未复制，请在本机重新添加：${row.path}`)];
          const content = message.content.replace(/\/api\/attachments\/([\w-]+)/g, (url, id) => prepared.has(id) ? '/api/attachments/' + prepared.get(id).id : url);
          insert.run(messageIds.get(message.id), chat.id, message.role, message.provider, content, message.status, JSON.stringify(details), message.created);
        }
        this.store.db.prepare('UPDATE chats SET created=?,updated=? WHERE id=?').run(data.chat.created, data.chat.updated, chat.id);
        this.store.db.prepare('INSERT INTO chat_transfers VALUES(?,?,?)').run(digest, chat.id, new Date().toISOString());
        this.store.db.exec('COMMIT'); committed = true;
        return { status: 'imported', chatId: chat.id, messages: data.messages.length, attachments: prepared.size };
      } catch (error) { if (!committed) this.store.db.exec('ROLLBACK'); throw error; }
    } catch (error) { await this.cleanup(written); throw error; }
  }
  async cleanup(directories) {
    // Paths are generated here from fresh UUIDs under attachments.dir, never
    // obtained from the imported file. Existing user files are never removed.
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
}

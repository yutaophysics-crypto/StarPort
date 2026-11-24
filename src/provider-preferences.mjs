import { PROVIDERS, validateOptions } from './providers.mjs';

const KEY = 'provider.permissions';
const permissionKeys = provider => provider === 'codex' || provider === 'antigravity'
  ? ['permissionMode', 'sandbox'] : provider === 'claude' ? ['permissionMode'] : [];

// Personal defaults contain only permissions. Goals, worktrees, models and
// conversation-specific state must not leak into a fresh conversation.
export class ProviderPreferences {
  constructor(store) {
    this.store = store;
    if (store.setting(KEY) !== null) return;
    const initial = {};
    const transfers = store.db.prepare("SELECT name FROM sqlite_master WHERE name='chat_transfers'").get();
    for (const provider of Object.keys(PROVIDERS)) {
      const recent = store.db.prepare(`SELECT c.options FROM messages m JOIN chats c ON c.id=m.chat_id
        WHERE m.role='user' AND m.status='complete' AND m.provider=?
          AND json_extract(c.options,'$.desk') IS NULL
          AND json_type(c.options,?)='object'
          AND NOT EXISTS (SELECT 1 FROM history_imports h WHERE h.chat_id=c.id)
          ${transfers ? 'AND NOT EXISTS (SELECT 1 FROM chat_transfers t WHERE t.chat_id=c.id)' : ''}
        ORDER BY m.created DESC,m.rowid DESC LIMIT 1`).get(provider, '$.' + provider);
      if (recent) try { initial[provider] = this.selection(provider, JSON.parse(recent.options)[provider]); } catch {}
    }
    store.setSetting(KEY, initial);
  }
  selection(provider, raw) {
    const values = validateOptions(provider, raw);
    return Object.fromEntries(permissionKeys(provider).map(key => [key, values[key]]));
  }
  all() {
    const saved = this.store.setting(KEY, {}), result = {};
    for (const provider of Object.keys(PROVIDERS)) {
      try { result[provider] = this.selection(provider, saved[provider] || this.fallback(provider)); }
      catch { result[provider] = this.selection(provider, this.fallback(provider)); }
    }
    return result;
  }
  fallback(provider) { return provider === 'codex' ? { permissionMode: 'ask', sandbox: 'workspace-write' } : {}; }
  remember(provider, raw) {
    const selection = this.selection(provider, raw);
    if (permissionKeys(provider).length) this.store.setSetting(KEY, { ...this.store.setting(KEY, {}), [provider]: selection });
    return selection;
  }
  newChatOptions(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(id => !PROVIDERS[id]))
      throw new Error('工具选项无效');
    const defaults = this.all();
    return Object.fromEntries(Object.keys(PROVIDERS).map(id => {
      if (Object.hasOwn(raw, id)) validateOptions(id, raw[id]);
      return [id, validateOptions(id, { ...defaults[id], ...raw[id] })];
    }));
  }
}

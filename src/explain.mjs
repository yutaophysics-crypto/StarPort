import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS } from './providers.mjs';
import { deskOptions } from './workflows/records.mjs';

// 翻译/解释 for text selected in a reply. Each click is a new hidden one-off chat with a small
// model that receives only the configured prompt and the selected text.
export const DEFAULT_EXPLAIN = Object.freeze({ provider: 'antigravity', model: 'gemini-3.8-flash-low', effort: '', service: '', prompt: '用三句话解释这个词语/短语/句子' });
export const MAX_SELECTION = 4000;
const MAX_PROMPT = 2000, EXPLAIN_MINUTES = 3;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function explainPrompt(prompt, text) { return `${prompt.trim()}\n\n${text.trim()}`; }

export function validateExplainSettings(raw = {}) {
  const value = { ...DEFAULT_EXPLAIN, ...raw };
  if (!PROVIDERS[value.provider]) throw fail('请选择解释用的工具');
  for (const key of ['model', 'service']) if (typeof value[key] !== 'string' || value[key].length > 200) throw fail('模型格式无效');
  if (typeof value.effort !== 'string' || value.effort && !/^[\w-]{1,100}$/.test(value.effort)) throw fail('思考强度格式无效');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT) throw fail(`提示词需要 1–${MAX_PROMPT} 个字符`);
  return { provider: value.provider, model: value.model.trim(), effort: value.effort, service: value.provider === 'deepseek' ? value.service : '', prompt: value.prompt.trim() };
}

export class Explainer {
  constructor({ store, runner, broadcast = () => {}, workspace = join(tmpdir(), 'starport-explain') }) {
    Object.assign(this, { store, runner, broadcast, workspace });
  }
  settings() {
    try { return validateExplainSettings(this.store.setting('explain.settings', null) || {}); }
    catch { return { ...DEFAULT_EXPLAIN }; }
  }
  saveSettings(raw) {
    const settings = validateExplainSettings({ ...this.settings(), ...raw });
    this.store.setSetting('explain.settings', settings);
    this.broadcast('settings');
    return settings;
  }
  // An empty folder of its own, so the tool picks up no project files or instructions.
  async explain(text, { signal } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw fail('请先选中要解释的文字');
    if (text.length > MAX_SELECTION) throw fail(`选中的文字太长，最多 ${MAX_SELECTION} 个字符`);
    const settings = this.settings(), { provider } = settings;
    mkdirSync(this.workspace, { recursive: true });
    const options = deskOptions(provider, { model: settings.model, effort: settings.effort, service: settings.service, access: 'readonly' });
    const desk = this.store.newChat({ group_id: null, title: '[工位] 解释', provider, workspace: this.workspace,
      options: { [provider]: options, desk: { parentChatId: null, explain: true } } });
    const stop = () => this.runner.stop(desk.id).catch(() => {});
    let watch = null, timer = null;
    try {
      const started = await this.runner.start(desk.id, explainPrompt(settings.prompt, text), [], { desk: true, bare: true, memory: {} });
      // Nobody watches this chat: anything that asks for approval is declined.
      const handled = new Set();
      watch = setInterval(() => {
        const active = this.runner.active.get(desk.id); if (!active) return;
        for (const request of active.approvals.values()) {
          if (handled.has(request.id)) continue; handled.add(request.id);
          this.runner.answer(desk.id, request.id, { decision: request.kind === 'question' ? 'skip' : 'decline' }).catch(() => {});
        }
      }, 800); watch.unref?.();
      timer = setTimeout(stop, EXPLAIN_MINUTES * 60000); timer.unref?.();
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      await started.done?.catch(() => {});
      const message = this.store.messageById(desk.id, started.assistant.id);
      if (message?.status !== 'complete') throw fail(message?.status === 'interrupted' ? '解释已停止' : message?.details?.error || '解释没有完成', 502);
      const answer = (message.details?.finalAnswer || message.content || '').trim();
      if (!answer) throw fail('模型没有返回内容', 502);
      return { text: answer, provider, model: message.details?.model || settings.model };
    } finally {
      clearInterval(watch); clearTimeout(timer); signal?.removeEventListener('abort', stop);
      // A desk still stopping is removed once its run ends.
      const remove = () => { try { this.store.deleteChat(desk.id); } catch {} };
      const active = this.runner.active.get(desk.id);
      if (active) Promise.resolve(active.done).catch(() => {}).finally(remove); else remove();
    }
  }
  async handle(method, path, read, signal) {
    if (path === '/api/explain/settings' && method === 'GET') return { data: { ...this.settings(), defaults: DEFAULT_EXPLAIN } };
    if (path === '/api/explain/settings' && method === 'PUT') return { data: this.saveSettings(await read()) };
    if (path === '/api/explain' && method === 'POST') return { data: await this.explain((await read()).text, { signal }) };
    return null;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PROVIDERS } from '../src/providers.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
function ui(handle) {
  const nodes = new Map(), values = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { content: 'fixture-token', value: '', style: {}, focus() {},
      classList: { remove() {}, add() {} } });
    return nodes.get(selector);
  };
  const context = vm.createContext({ console, URLSearchParams, document: { querySelector: node },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    StarportI18n: { t: s => s, notice: s => s }, setTimeout: () => 0, clearTimeout() {},
    closeThemeCover() {}, resizePrompt() {},
    fetch: async (url, options) => ({ ok: true, json: async () => handle(url, options.method, options.body ? JSON.parse(options.body) : undefined) }) });
  for (const file of ['app.js', 'app-options.js', 'app-send.js'])
    vm.runInContext(readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), context);
  vm.runInContext(`let approvalKey=''; renderView=()=>{}; renderFeatures=()=>{}; renderRun=()=>{};
    globalThis.fixture={state,opts,saveOptions,switchProvider,newChat,createDraftChat,queueSave,
      settled:async()=>{await saveChain;await preferenceChain;}};`, context);
  context.fixture.state.providers = plain(Object.values(PROVIDERS));
  context.fixture.state.providerPreferencesReady = true;
  context.fixture.state.workspace = 'fixture-workspace';
  return context.fixture;
}

test('draft tool selections are created atomically and remain visible immediately without a refresh', async () => {
  const calls = [];
  const f = ui((path, method, data) => {
    calls.push({ path, method, data });
    if (path === '/api/chats') return { id: 'new-chat', provider: data.provider, options: data.options };
    return data;
  });
  f.saveOptions(PROVIDERS.codex, { permissionMode: 'full-access', sandbox: 'danger-full-access', model: 'gpt-fixture', effort: 'high' });
  await f.switchProvider('claude');
  f.saveOptions(PROVIDERS.claude, { permissionMode: 'auto', model: 'opus-fixture', effort: 'xhigh' });
  await f.createDraftChat('hello'); await f.settled();
  assert.equal(f.opts().permissionMode, 'auto'); assert.equal(f.opts().model, 'opus-fixture');
  assert.equal(f.state.chat.options.codex.model, 'gpt-fixture');
  assert.equal(calls.filter(row => row.path === '/api/chats').length, 1);
  assert.ok(!calls.some(row => row.path === '/api/chats/new-chat'));
});

test('new-chat action inherits recent permission without copying a goal or model, even before pending saves finish', async () => {
  const f = ui(() => ({}));
  f.state.chat = { id: 'existing', provider: 'codex', options: { codex: {} } };
  f.saveOptions(PROVIDERS.codex, { permissionMode: 'auto-review', sandbox: 'workspace-write', model: 'fixture', mode: 'goal', objective: 'old goal', tokenBudget: 700 });
  f.newChat();
  assert.equal(f.opts().permissionMode, 'auto-review'); assert.equal(f.opts().model, '');
  assert.equal(f.opts().mode, 'chat'); assert.equal(f.opts().objective, '');
  await f.settled();
});

test('queued edits capture the tool and switching back restores the saved options for that tool', async () => {
  const calls = [], saved = { id: 'existing', provider: 'codex', options: {
    codex: { model: 'gpt-fixture', effort: 'high', permissionMode: 'full-access', sandbox: 'danger-full-access' },
    claude: { model: 'opus-fixture', effort: 'xhigh', permissionMode: 'auto' }
  } };
  const f = ui((path, method, data) => {
    calls.push(plain(data));
    saved.provider = data.provider || saved.provider;
    if (data.options) saved.options[saved.provider] = { ...saved.options[saved.provider], ...data.options };
    return plain(saved);
  });
  f.state.chat = plain(saved);
  const edit = f.queueSave({ options: { ...f.opts(), effort: 'max' } });
  const cc = f.switchProvider('claude'); await Promise.all([edit, cc]);
  assert.equal(calls[0].provider, 'codex'); assert.equal(f.opts().model, 'opus-fixture'); assert.equal(f.opts().permissionMode, 'auto');
  await f.switchProvider('codex'); assert.equal(f.opts().effort, 'max'); assert.equal(f.opts().permissionMode, 'full-access');
});

test('a rejected permission save cannot become the default for a subsequent new conversation', async () => {
  const f = ui(() => { throw new Error('fixture save failed'); });
  f.state.providerPermissions.codex = { permissionMode: 'ask', sandbox: 'workspace-write' };
  f.state.chat = { id: 'existing', provider: 'codex', options: { codex: { permissionMode: 'ask' } } };
  f.saveOptions(PROVIDERS.codex, { ...f.opts(), permissionMode: 'full-access', sandbox: 'danger-full-access' });
  f.newChat();
  await assert.rejects(f.settled(), /fixture save failed/);
  assert.equal(f.opts().permissionMode, 'ask');
});

test('a newer page preserves draft choices while an old busy server waits for its safe update', async () => {
  const calls = [];
  const f = ui((path, method, data) => {
    calls.push({ path, data });
    if (path === '/api/chats') return { id: 'legacy-created', provider: 'claude', options: {} };
    return { id: 'legacy-created', provider: 'claude', options: { claude: data.options } };
  });
  f.state.providerPreferencesReady = false;
  await f.switchProvider('claude');
  f.saveOptions(PROVIDERS.claude, { permissionMode: 'auto', model: 'fixture-opus', effort: 'high' });
  await f.createDraftChat('fixture'); await f.settled();
  assert.equal(f.opts().permissionMode, 'auto'); assert.equal(f.opts().model, 'fixture-opus');
  assert.deepEqual(calls.map(row => row.path), ['/api/chats', '/api/chats/legacy-created']);
});

test('an untouched new conversation uses the latest server permissions instead of a stale window default', async () => {
  let sent;
  const f = ui((path, method, data) => {
    sent = data;
    return { id: 'fresh', provider: 'claude', options: { claude: { permissionMode: 'auto', model: '', effort: '' } } };
  });
  f.state.providerPermissions.claude = { permissionMode: 'plan' };
  await f.switchProvider('claude'); await f.createDraftChat('fixture');
  assert.deepEqual(sent.options, {});
  assert.equal(f.opts().permissionMode, 'auto');
});

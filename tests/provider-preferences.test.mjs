import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.mjs';
import { ProviderPreferences } from '../src/provider-preferences.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { createHub } from '../src/server.mjs';

const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }),
  list: async () => Object.values(PROVIDERS), probe: async () => ({ nativeAutoReview: true }), record() {} };

async function fixture(t, implementations = {}) {
  const hub = createHub({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'starport-provider-prefs-')), registry, implementations });
  const port = await hub.listen(); t.after(() => hub.close());
  const request = async (path, method = 'GET', data) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method,
      headers: { 'X-Hub-Token': hub.token, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body)); return body;
  };
  return { hub, request };
}

test('upgrade seeds permissions from recent local use, excluding hidden desks and imported sessions, and persists across restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'starport-pref-store-')), 'hub.sqlite');
  let store = new Store(file);
  const add = (options, text) => {
    const chat = store.newChat({ provider: 'claude', options });
    store.message(chat.id, 'user', 'claude', text); return chat;
  };
  add({ claude: { permissionMode: 'auto', model: 'fixture-opus', effort: 'high', worktree: true } }, 'real use');
  add({ claude: { permissionMode: 'bypassPermissions' }, desk: { parentChatId: 'fictional' } }, 'internal desk');
  const imported = add({ claude: { permissionMode: 'plan' } }, 'imported history');
  store.db.prepare('INSERT INTO history_imports VALUES(?,?,?,?)').run('claude', 'external', imported.id, new Date().toISOString());
  let prefs = new ProviderPreferences(store);
  assert.deepEqual(prefs.all().claude, { permissionMode: 'auto' });
  const next = prefs.newChatOptions();
  assert.equal(next.claude.permissionMode, 'auto'); assert.equal(next.claude.model, ''); assert.equal(next.claude.worktree, false);
  prefs.remember('codex', { permissionMode: 'full-access' });
  prefs.remember('antigravity', { permissionMode: 'configured', sandbox: false });
  store.close(); store = new Store(file); prefs = new ProviderPreferences(store);
  assert.equal(prefs.all().codex.permissionMode, 'full-access');
  assert.equal(prefs.all().codex.sandbox, 'danger-full-access');
  assert.deepEqual(prefs.all().antigravity, { permissionMode: 'configured', sandbox: false });
  assert.throws(() => prefs.remember('claude', { permissionMode: 'made-up' }));
  assert.equal(prefs.all().claude.permissionMode, 'auto'); store.close();
});

test('permission-only edits and repeated tool switches retain each conversation model, effort and permission', async t => {
  const { hub, request } = await fixture(t);
  const chat = await request('/chats', 'POST', { workspace: process.cwd(), options: {
    codex: { model: 'fixture-gpt', effort: 'high', permissionMode: 'full-access' },
    claude: { model: 'fixture-opus', effort: 'xhigh', permissionMode: 'auto' }
  } });
  const patch = data => request('/chats/' + chat.id, 'PATCH', data);
  await patch({ options: { permissionMode: 'auto-review' } });
  assert.equal(hub.store.chat(chat.id).options.codex.model, 'fixture-gpt');
  assert.equal(hub.store.chat(chat.id).options.codex.effort, 'high');
  for (let i = 0; i < 3; i++) {
    const cc = await patch({ provider: 'claude' });
    assert.equal(cc.options.claude.permissionMode, 'auto'); assert.equal(cc.options.claude.effort, 'xhigh');
    const cx = await patch({ provider: 'codex' });
    assert.equal(cx.options.codex.permissionMode, 'auto-review'); assert.equal(cx.options.codex.model, 'fixture-gpt');
  }
  const response = await request('/chats/' + chat.id);
  assert.equal(response.chat.options.claude.model, 'fixture-opus');
});

test('fresh chats snapshot recent permissions for every tool, explicit choices win, and old conversations remain independent', async t => {
  const { hub, request } = await fixture(t);
  const old = await request('/chats', 'POST', { workspace: process.cwd(), provider: 'claude' });
  await request('/providers/claude/permissions', 'PATCH', { permissionMode: 'auto' });
  await request('/providers/codex/permissions', 'PATCH', { permissionMode: 'full-access' });
  const fresh = await request('/chats', 'POST', { workspace: process.cwd() });
  assert.equal(fresh.options.claude.permissionMode, 'auto');
  assert.equal(fresh.options.codex.permissionMode, 'full-access');
  await request('/providers/claude/permissions', 'PATCH', { permissionMode: 'bypassPermissions' });
  const switched = await request('/chats/' + fresh.id, 'PATCH', { provider: 'claude' });
  assert.equal(switched.options.claude.permissionMode, 'auto');
  assert.equal(hub.store.chat(old.id).options.claude.permissionMode, 'plan');
  const explicit = await request('/chats', 'POST', { provider: 'claude', workspace: process.cwd(), options: { claude: { permissionMode: 'default' } } });
  assert.equal(explicit.options.claude.permissionMode, 'default');
  const state = await request('/state'); assert.equal(state.providerPermissions.claude.permissionMode, 'bypassPermissions');
  const legacy = hub.store.newChat({ workspace: process.cwd(), options: { codex: { model: 'legacy', permissionMode: 'ask' } } });
  const firstCC = await request('/chats/' + legacy.id, 'PATCH', { provider: 'claude' });
  assert.equal(firstCC.options.claude.permissionMode, 'bypassPermissions');
  assert.equal(firstCC.options.codex.model, 'legacy');
});

test('normal runs update recent permissions; hidden companions and failed edits cannot overwrite them', async t => {
  let release;
  const { hub, request } = await fixture(t, { claude: async ({ emit }) => {
    await new Promise(resolve => release = resolve); emit({ type: 'final-answer', text: 'Fixture done' });
  } });
  await request('/providers/claude/permissions', 'PATCH', { permissionMode: 'auto' });
  const chat = hub.store.newChat({ provider: 'claude', workspace: process.cwd(), options: { claude: { permissionMode: 'acceptEdits' } } });
  await hub.runner.start(chat.id, 'fixture');
  assert.equal(hub.runner.preferences.all().claude.permissionMode, 'acceptEdits');
  const saved = hub.runner.active.get(chat.id).done;
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const response = await fetch(`http://127.0.0.1:${hub.server.address().port}/api/chats/${chat.id}`, {
    method: 'PATCH', headers: { 'X-Hub-Token': hub.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ options: { permissionMode: 'bypassPermissions' } }) });
  assert.equal(response.status, 409); assert.equal(hub.runner.preferences.all().claude.permissionMode, 'acceptEdits');
  release(); await saved;
  const desk = hub.store.newChat({ provider: 'claude', workspace: process.cwd(), options: { claude: { permissionMode: 'plan' }, desk: { parentChatId: chat.id } } });
  release = null; await hub.runner.start(desk.id, 'internal fixture', [], { desk: true });
  const deskDone = hub.runner.active.get(desk.id).done;
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.runner.preferences.all().claude.permissionMode, 'acceptEdits'); release(); await deskDone;
});

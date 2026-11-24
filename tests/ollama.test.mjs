import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ollamaHost, runOllama, contextWindow, ollamaEffortLevels, ollamaThink } from '../src/adapters/ollama.mjs';
import { loadModels } from '../src/models.mjs';
import { PROVIDERS } from '../src/providers.mjs';
import { PROVIDER_IDS } from '../src/provider-ids.mjs';
import { DEFAULT_BUDGETS } from '../src/compaction.mjs';
import { ACCESS } from '../src/workflows/records.mjs';
import { createHub } from '../src/server.mjs';

// A stand-in for the local Ollama server: /api/tags, /api/show and a streamed /api/chat.
async function fakeOllama(t, { models = [{ name: 'qwen3:4b', details: { parameter_size: '4.0B' } }], capabilities = ['completion', 'thinking'], chunks, onChat = () => {} } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const data = body ? JSON.parse(body) : null;
    requests.push({ path: req.url, data });
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models }));
    if (req.url === '/api/show') {
      if (!models.some(row => row.name === data.model)) { res.writeHead(404); return res.end(JSON.stringify({ error: `model '${data.model}' not found` })); }
      return res.end(JSON.stringify({ capabilities, model_info: { 'qwen3.context_length': 40960 } }));
    }
    if (req.url === '/api/chat') {
      if (onChat(data, res)) return;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const chunk of chunks) { res.write(JSON.stringify(chunk) + '\n'); await new Promise(resolve => setImmediate(resolve)); }
      return res.end();
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { host: 'http://127.0.0.1:' + server.address().port, requests };
}

test('Ollama is a provider of its own with no sessions, tools or group chat', () => {
  assert.deepEqual(PROVIDER_IDS, Object.keys(PROVIDERS));
  assert.equal(PROVIDERS.ollama.sessions, false);
  assert.equal(PROVIDERS.ollama.contextTools, false);
  assert.deepEqual(PROVIDERS.ollama.fields.map(field => field.key), ['model', 'effort']);
  assert.ok(DEFAULT_BUDGETS.ollama >= 8);
  for (const preset of Object.values(ACCESS)) assert.deepEqual(preset.ollama, {});
});

test('the server address follows OLLAMA_HOST like the Ollama CLI does', () => {
  assert.equal(ollamaHost({}), process.env.OLLAMA_HOST ? ollamaHost({ OLLAMA_HOST: process.env.OLLAMA_HOST }) : 'http://127.0.0.1:11434');
  assert.equal(ollamaHost({ OLLAMA_HOST: '0.0.0.0' }), 'http://127.0.0.1:11434');
  assert.equal(ollamaHost({ OLLAMA_HOST: '0.0.0.0:8080' }), 'http://127.0.0.1:8080');
  assert.equal(ollamaHost({ OLLAMA_HOST: 'https://ollama.example.com' }), 'https://ollama.example.com');
  assert.equal(ollamaHost({ OLLAMA_HOST: 'http://192.168.1.5:11434/' }), 'http://192.168.1.5:11434');
});

test('thinking modes and context windows come from the model', () => {
  assert.deepEqual(ollamaEffortLevels('qwen3:4b', ['completion']), []);
  assert.deepEqual(ollamaEffortLevels('qwen3:4b', ['completion', 'thinking']), ['off', 'on']);
  assert.deepEqual(ollamaEffortLevels('gpt-oss:20b', ['thinking']), ['low', 'medium', 'high']);
  assert.equal(ollamaThink(''), undefined);
  assert.equal(ollamaThink('off'), false);
  assert.equal(ollamaThink('on'), true);
  assert.equal(ollamaThink('high'), 'high');
  assert.equal(contextWindow('短'), 8192, 'short prompts share one window, so the model is not reloaded');
  assert.equal(contextWindow('x'.repeat(30000)), 16384);
  assert.equal(contextWindow('x'.repeat(400000), 40960), 40960, 'never more than the model supports');
});

test('a turn streams thinking and text, reports usage, and sends one stateless request', async t => {
  const { host, requests } = await fakeOllama(t, { chunks: [
    { message: { role: 'assistant', content: '', thinking: '想一想' } },
    { message: { role: 'assistant', content: '偶然' } },
    { message: { role: 'assistant', content: '发现。' } },
    { done: true, prompt_eval_count: 30, eval_count: 12 }
  ] });
  const events = [];
  await runOllama({ runtime: { env: { OLLAMA_HOST: host } }, options: { model: 'qwen3:4b', effort: 'off' }, prompt: '解释 serendipity',
    images: [{ data: 'aGk=', mime: 'image/png' }], emit: event => events.push(event), setControl() {} });
  const chat = requests.find(row => row.path === '/api/chat').data;
  assert.equal(chat.model, 'qwen3:4b');
  assert.equal(chat.think, false);
  assert.equal(chat.stream, true);
  assert.equal(chat.options.num_ctx, 8192);
  assert.deepEqual(chat.messages, [{ role: 'user', content: '解释 serendipity', images: ['aGk='] }]);
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), '偶然发现。');
  assert.equal(events.find(e => e.type === 'final-answer').text, '偶然发现。');
  assert.equal(events.find(e => e.type === 'session').model, 'qwen3:4b');
  assert.equal(events.filter(e => e.type === 'activity').at(-1).item.status, 'complete');
  assert.deepEqual(events.find(e => e.type === 'usage').usage, { input_tokens: 30, output_tokens: 12 });
  assert.equal(events.find(e => e.type === 'context').context.usedTokens, 42);
});

test('without a chosen model the first installed one answers; models without thinking get no think flag', async t => {
  const { host, requests } = await fakeOllama(t, { capabilities: ['completion'], chunks: [{ message: { content: 'ok' } }, { done: true }] });
  await runOllama({ runtime: { env: { OLLAMA_HOST: host } }, options: { model: '', effort: 'on' }, prompt: 'hi', emit() {}, setControl() {} });
  const chat = requests.find(row => row.path === '/api/chat').data;
  assert.equal(chat.model, 'qwen3:4b');
  assert.equal(Object.hasOwn(chat, 'think'), false);
});

test('missing models, an empty install and a stopped server explain what to do', async t => {
  const { host } = await fakeOllama(t, { chunks: [] });
  const run = options => runOllama({ runtime: { env: { OLLAMA_HOST: host } }, options, prompt: 'hi', emit() {}, setControl() {} });
  await assert.rejects(run({ model: 'llama9:1b', effort: '' }), /没有模型 llama9:1b。请先在终端运行 ollama pull llama9:1b/);
  const empty = await fakeOllama(t, { models: [], chunks: [] });
  await assert.rejects(runOllama({ runtime: { env: { OLLAMA_HOST: empty.host } }, options: { model: '', effort: '' }, prompt: 'hi', emit() {}, setControl() {} }), /还没有模型/);
  await assert.rejects(runOllama({ runtime: { env: { OLLAMA_HOST: 'http://127.0.0.1:9' } }, options: { model: 'x', effort: '' }, prompt: 'hi', emit() {}, setControl() {} }), /连不上本机 Ollama 服务/);
  const failing = await fakeOllama(t, { chunks: [{ message: { content: '半' } }, { error: 'out of memory' }] });
  await assert.rejects(runOllama({ runtime: { env: { OLLAMA_HOST: failing.host } }, options: { model: 'qwen3:4b', effort: '' }, prompt: 'hi', emit() {}, setControl() {} }), /Ollama：out of memory/);
});

test('stopping a turn aborts the stream at once', async t => {
  let response;
  const { host } = await fakeOllama(t, { chunks: [], onChat: (data, res) => {
    response = res; res.writeHead(200); res.write(JSON.stringify({ message: { content: '开始' } }) + '\n');
    return true;
  } });
  const controller = new AbortController(), events = [];
  const running = runOllama({ runtime: { env: { OLLAMA_HOST: host } }, options: { model: 'qwen3:4b', effort: '' }, prompt: 'hi', signal: controller.signal,
    emit: event => { events.push(event); if (event.type === 'delta') controller.abort(); }, setControl() {} });
  await assert.rejects(running, error => error.canceled === true);
  assert.equal(events.some(e => e.type === 'final-answer'), false);
  response?.destroy();
});

test('the model list comes from the installed models with their thinking modes', async t => {
  const { host } = await fakeOllama(t, { models: [{ name: 'qwen3:4b', details: { parameter_size: '4.0B' } }, { name: 'gpt-oss:20b', details: {} }], chunks: [] });
  const saved = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = host;
  try {
    const catalog = await loadModels('ollama', { command: 'ollama', prefixArgs: [] }, process.cwd(), process.cwd());
    assert.deepEqual(catalog.models.map(m => [m.id, m.label]), [['qwen3:4b', 'qwen3:4b · 4.0B'], ['gpt-oss:20b', 'gpt-oss:20b']]);
    assert.deepEqual(catalog.models[0].effort.choices.map(c => [c.value, c.label]), [['off', '不思考'], ['on', '思考']]);
    assert.deepEqual(catalog.models[1].effort.choices.map(c => c.value), ['low', 'medium', 'high']);
    assert.deepEqual(catalog.effort.choices, []);
  } finally { if (saved === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = saved; }
});

test('an Ollama chat sends history every turn and no Starport tool instructions', { timeout: 20000 }, async t => {
  const calls = [];
  const ollama = async args => {
    calls.push(args);
    const text = `第${calls.length}答`;
    args.emit({ type: 'session', id: 'ollama-' + calls.length, model: 'qwen3:4b' });
    args.emit({ type: 'delta', text }); args.emit({ type: 'final-answer', text });
  };
  const registry = { resolve: () => ({ command: process.execPath, prefixArgs: [] }), probe: async () => ({}), models: async () => ({ models: [] }), record() {}, list: async () => [] };
  const dataDir = mkdtempSync(join(tmpdir(), 'hub-ollama-')), workspace = mkdtempSync(join(tmpdir(), 'hub-ollama-ws-'));
  const hub = createHub({ port: 0, dataDir, registry, implementations: { ollama } }); await hub.listen(); t.after(() => hub.close());
  const { store, runner } = hub, chat = store.newChat({ provider: 'ollama', workspace, title: '本地' });
  for (const text of ['第一问', '第二问']) { await runner.start(chat.id, text); await runner.active.get(chat.id)?.done; }
  assert.equal(calls.length, 2);
  assert.equal(calls[1].session, undefined, 'every turn starts fresh');
  assert.match(calls[1].prompt, /第一问[\s\S]*第1答[\s\S]*第二问/);
  for (const call of calls) {
    assert.equal(call.contextTools, null);
    assert.doesNotMatch(call.prompt, /starport_history_search|starport_companion_call/);
  }
  assert.equal(store.messages(chat.id).at(-1).status, 'complete');
});

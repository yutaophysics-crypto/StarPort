import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCollaborationHub } from '../../src/collaboration/server.mjs';
import { DesktopWorker } from '../../src/collaboration/desktop.mjs';
import { mobileDesktop } from '../../src/collaboration/mobile-desktop.mjs';
import { Store } from '../../src/storage.mjs';
import { Runner } from '../../src/runner.mjs';

export const fixtureCredentials = { username: 'mobile-demo', name: 'Starport QA', password: 'starport-fixture-mobile-01' };

export async function mobileFixture({ port = 0, interval = 120 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'starport-mobile-')));
  const hub = createCollaborationHub({ dataDir: join(root, 'relay'), port });
  const registry = {
    probe: async () => ({ installed: true, loggedIn: true }), resolve: () => ({ command: process.execPath, prefixArgs: [] }),
    models: async () => ({ models: [] }), record() {},
  };
  await hub.listen();
  const owner = await hub.store.register(fixtureCredentials);
  const guest = await hub.store.register({ username: 'different-owner', name: 'Other owner', password: 'starport-fixture-other-02' });
  const calls = [];
  const boot = async (label, provider, title, { account = owner, mobile = true } = {}) => {
    const folder = join(root, label);
    const workspace = join(folder, 'workspace');
    const outside = join(folder, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    const store = new Store(join(folder, 'desktop.sqlite'));
    const handlers = { [provider]: async ({ prompt, emit, signal, setControl }) => {
      calls.push({ label, provider, prompt });
      if (prompt.includes('ASK_FIXTURE_FOR_APPROVAL')) {
        let resume;
        const waiting = new Promise(resolve => { resume = resolve; });
        setControl({ answer: async id => { emit({ type: 'approval-resolved', id }); resume(); }, stop: async () => resume() });
        emit({ type: 'approval', request: { id: 'mobile-approval', kind: 'permission', method: 'tool', params: { command: 'fixture command' } } });
        await waiting;
      }
      if (signal.aborted) return;
      const answer = label + ' replied using ' + provider;
      emit({ type: 'replace', text: answer });
      emit({ type: 'final-answer', text: answer });
    } };
    const runner = new Runner(store, registry, () => {}, handlers);
    const chat = store.newChat({ title, workspace, provider });
    const hidden = store.newChat({ title: 'Outside', workspace: outside, provider });
    const desk = store.newChat({ title: 'Hidden desk', workspace, provider, options: { desk: { parentChatId: chat.id } } });
    store.message(chat.id, 'assistant', provider, 'Existing desktop conversation on ' + label);
    const device = hub.store.registerDevice(account.user.id, { name: label });
    const execute = mobileDesktop({ store, runner });
    const payloads = [];
    const worker = new DesktopWorker({
      link: { hubUrl: hub.origin(), user: account.user, deviceId: device.id, token: device.token, mobile,
        workspaces: [{ id: 'fixture-workspace', name: 'QA', path: workspace }], execution: 'edit' },
      registry, dataDir: join(folder, 'group'), interval,
      mobileHandler: (link, payload) => { payloads.push(payload); return execute(link, payload); },
    });
    await worker.start();
    return { label, provider, chat, hidden, desk, device, worker, store, runner, payloads };
  };
  const first = await boot('Windows QA', 'codex', 'Windows 设计');
  const second = await boot('Mac QA', 'claude', 'Mac 编译');
  const disabled = await boot('Disabled QA', 'codex', 'Disabled chat', { mobile: false });
  const other = await boot('Other QA', 'claude', 'Other chat', { account: guest });
  return {
    hub, owner, guest, first, second, disabled, other, calls,
    async close() {
      for (const desktop of [first, second, disabled, other]) {
        await desktop.worker.close();
        await desktop.runner.close();
        desktop.store.close();
      }
      await hub.close();
      await rm(root, { recursive: true, force: true, maxRetries: 4 });
    },
  };
}

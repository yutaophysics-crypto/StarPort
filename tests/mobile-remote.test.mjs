import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileFixture } from './fixtures/mobile-desktop.mjs';

test('a phone controls only its selected computer and existing authorised conversation', { timeout: 25000 }, async t => {
  const fixture = await mobileFixture();
  t.after(() => fixture.close());
  const { hub, owner, guest, first, second, disabled, other } = fixture;
  const base = hub.origin() + '/api/mobile';
  const api = async (path, { body, account = owner, csrf = account.csrf } = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: hub.origin(), Cookie: 'starport_session=' + account.token,
        'X-Starport-CSRF': csrf, 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.99',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const submit = (desktop, body, auth) => api('/devices/' + desktop.device.id + '/requests', { body, ...auth });
  const result = async id => {
    for (let count = 0; count < 150; count++) {
      const response = await api('/requests/' + id);
      if (response.body.status !== 'pending') return response.body;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('No desktop result');
  };
  const call = async (desk, id, op, extra) => {
    const accepted = await submit(desk, { id, op, ...extra });
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    return result(accepted.body.id);
  };

  const devices = await api('/devices');
  assert.deepEqual(devices.body.devices.map(d => [d.name, d.enabled]), [[first.label, true], [second.label, true], [disabled.label, false]]);
  assert.equal((await submit(other, { id: 'foreign', op: 'list' })).status, 403);
  assert.equal((await submit(disabled, { id: 'disabled', op: 'list' })).status, 409);
  assert.equal((await submit(first, { id: 'csrf', op: 'list' }, { csrf: 'bad' })).status, 403);

  const lists = await Promise.all([call(first, 'list1', 'list'), call(second, 'list2', 'list')]);
  assert.deepEqual(lists.map(row => row.data.chats.map(chat => chat.id)), [[first.chat.id], [second.chat.id]]);
  assert.equal((await call(first, 'hidden', 'read', { chatId: first.hidden.id })).status, 'failed');
  assert.equal((await call(first, 'desk', 'read', { chatId: first.desk.id })).status, 'failed');
  assert.equal((await call(first, 'wrong-device', 'read', { chatId: second.chat.id })).status, 'failed');

  const input = { id: 'first-message', op: 'send', chatId: first.chat.id, text: 'fixture message', phoneIp: '198.51.100.50' };
  const accepted = await submit(first, input);
  const duplicate = await submit(first, input);
  assert.equal(accepted.body.id, duplicate.body.id);
  assert.equal((await api('/requests/' + accepted.body.id, { account: guest })).status, 404);
  assert.equal((await submit(first, { ...input, text: 'different' })).status, 409);
  assert.equal((await result(accepted.body.id)).status, 'done');
  assert.deepEqual(fixture.calls.map(row => row.provider), ['codex']);
  assert.ok(fixture.calls[0].prompt.includes('fixture message'));
  assert.doesNotMatch(JSON.stringify(first.payloads) + fixture.calls[0].prompt, /203\.0\.113\.99|198\.51\.100\.50|phoneIp/);
  const read = await call(first, 'read1', 'read', { chatId: first.chat.id });
  assert.equal(read.data.messages.at(-1).content, first.label + ' replied using codex');
  assert.equal(JSON.stringify(read).includes(first.store.chat(first.chat.id).workspace), false);
  assert.equal((await submit(first, input)).body.id, accepted.body.id);
  assert.equal(fixture.calls.length, 1);

  assert.equal((await call(second, 'second-message', 'send', { chatId: second.chat.id, text: 'ASK_FIXTURE_FOR_APPROVAL' })).status, 'done');
  const waiting = (await call(second, 'read2', 'read', { chatId: second.chat.id })).data;
  assert.equal(waiting.run.approvals[0].id, 'mobile-approval');
  assert.equal((await call(second, 'stale', 'answer', { chatId: second.chat.id, runId: 'earlier-run', requestId: 'mobile-approval', decision: 'accept' })).status, 'failed');
  assert.equal((await call(second, 'approval', 'answer', { chatId: second.chat.id, runId: waiting.run.id, requestId: 'mobile-approval', decision: 'accept' })).status, 'done');
  const finished = await call(second, 'read3', 'read', { chatId: second.chat.id });
  assert.equal(finished.data.messages.at(-1).content, second.label + ' replied using claude');
  assert.deepEqual(fixture.calls.map(row => row.provider), ['codex', 'claude']);
  assert.match(await (await fetch(hub.origin() + '/remote/')).text(), /id="composer"/);
});

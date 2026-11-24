import { randomUUID } from 'node:crypto';
import { fail } from './store.mjs';

const requestLifetime = 60_000;
const operations = new Set(['list', 'read', 'send', 'stop', 'answer']);
const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);

function parse(input) {
  if (!input || !operations.has(input.op) || !validId(input.id)) throw fail('手机请求无效');
  const { id, op, chatId, before, text, runId, requestId, decision, answers } = input;
  if (op === 'list') return { id, op };
  if (!validId(chatId)) throw fail('对话标识无效');
  if (op === 'read') {
    if (before !== undefined && !validId(before)) throw fail('消息标识无效');
    return { id, op, chatId, before };
  }
  if (op === 'send') {
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw fail('请输入 1 至 20,000 个字符');
    return { id, op, chatId, text };
  }
  if (!validId(runId)) throw fail('任务标识无效');
  if (op === 'stop') return { id, op, chatId, runId };
  if (!validId(requestId) || !['accept', 'decline', 'skip'].includes(decision)) throw fail('批准请求无效');
  if (answers !== undefined && (!answers || Array.isArray(answers) || typeof answers !== 'object' ||
    Object.entries(answers).length > 20 || Object.entries(answers).some(([key, value]) =>
      !validId(key) || ![].concat(value).length || [].concat(value).length > 20 ||
      ![].concat(value).every(item => typeof item === 'string' && item.length <= 2000)))) throw fail('回答无效');
  return { id, op, chatId, runId, requestId, decision, answers };
}

// Only the authenticated mobile session and the specified computer can access a
// request. Payloads live in memory briefly, outside group history and agent context.
export class MobileRelay {
  constructor(store) {
    this.store = store;
    this.requests = new Map();
    this.resultBytes = 0;
  }

  devices(user) {
    return this.store.devices(user.id).map(({ id, name, online, mobile }) => ({ id, name, online, enabled: mobile === true }));
  }

  expire() {
    const now = this.store.clock();
    for (const [id, request] of this.requests) {
      if (request.expires <= now) {
        this.resultBytes -= request.resultBytes || 0;
        this.requests.delete(id);
      }
    }
  }

  submit(user, deviceId, input) {
    const device = this.store.deviceView(this.store.ownedDevice(user.id, deviceId));
    if (device.mobile !== true || !device.online) throw fail('该电脑离线或尚未开启手机访问', 409);
    const command = parse(input);
    this.expire();
    const entries = [...this.requests.values()];
    const existing = entries.find(r => r.session === user.sessionHash && r.device === deviceId && r.command.id === command.id);
    if (existing) {
      if (JSON.stringify(existing.command) !== JSON.stringify(command)) throw fail('请求标识已使用', 409);
      return { id: existing.id };
    }
    const outstanding = entries.filter(r => r.user === user.id && !r.result).length;
    if (outstanding >= 12 || this.requests.size >= 512) throw fail('请求过多，请稍后再试', 429);
    const id = randomUUID();
    this.requests.set(id, { id, command, user: user.id, session: user.sessionHash, device: deviceId,
      expires: this.store.clock() + requestLifetime, leaseUntil: 0, result: null });
    return { id };
  }

  claim(device, enabled) {
    this.expire();
    if (!enabled) return null;
    const now = this.store.clock();
    const row = [...this.requests.values()].find(r => r.device === device.id && r.user === device.user_id && !r.result && r.leaseUntil <= now);
    if (!row) return null;
    row.leaseUntil = now + 12_000;
    return { id: row.id, caller: row.user, command: row.command };
  }

  finish(device, id, result) {
    this.expire();
    const row = this.requests.get(id);
    if (!row || row.device !== device.id || row.user !== device.user_id || !row.leaseUntil) throw fail('手机请求已失效', 404);
    if (row.result) return { ok: true };
    const receipt = result.ok === true ? { status: 'done', data: result.data } :
      { status: 'failed', error: typeof result.error === 'string' ? result.error.slice(0, 2000) : '电脑未能完成请求' };
    const bytes = Buffer.byteLength(JSON.stringify(receipt));
    if (this.resultBytes + bytes > 24_000_000) {
      row.result = { status: 'failed', error: '服务器当前同步请求较多，请稍后再试' };
    } else {
      row.result = receipt;
      row.resultBytes = bytes;
      this.resultBytes += bytes;
    }
    return { ok: true };
  }

  result(user, id) {
    this.expire();
    const row = this.requests.get(id);
    if (!row || row.session !== user.sessionHash || row.user !== user.id) throw fail('请求已失效或不存在', 404);
    this.store.ownedDevice(user.id, row.device);
    return row.result || { status: 'pending' };
  }
}

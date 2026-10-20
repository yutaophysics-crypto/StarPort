import { redact } from './process.mjs';

export const COMPANION_IDLE_MINUTES = 5;
export const COMPANION_WARNING_MINUTES = 2;
const minute = 60000;
const stamp = value => typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value) || 0;

// A legacy numeric default is not evidence that the user chose to stop tasks.
export function companionLimits(saved = {}) {
  const minutes = Number(saved.stepMinutes ?? 30), valid = Number.isInteger(minutes) && minutes >= 3 && minutes <= 240;
  return { stepLimitEnabled: saved.stepLimitEnabled === true && valid, stepMinutes: valid ? minutes : 30 };
}

export function validateCompanionLimits(raw = {}, current = companionLimits()) {
  const stepLimitEnabled = raw.stepLimitEnabled === undefined ? current.stepLimitEnabled : raw.stepLimitEnabled;
  const stepMinutes = raw.stepMinutes === undefined ? current.stepMinutes : Number(raw.stepMinutes);
  if (typeof stepLimitEnabled !== 'boolean') throw Object.assign(new Error('单步限时开关格式无效'), { status: 400 });
  if (!Number.isInteger(stepMinutes) || stepMinutes < 3 || stepMinutes > 240)
    throw Object.assign(new Error('自定义单步时限应为 3–240 分钟'), { status: 400 });
  return { stepLimitEnabled, stepMinutes };
}

// Polling never infers a dead process from silence. Only an explicit deadline expires.
export class CompanionClock {
  constructor({ startedAt = Date.now(), minutes = 0, idleMinutes = COMPANION_IDLE_MINUTES } = {}) {
    this.startedAt = stamp(startedAt);
    this.minutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
    this.deadlineAt = this.minutes ? this.startedAt + this.minutes * minute : null;
    this.warningAt = this.deadlineAt ? this.deadlineAt - Math.min(COMPANION_WARNING_MINUTES * minute, this.minutes * minute / 2) : null;
    this.idleMs = idleMinutes * minute;
    this.idle = false; this.warned = false; this.expired = false;
  }
  poll(now = Date.now(), lastEventAt = this.startedAt) {
    if (this.expired) return [];
    const events = [], last = Math.min(now, Math.max(this.startedAt, stamp(lastEventAt)));
    const idle = now - last >= this.idleMs;
    if (this.deadlineAt !== null && now >= this.deadlineAt) {
      this.expired = true;
      return [{ type: 'deadline', at: now, minutes: this.minutes }];
    }
    if (idle !== this.idle) {
      this.idle = idle;
      events.push({ type: idle ? 'idle' : 'resumed', at: now, lastEventAt: last, idleMinutes: this.idleMs / minute });
    }
    if (!this.warned && this.warningAt !== null && now >= this.warningAt) {
      this.warned = true;
      events.push({ type: 'warning', at: now, minutes: this.minutes, remainingSeconds: Math.max(1, Math.ceil((this.deadlineAt - now) / 1000)) });
    }
    return events;
  }
  snapshot() {
    return { startedAt: this.startedAt, limitMinutes: this.minutes, deadlineAt: this.deadlineAt, idleWarnMinutes: this.idleMs / minute, stalled: this.idle };
  }
}

// Original tool I/O already lives in the saved message; keep a durable reference and
// a small public preview rather than copying private reasoning or claiming completion.
export function companionCheckpoint(message, reason, at = Date.now()) {
  const details = message.details || {}, activity = Array.isArray(details.activity) ? details.activity : [];
  const tools = new Map();
  for (const tool of [...activity.filter(item => item.kind === 'tool'), ...(Array.isArray(details.tools) ? details.tools : [])])
    tools.set(tool.id || tool, tool);
  const latest = [...tools.values()].at(-1);
  const commentary = activity.filter(item => item.kind === 'text' && item.text).at(-1)?.text || '';
  return { reason, at: new Date(at).toISOString(), chatId: message.chat_id, messageId: message.id,
    status: message.status, preview: redact(commentary || message.content || '').slice(-2000),
    toolCount: tools.size, latestTool: latest ? { name: latest.name || latest.nativeType || '工具', status: latest.status || 'unknown' } : null };
}

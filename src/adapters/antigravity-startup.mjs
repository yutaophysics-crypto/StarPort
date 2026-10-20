import { setTimeout as delay } from 'node:timers/promises';

// Retry only an explicitly identified temporary eligibility bootstrap failure.
// Any native stdout, even a partial/unknown event, makes replay unsafe; the one
// exception is agy's own zero-turn result reporting the failed check (cli.mjs).
export function temporaryAntigravityStartup(message) {
  const text = String(message || '');
  const serverError = /Eligibility check failed:[^\r\n]*(?:failed to fetch user info|failed to get profile picture|failed to make code assist backend request)/i.test(text)
    && /Eligibility check failed:[^\r\n]*\b(?:500|502|503|504)\b/i.test(text);
  const dropped = /Eligibility check failed:[^\r\n]*\/userinfo"?:\s*(?:EOF|connection reset|i\/o timeout|TLS handshake timeout)/i.test(text);
  return (serverError || dropped)
    && !/\b(?:401|403|429)\b|not eligible|not (?:currently )?available in|permission.denied|invalid.grant|account (?:suspended|disabled)/i.test(text);
}

export async function withAntigravityStartupRetry(attempt, { signal, emit, wait = delay } = {}) {
  const delays = [1000, 3000];
  for (let index = 0; ; index++) {
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { canceled: true, ...index ? { antigravityStartupFailure: true } : {} });
    try {
      const result = await attempt();
      if (index) emit?.({ type: 'notice', text: 'Antigravity 已恢复连接。' });
      return result;
    }
    catch (error) {
      if (error.canceled || !error.antigravityStartupFailure || signal?.aborted) throw error;
      emit?.({ type: 'diagnostic', kind: 'antigravity-startup-temporary', attempt: index + 1, message: error.message });
      if (index >= delays.length) {
        error.message = 'Antigravity 账号信息服务暂时不可用；启动阶段已自动重试 2 次，仍未恢复，请稍后重发。\n' + error.message;
        throw error;
      }
      emit?.({ type: 'notice', text: index === 0
        ? 'Antigravity 账号信息服务暂时不可用，正在自动重试（1/2）。'
        : 'Antigravity 账号信息服务暂时不可用，正在自动重试（2/2）。' });
      try { await wait(delays[index], undefined, { signal }); }
      catch (stop) {
        if (!signal?.aborted) throw stop;
        throw Object.assign(new Error('已停止'), { canceled: true, antigravityStartupFailure: true });
      }
    }
  }
}

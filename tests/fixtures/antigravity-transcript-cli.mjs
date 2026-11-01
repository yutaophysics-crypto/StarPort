// Stands in for agy 1.4: the stream-json shapes it prints and the transcript records it keeps,
// recorded from a real turn, without credentials or a model request. The stream leaves out the
// thought summaries and gives read_file's result as a line-and-byte count; the transcript has both.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2), resumed = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : null;
const id = resumed || 'cd5fff48-e25b-4a76-991c-349b7e1adcb2', base = Number(process.env.AGY_FIXTURE_BASE || 0);
const logs = join(process.env.AGY_FIXTURE_HOME, 'brain', id, '.system_generated', 'logs');
mkdirSync(logs, { recursive: true });
const send = event => console.log(JSON.stringify(event));
const keep = record => appendFileSync(join(logs, 'transcript_full.jsonl'), JSON.stringify(record) + '\n');
const step = (offset, step_type, state, extra = {}) => send({ event: 'step_update', step_update: { conversation_id: id, step_index: base + offset, state, step_type, ...extra } });
const pause = ms => new Promise(ok => setTimeout(ok, ms));
for await (const line of createInterface({ input: process.stdin })) {
  JSON.parse(line);
  send({ event: 'init', conversation_id: id, init: { cwd: process.cwd() } });
  step(0, 'user_input', 'DONE'); keep({ step_index: base, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nread notes\n</USER_REQUEST>' });
  step(1, 'agent_response', 'ACTIVE', { text_delta: 'I will read notes.txt.' });
  step(1, 'agent_response', 'DONE', { text_delta: '\n' });
  keep({ step_index: base + 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'I will read notes.txt.', thinking: 'The answer needs both values, so read the file first.',
    tool_calls: [{ name: 'read_file', args: { Path: 'notes.txt' } }] });
  const params = { Path: 'D:\\work\\notes.txt' };
  step(2, 'tool', 'ACTIVE', { tool_name: 'read_file', tool_info: { name: 'read_file', parameters: params } });
  step(2, 'tool', 'DONE', { tool_name: 'read_file', duration_seconds: 0.02, tool_info: { name: 'read_file', parameters: params, output: '2 lines, 17 bytes' } });
  keep({ step_index: base + 2, type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-10-31T22:16:00-04:00\nCompleted At: 2026-10-31T22:16:00-04:00\nShowing lines 1-2 of 2\n1: alpha=3\n2: beta=4' });
  await pause(Number(process.env.AGY_FIXTURE_PAUSE || 0));
  step(3, 'agent_response', 'ACTIVE', { text_delta: 'alpha * beta = 12' });
  step(3, 'agent_response', 'DONE', { text_delta: '\n' });
  keep({ step_index: base + 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'alpha * beta = 12', thinking: '3 times 4 is 12.' });
  send({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'I will read notes.txt.\nalpha * beta = 12\n', num_turns: 1 } });
}

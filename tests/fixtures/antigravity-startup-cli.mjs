// Isolated startup protocol reproduction; never uses a real model or login.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [file, mode] = process.argv.slice(2);
const previous = JSON.parse(readFileSync(file, 'utf8'));
previous.launches++; writeFileSync(file, JSON.stringify(previous));
const temporary = 'Eligibility check failed: failed to fetch user info: 500 Internal Server Error';
const send = event => console.log(JSON.stringify(event));
if (mode === 'recover' && previous.launches === 1 || ['exhaust', 'cancel'].includes(mode)) {
  console.error(temporary); process.exit(1);
}
// Real agy in stream-json mode reports the failed check on stdout as a zero-turn result.
const refusal = { event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: temporary, duration_seconds: 0, num_turns: 0 } };
if (mode === 'json-recover' && previous.launches === 1) { send(refusal); process.exit(1); }
if (mode === 'json-after-step') { send({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'DONE', text: 'partial' } }); send(refusal); process.exit(1); }
if (mode === 'forbidden') { console.error('Eligibility check failed: PERMISSION_DENIED (code 403)'); process.exit(1); }
if (mode === 'raw-output') { console.log('unknown native output'); console.error(temporary); process.exit(1); }
if (mode === 'executed') {
  send({ event: 'step_update', step_update: { step_type: 'tool', step_index: 1, tool_name: 'run_command', state: 'DONE', output: 'already ran once' } });
  console.error(temporary); process.exit(1);
}
for await (const line of createInterface({ input: process.stdin })) {
  const text = JSON.parse(line).message.content;
  const state = JSON.parse(readFileSync(file, 'utf8')); state.prompts.push(text); writeFileSync(file, JSON.stringify(state));
  send({ event: 'result', result: { status: 'SUCCESS', response: 'OK ' + text, conversation_id: 'native-retained' } });
}

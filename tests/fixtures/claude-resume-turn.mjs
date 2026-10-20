// Synthetic CLI protocol through the real Agent SDK: no accounts or network.
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const session_id = 'fixture-session';
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let inputs = 0, timer;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
  } else if (request.type === 'user') {
    inputs++;
    if (inputs !== 1) throw new Error('The current request was sent more than once');
    send({ type: 'system', subtype: 'init', session_id, model: 'fixture-model', permissionMode: 'default' });
    send({ type: 'system', subtype: 'task_notification', session_id, task_id: 'old-task', status: 'stopped',
      reason: 'worker_restart', summary: 'Orphaned by a previous Claude Code process exit and reported in an aggregate summary.' });
    send({ type: 'result', subtype: 'success', session_id, is_error: false, result: '', num_turns: 0, usage });
    // Leave the input stream open. The host must wait for the actual user turn.
    timer = setTimeout(() => send({ type: 'result', subtype: 'success', session_id, is_error: false,
      result: `The current request completed; input count: ${inputs}.`, num_turns: 1,
      usage: { ...usage, input_tokens: 5, output_tokens: 10 }, user_message_uuids: [request.uuid] }), 150);
  }
}
clearTimeout(timer);

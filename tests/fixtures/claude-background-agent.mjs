// Synthetic CLI protocol through the real Agent SDK: a background agent
// outlives the turn's result and reports back in a follow-up native turn.
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const session_id = 'fixture-session';
const usage = { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const agent = { task_id: 'agent-1', task_type: 'local_agent', description: 'Find workflow UI' };
let inputs = 0, timer;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } });
  } else if (request.type === 'user') {
    if (++inputs !== 1) throw new Error('The current request was sent more than once');
    send({ type: 'system', subtype: 'init', session_id, model: 'fixture-model', permissionMode: 'default' });
    send({ type: 'system', subtype: 'background_tasks_changed', session_id, tasks: [agent] });
    send({ type: 'system', subtype: 'task_started', session_id, ...agent, tool_use_id: 'agent-call', subagent_type: 'Explore', is_backgrounded: true });
    send({ type: 'result', subtype: 'success', session_id, is_error: false, result: 'Looking it up; I will reply when it finishes.',
      num_turns: 2, usage, user_message_uuids: [request.uuid], result_index: 0 });
    timer = setTimeout(() => {
      send({ type: 'system', subtype: 'task_notification', session_id, task_id: agent.task_id, tool_use_id: 'agent-call',
        status: 'completed', output_file: '', summary: 'Found the workflow UI' });
      send({ type: 'system', subtype: 'background_tasks_changed', session_id, tasks: [] });
      if (mode === 'silent') return;
      send({ type: 'system', subtype: 'init', session_id, model: 'fixture-model', permissionMode: 'default' });
      send({ type: 'result', subtype: 'success', session_id, is_error: false, result: 'Here is the step-by-step tutorial.',
        num_turns: 1, usage, result_index: 1 });
    }, 150);
  }
}
clearTimeout(timer);

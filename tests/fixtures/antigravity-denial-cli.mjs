// Imitates headless agy soft-denying a command: the turn ends with an empty answer.
// Never uses a real model or login.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [file, mode] = process.argv.slice(2);
const send = event => console.log(JSON.stringify(event));
let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const text = JSON.parse(line).message.content;
  const state = JSON.parse(readFileSync(file, 'utf8')); state.prompts.push(text); writeFileSync(file, JSON.stringify(state));
  turn++;
  if (turn === 1 || mode === 'always') {
    send({ event: 'step_update', step_update: { step_type: 'tool', step_index: turn * 2, tool_name: 'run_command', state: 'ERROR', tool_info: { parameters: { CommandLine: 'Get-ChildItem' } } } });
    console.error('Print mode: soft-denying tool confirmation "RunCommand" (auto-denied)');
    send({ event: 'result', result: { conversation_id: 'denial-session', status: 'SUCCESS', response: '', num_turns: 1 } });
  } else send({ event: 'result', result: { conversation_id: 'denial-session', status: 'SUCCESS', response: 'script written without running it', num_turns: 1 } });
}

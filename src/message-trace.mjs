// A reply's process log (every tool call with its full input and output) can be a thousand times
// the size of the reply. It is saved in message_traces, beside the message, which keeps an outline
// of it: ids, kinds, names, statuses and the commentary, enough to draw the reply, count its steps
// and settle it. Readers that need the inputs and outputs ask the store for the trace.
const OUTLINE = new Set(['id', 'kind', 'nativeType', 'name', 'status', 'scope', 'phase', 'turnId', 'stepIndex']);
const kept = (item, key) => OUTLINE.has(key) || (key === 'text' && item.kind === 'text') || (key === 'plan' && item.kind === 'plan');
const list = value => (Array.isArray(value) ? value : []);

function outline(item) {
  const result = {};
  for (const [key, value] of Object.entries(item || {})) if (kept(item, key)) result[key] = value;
  return result;
}

// { details: what the message row keeps, trace: { activity, tools } or null when nothing is kept apart }
export function splitTrace(details) {
  const activity = list(details?.activity), tools = list(details?.tools);
  if ((!activity.length && !tools.length) || isOutline(details)) return { details, trace: null };
  const light = {};
  for (const [key, value] of Object.entries(details)) if (key !== 'activity' && key !== 'tools') light[key] = value;
  light.activity = activity.map(outline);
  // The page falls back to the tool list only when a reply has no activity log.
  if (!activity.length) light.tools = tools.map(outline);
  return { details: light, trace: { activity, tools } };
}

// True when the outline holds everything: a log of commentary only, or a row read without its log.
// Older builds kept the whole log in the message; such a row is a full record of its own.
export function isOutline(details) {
  return [...list(details?.activity), ...list(details?.tools)].every(item => item && Object.keys(item).every(key => kept(item, key)));
}

export function withTrace(details, data) {
  if (data != null && isOutline(details)) Object.assign(details, JSON.parse(data));
  return details;
}

// Replies whose history text is built from their log: one that stopped or failed hands its tool
// calls on to the next model (history-context.mjs). A finished reply hands on only its answer.
export const unfinishedReply = row => row.role === 'assistant' && row.status !== 'complete';

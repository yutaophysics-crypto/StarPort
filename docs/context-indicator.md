# Context usage

[简体中文](zh-CN/context-indicator.md)

The composer percentage divides the latest native request's usage by the **smallest known, comparable limit**:

- Starport's history transfer budget, configured in Settings → Context and compaction.
- The model window reported by the native tool.
- A native configured window or compaction reference limit, when available.

Open the context indicator to see the individual values and the selected denominator. Limits refresh while the chat is open, normally within 30 seconds. **Refresh context limits** requests a fresh native reading. Changing Starport's budget also updates the indicator without another model turn.

Codex reads its effective layered configuration through `config/read` in the chat's working folder, including `model_context_window` and `model_auto_compact_token_limit`. Unreported model defaults are not guessed. A `body_after_prefix` compaction threshold counts only growth after the prefix; it is shown separately and excluded from the minimum because usage counts the whole request.

Claude Code uses its native SDK's `getContextUsage({detail: 'summary'})` to read the resolved compaction-policy window for the selected model. This metadata query sends no model prompt, resumes no transcript, persists no session, and makes no per-category token-count API calls. The empty metadata session's usage never replaces the conversation's real input counters. Older tools without the metadata interface show native limits as unavailable.

The numerator remains native per-request usage: Codex's latest request total, or Claude's input plus cache reads and writes, excluding output. It is not cumulative billing usage. Native usage updates on native events, not on every keystroke.

Starport's budget applies to history passed into a fresh session; it does not impose a hard limit on a continued native session. The percentage can therefore exceed 100%. This indicator is a comparison against current limits, not a guarantee of exactly when compaction will trigger. Native reserves and policies can affect that trigger, and a running tool may apply changed configuration only on its next launch. Unsent text and history awaiting transfer are not included.

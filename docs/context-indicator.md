# Context usage

English | [简体中文](zh-CN/context-indicator.md)

The composer shows the latest native request's usage divided by the **model window reported by that tool**. Starport's history transfer budget and native compaction settings do not change this percentage.

Open the indicator to see three separate sections:

1. **Model window usage.** The last reported usage and its model window. Codex uses the latest request's total tokens, rather than cumulative billing usage. Claude Code uses input tokens plus cache reads and writes, excluding output and subagent totals. These measurements follow each tool's own usage convention; they are not identical token counts across providers.
2. **Native auto-compaction.** Claude Code's resolved compaction policy window, or Codex's configured compaction threshold and optional configured model window. These are reference settings, separate from the denominator above. Claude Code reserves space and may compact before its policy window is full. Codex's `body_after_prefix` threshold counts only growth after the prefix and cannot be subtracted from total usage. A running tool may adopt changed settings only at its next launch.
3. **Starport history transfer.** The estimated-token budget in Settings → Context and compaction. It controls history passed to a fresh session after a model switch or settings change. Starport summarizes earlier history when it exceeds the budget. The native tool manages compaction in continuing sessions. Antigravity also has a single-input byte guard to avoid observed transport truncation; this guard is separate from the model window.

Reference settings refresh while the chat is open, normally within 30 seconds. **Refresh reference settings** reads them again without sending a model prompt, resetting the conversation, or changing native configuration. Changing the Starport budget updates its reference value without changing the model window percentage.

Codex reads its effective layered configuration through `config/read` in the chat's working folder, including `model_context_window`, `model_auto_compact_token_limit` and its scope. Unreported model defaults are not guessed. Claude Code uses `getContextUsage({detail: 'summary'})` to read the resolved compaction policy for the selected model. This temporary metadata session resumes no transcript, persists no session, and makes no per-category token-count API calls. Its empty-session usage never replaces the real conversation's counters. Older tools without this interface show the reference as unavailable.

When usage is known but the native model window is not reported, the indicator shows tokens without a percentage. Antigravity and DeepSeek currently show **Unavailable** because their integrations do not provide verified current-window measurements. Unknown data is never displayed as zero. If reported usage exceeds its reported model window, the indicator shows **Inconsistent data** and retains both raw values in the details, rather than displaying an impossible percentage or silently clamping it to 100%.

Usage updates with native events, not on every keystroke. During compaction the indicator shows **Compacting…** until a new report arrives. A model, working folder or native session change invalidates stale counters. Unsent text and history awaiting transfer are not included. The percentage is separate from account limits and is not an exact countdown to compaction.

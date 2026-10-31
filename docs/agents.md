# Agent tools: models, permissions and usage

English | [简体中文](zh-CN/agents.md)

StarPort drives each agent tool through its own native interface and existing login. This page explains how each tool is connected, what the options in StarPort mean, and what StarPort shows while a task runs. Options are saved per conversation unless stated otherwise.

## Connections

| Tool | Connection | Native session |
| --- | --- | --- |
| Codex | Local Codex App Server over JSON-RPC | Resumable thread |
| Claude Code | Official Claude Agent SDK driving the local CLI | Resumable session |
| Antigravity | Local AGY CLI with streaming JSON | Resumable session |
| DeepSeek Harness | Published official SDK over JSON-RPC | New SDK session each turn |

Desks that StarPort uses only once (compaction, planning, calls between companions, workflow steps and exam seats) ask Codex for ephemeral threads. Codex does not save these, so they stay out of the Codex app's list. Conversations and @companion desks keep resumable threads and stay listed. A Codex version without ephemeral threads saves them as before.

**Settings → Connections & data** shows installation and a real connection check separately: a tool can be installed without its account being usable. After you sign in with the tool's own login method, choose **Check tools again**. StarPort does not store API keys, login tokens or account passwords.

StarPort looks for tools in this order: a path you set in **Connections & data**, the current `PATH`, then each tool's standard per-user installation folder. For Antigravity the last fallback is a copy in StarPort's own `.runtime/antigravity` folder. Antigravity's chat and usage queries run in its normal local login environment; StarPort does not add an SSH marker, which could make the tool use a different credential store.

On Windows, the DeepSeek Harness desktop app can enable the `dsh` command. StarPort recognizes the official `resources/runtime/cli/bin/dsh.cmd` on `PATH`; if StarPort was already running when you enabled the command, enter that file's full path in **Connections & data**. StarPort then uses the desktop app's bundled runtime and existing login, so no separate CLI installation is needed. The desktop app's model preferences become defaults, and preferences saved explicitly in an SDK profile take precedence. Quota for a DeepSeek account login is shown in the desktop app and is separate from the open-platform API balance.

## Models and reasoning effort

Choose a model from the list, **Use tool default**, or enter a **Custom model**. Codex reads its catalog from the App Server's `model/list`, Antigravity from `agy models`, and Claude Code from the local CLI through the official SDK. Claude models show full names from `resolvedModel`, such as Claude Opus 5.5, while the saved value stays the tool's own alias or identifier. DeepSeek uses the installed tool's catalog, your configuration and saved defaults. Reading a catalog never sends a model message; Claude catalog queries also disable tools, startup hooks and session saving. After updating a tool, choose **Refresh** next to the model list.

Reasoning levels depend on the tool and the exact model. Claude Code and Codex read the supported levels from their native model catalogs, and Claude's `xhigh` is labeled **Extra**. DeepSeek reads its levels, including **Off**, from the installed adapter; a third-party DeepSeek provider shows custom levels only when it declares `reasoningEfforts`. Antigravity uses the Low, Medium and High levels its CLI provides.

When StarPort cannot confirm a model's capabilities, for example with **Use tool default**, a custom model or a failed catalog read, it offers only the tool default and explains why. Switching models never lowers a saved level silently: an incompatible level asks you to choose again and is checked once more before sending. Each tool's choices are saved independently. Actual availability still depends on your account and the tool's access policy.

## Permissions

Permission changes apply from the next message and cannot be changed while a task runs. StarPort sends the chosen permissions every time it starts or resumes a native session, so a narrowed setting never inherits broader permissions. It does not change any tool's global settings.

### Codex

The **Permissions** selector below the input and in the side panel offers:

- **Ask for approval**: work inside the working folder; you approve or decline requests for extra permissions.
- **Approve for me**: same folder and network limits, but extra permission requests go to Codex's native [auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review). The review can decline; it does not accept everything.
- **Full access**: Codex's native full-access configuration. It can modify any file the computer allows and use the network without asking; system and organization policies still apply.

Choose **Apply permissions** (or **Enable full access**) to confirm. New conversations start with **Ask for approval**; older conversations keep their earlier read-only scope until you apply a new choice. If the local Codex version does not support auto-review, that option is disabled and the run is refused. Policy limits or errors returned by Codex are never silently bypassed.

### Claude Code

**Mode** offers **Ask for approval**, **Plan / read-only analysis** (the default for new conversations), **Chat (deny actions requiring approval)**, **Allow file edits**, **Auto review** and **Bypass permissions**.

- Actions that need approval appear as cards with **Allow once** and **Decline**, through the SDK's `canUseTool`. **Chat (deny actions requiring approval)** uses the native `dontAsk` behavior and declines them.
- **Auto review** (native `auto`) lets Claude Code decide what to allow; availability depends on your account, model and settings.
- **Bypass permissions** (native `bypassPermissions`) is enabled only when you choose it. Most tool actions then run directly, including file operations outside the working folder.
- Claude Code's own allow and deny rules, forced-ask rules, plan-mode limits and questions keep their native behavior. If native initialization does not enable the chosen mode, StarPort reports an error instead of switching modes.

**Use a separate Git worktree** runs the conversation in its own worktree.

### Antigravity

**Tool permissions** defaults to **Allow all tools**, which passes the native `--dangerously-skip-permissions` flag whenever StarPort starts or resumes a session and approves command execution and file access automatically. **Use native permissions** keeps Antigravity's own rules; actions that would need an approval prompt are then declined, because StarPort runs Antigravity non-interactively. **Enable terminal sandbox** is a separate setting and stays in effect when selected. These choices affect only sessions StarPort starts. See Antigravity's [headless permissions](https://antigravity.google/docs/cli/headless/#permissions-in-headless-mode).

## Approvals and questions

Questions from an agent can be answered below the conversation; choose **Submit answer** when done. Codex's native `requestUserInput` and Claude's `AskUserQuestion`, including multiple choice and free text, go straight back to the tool. When an assistant writes a question followed by two or more short options, StarPort also offers an answer form that sends your choice as a normal reply; this is a shortcut, not a permission approval. Submitted answers stay in the conversation, and your draft and attachments are kept.

Stopping a task withdraws pending approvals without approving them. Requests StarPort does not handle yet, such as Codex's extra permission extensions and interactive MCP authentication, are declined with an explanation.

## Queue and steering

When you press Enter during a task, the message goes to **Queued messages** above the input. You can edit or delete it; a message being edited is held until you save or cancel. The queue is stored locally and survives a refresh. When the current task finishes successfully, queued messages start one by one. Codex, Claude Code and Antigravity continue their native sessions; DeepSeek gives the next SDK session the conversation history after its subtasks have finished and reported back. After a stop, a failure or a service restart, the remaining messages stay queued until you continue.

With Codex and Claude Code, **Steer** sends a queued message to the running task. Codex uses the native [`turn/steer`](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn). Claude reads the message through native streaming input with `next` priority at the next pause between tool calls, without interrupting the current action; Claude marks it as sent only after the tool confirms receipt. Antigravity and DeepSeek support queueing, editing and deleting, and continue after the task ends. Queued and steered messages can include attachments. Neither queueing nor steering approves permissions.

## Activity and subagents

**Activity display** offers **Hidden**, **Overview** and **Full**, shared by all four tools and kept after a refresh. In the default overview, the task's steps stay open while it runs; select a step or subagent to see its records. When the task finishes, fails or stops, the activity collapses behind **View activity**. Hiding activity never hides approvals, errors or the stop button.

Activity is saved and shown in the order the tool reported it. Codex shows public reasoning summaries, live command output, exit codes, file diffs and native plans. Claude shows public thinking, native tool names, inputs and results. Antigravity uses its native step states, and DeepSeek shows reasoning, replies, steps and structured tool results separately. Tool inputs and outputs can be expanded in full. StarPort does not fill in reasoning a tool does not expose, and it does not show Codex's raw reasoning blocks or signatures.

Failures, declines, stops and unconfirmed endings are shown separately; the next step starting or the conversation ending is not treated as proof that a tool call succeeded. When a task ends, StarPort shows the saved final state immediately. While a task runs, the page reconciles its state every 5 seconds and after reconnecting, without calling a model or clearing your draft.

Subagents appear inside the reply they belong to, with their task description, native status, latest action, last activity and running time. Codex uses its native collaboration and sub-thread notifications, Claude links subtasks to native tool scopes, DeepSeek uses the SDK's subagent events, and Antigravity reads its local subtask logs. The detail available differs by tool; StarPort says when a subtask has no detailed steps, and shows an ending as unconfirmed when there is no evidence that it finished.

A DeepSeek reply ending is not the end of the task. StarPort keeps the SDK process until the parent agent is idle, every known subagent has ended and the parent has handled resumable subagent results. The stop button still interrupts the whole tree.

Imported Codex and Claude conversations keep the activity that can be shown. Older StarPort records still bound to a native session recover their activity from the tool's local records when opened, without calling a model or replaying tools.

## Context indicator

**Context** below the input shows the most recent context usage the current tool reported; select it for token counts, window size and how they are measured. Codex uses `last.totalTokens / modelContextWindow` from `thread/tokenUsage/updated`. Claude uses the input of the main session's latest request, including cache reads and writes but not output, against the window the model reported, following the [Claude Code status line fields](https://code.claude.com/docs/en/statusline#context-window-fields). Cumulative usage, subagents and other models are not mixed into the percentage.

The value is stored per native session. After a change of model, working folder or native session it shows **Awaiting data** until the next report, and a recognized native compaction clears the old value. Unsent drafts and messages from other tools that have not yet been sent are not included. It is not your account's remaining quota and does not predict when the tool will compact. Antigravity and DeepSeek do not report context usage yet and show **Unavailable**.

## Remaining usage

Choose **Check remaining usage** under the current tool. The dialog can switch between the four tools, refresh, and expand the full vendor report. It shows when each check ran; missing data, missing logins and failures are stated, and results from another account are never shown.

| Tool | What is checked |
| --- | --- |
| Codex | Native `account/rateLimits/read`: each limit bucket, remaining share, reset times, extra credit and available resets, plus any other fields Codex returns |
| Claude Code | The SDK's native `/usage` report: subscription, session, weekly and per-model limits, extra usage and spend, and this computer's usage attribution |
| Antigravity | Native `/usage` and `/credits` text reports in their original format; the CLI must be signed in separately from the IDE |
| DeepSeek Harness | The official `/user/balance`: availability, total, granted and topped-up balance in the original currency and precision; third-party providers must be checked with that provider |

Checks use the tool's existing login or service configuration. They do not start a model turn, send a chat message, change a conversation or redeem credit. Fields a vendor does not provide are not estimated. A tool may answer from its own cache; the time shown is when StarPort's check finished. For Claude, explicit `--settings` (including proxy and working-folder rules) are kept and only hooks are disabled for the check; the SDK usage method is experimental and reports a clear error if the installed version is incompatible.

The local API is `GET /api/providers/{codex|claude|antigravity|deepseek}/usage?workspace=<absolute folder>`, protected by the local token and same-origin checks. DeepSeek also accepts a `service` parameter; credentials for a custom provider are never sent to the official address.

## Goal and plan modes

Codex goal mode uses the native `thread/goal/set/get` state rather than a prompt. StarPort checks the goal after each turn and continues while it is active. Pausing updates the native goal and interrupts the current turn. Stopping the service stops the work; after a restart, continue it yourself. There is no scheduled wake-up.

**Plan mode** uses Codex's native `collaborationMode: plan` and the native plan settings of Claude Code and Antigravity. The current DeepSeek SDK has no equivalent, so the option is disabled for DeepSeek rather than imitated with a prompt.

## Switching tools

Tools share user messages and complete replies, not each other's internal state or tool caches. When you switch back to a tool, it receives the messages it has not seen. Failed or interrupted replies remain visible but are not passed to the next tool as finished answers. See [Long conversations and context](../README.md#long-conversations-and-context) for budgets and compaction.

## References

[Codex App Server](https://learn.chatgpt.com/docs/app-server) · [Claude Code headless](https://code.claude.com/docs/en/headless) · [Claude /usage](https://code.claude.com/docs/en/costs#using-the-usage-command) · [Antigravity CLI](https://antigravity.google/docs/cli/headless/) · [Antigravity /usage](https://antigravity.google/docs/cli/commands/usage/) · [AI Credits](https://antigravity.google/docs/cli/credits/) · [DeepSeek SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk) · [DeepSeek balance](https://api-docs.deepseek.com/api/get-user-balance/)

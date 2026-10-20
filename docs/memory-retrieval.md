# Open-ended memory retrieval

Starport does not classify the user's interests into a list of allowed subjects. A confirmed memory is trusted source material, not an instruction that applies to every request.

## Flow

1. At task start, build a retrieval guide from the current request. A short continuation can refer to the last substantive delivered user message in this chat. Send only bounded candidate IDs/titles; no memory bodies are automatically added.
2. The current harness model calls `starport_memory_search` with whatever wording is relevant. The generic index ranks literal multilingual terms by document frequency, title weight and length. No domain names or manually enumerated synonyms gate access.
3. Search returns at most 30 candidate titles/short excerpts per call (10 by default). The model judges whether a record actually applies. For example, a stock preference containing AI is a possible lexical hit for an AI query; it is not automatically a preference for an AI game.
4. For missing synonyms or another language, the model reformulates the query. Empty queries browse titles with pagination, and a kind filter helps discover communication preferences independently of the subject. The model can then use `starport_memory_read` to read selected IDs with a task-specific reason.
5. New needs arising during the task can trigger another search/read. Scope, confirmation and conflict checks run again; the model cannot request another project's records.
6. The answer's receipt records actual full reads, revisions and model-provided reasons. Search previews are shown separately. Candidate memory creation still requires later user confirmation.

## Ownership and limits

- Starport owns storage, generic candidate ranking, scope checks, budgets and receipts. Current-project requirements and explicitly saved global preferences remain a separate user-authored instruction layer.
- The current Codex, Claude Code, Antigravity or DeepSeek model handles semantic interpretation and decides what to read. This uses its normal task/tool turns, not a separate paid preflight model or a new provider account.
- Search indexes are derived and local. Confirmed body changes invalidate the cached token index. Shared-folder sync transfers the authoritative records; each computer builds its own index.
- Candidate, deleted, foreign-project and synchronization-conflicted records cannot be searched/read. Reads never confirm or modify memory, files, chats or provider settings.
- A task has a 12,000-character search-preview budget and a 9,000-character full-body budget, up to 30 distinct full records and eight IDs per call. Tool errors and unavailable native command permissions are reported; no global permission settings are changed.
- There is no vector/embedding index in this version. Literal recall can miss wording or cross-language equivalents until the model rewrites or browses. A reason is the model's explanation, not proof that its selection was correct or that it used the memory in the final answer. Tests verify transport, scope, budget and receipt behavior, not semantic quality for every possible subject.

Future semantic/vector candidate engines can replace the local ranker behind the same scoped search/read interface. A topic list is not required for that extension either.

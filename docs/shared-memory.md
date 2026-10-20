# Shared memory, preferences and historical retrieval

Starport owns memory independently of provider accounts. Open **Shared memory** in the sidebar. Indexed memory rows, instructions and a derived FTS5 index live in the existing relational SQLite database. No external memory service, provider configuration change or Codex-global-memory write is needed.

## Four layers

1. **Discover and review.** Assistants propose stable facts, preferences, goals, values and project knowledge with an exact user quote supplied in that task. New entries and updates remain candidates until you approve them. Discovery depends on model behavior; no separate paid summarization call runs.
2. **Recall.** A new request receives a retrieval guide and bounded candidate pointers, plus explicitly saved personal preferences/project requirements. The current task model judges applicability and reads only the necessary confirmed memory bodies. All four adapters share this path and can retrieve more during work. Unconfirmed candidates are unavailable to these read tools.
3. **Retrieve original detail.** Tools search Starport conversation records and read bounded excerpts, with links to the original message. Already imported records are searchable. Hidden native histories are not scanned or automatically loaded into the prompt.
4. **Separate scopes.** Global memory/preferences apply across Starport; project memory/requirements apply only to chats in that project. Each exact working folder is automatically a project: chats selecting the same folder share it, while subfolders are separate projects. Sidebar groups only organize chats. Existing chats migrate to their current folders' projects without discarding existing project IDs, memories or requirements.

## Interface

- **Candidates** show proposed text, the user quote, source and original memory for updates. Edit or dismiss before **Confirm and share**. Confirmation atomically replaces the original entry; a stale revision fails rather than overwriting a newer edit.
- **Confirmed** supports addition, editing, scope filters, search and removal. **Your profile** includes confirmed global facts, preferences, goals and values. Project entries and unconfirmed inferences are excluded.
- **Personal preferences** and **Project requirements** have separate editors and local drafts. Drafts survive closing/reopening and switching panels until page reload. Explicitly saved requirements take effect on the next task.
- A chat's project is its exact working folder; there is no marking step or separate project selector. Browsing folders does not create projects. The folder holds a small `.starport/project.json` identity marker (`.starport/` ignores itself in git), so a project renamed or moved outside Starport is found again; a copied folder gets its own identity. Renaming a folder in the picker updates every chat and project path inside it. Older projects without a local folder retain their memories and requirements and can be reattached. When a chat's folder first becomes a project, its native session is kept: it held only global context, and the project's requirements arrive with each turn. The project chip above the composer opens its requirements.
- Changing a chat's working folder relocates only its history archive; markers, shared workflow ledgers and other chats' archives remain in their folders. Destination preparation and database updates roll back on failure. Startup repairs older stranded files using known session workspace paths. Failed old-file cleanup remains tracked for retry and conversation deletion. Internal desks and exam seats do not create ordinary projects.
- **History search** allows manual non-project, selected-project or all-records searches. Read excerpts or open and highlight their original message.
- Memory settings separately control recall, candidate discovery and assistant history search. All default on. Assistant proposals always require confirmation. Saved user instructions are explicit settings.
- Per-answer receipts count full memory records actually read. **Search previews** separately lists index entries/excerpts seen during retrieval; matches do not imply use. Full reads include the model-provided relevance reason and revision in the recorded metadata. Old receipts remain viewable.

There is no automatic identity/personality inference, native-history mining or separate model request. Models may still fail to suggest a memory or follow a preference.

## Provider transports and boundaries

| Adapter | Actual transport |
|---|---|
| Codex | App Server dynamicTools and item/tool/call |
| Claude Code | Official Agent SDK in-process starport_context MCP server, allowing only the five Starport context tools |
| Antigravity | Native command tool runs scripts/context-tool.mjs through a temporary task-scoped loopback bridge |
| DeepSeek Harness | Same helper, inherited through its SDK child-process environment |

Tools: starport_memory_search, starport_memory_read, starport_history_search, starport_history_read, starport_memory_propose.

AGY/DeepSeek retrieval requires native permission to execute the helper and access its files/network. Native sandbox and command restrictions still apply; permission modes are not weakened. If unavailable, the prompt tells the model to report that instead of inventing results. Global native MCP configuration is unchanged.

The temporary bridge uses a random credential, rejects browser-origin requests, exposes only scoped reads and unconfirmed proposals, and closes when the task ends. It cannot access the main application API. Native dynamic/MCP tools use the same host.

Scope comes from the current chat: project tools cannot choose another project; non-project tools search only non-project chats. This bounds these tools, not the filesystem access of an otherwise authorized native agent. Historical text is source data, not a new instruction or evidence of a current preference change. Proposal evidence must come from actual user inputs supplied in that task.

## Bounds and context changes

There is no topic taxonomy, topic gate or fixed synonym list. A generic corpus index uses Unicode word segmentation, Han bigrams and length/frequency ranking, with tokenization cached by record revision and confirmation epoch. Initial hints contain at most eight IDs/titles, never memory bodies. Short follow-ups use the latest substantive delivered user message in this chat; assistant output, queued messages and other chats do not seed these hints. Search returns bounded title/excerpt candidates; an empty query pages through titles, with an optional memory-kind filter. The task model rewrites queries or browses to bridge synonyms/languages, evaluates the memory's own conditions, and explicitly reads appropriate records. Unrelated keyword matches are not automatically injected. No separate selector model, external memory service or embedding credentials are required. This is lexical candidate retrieval plus the current model's semantic judgment, not a vector index; unfamiliar wording can require query reformulation or browsing, and the model may skip retrieval or choose poorly. See [Open-ended memory retrieval](memory-retrieval.md).

Each task allows 12,000 characters of search previews, up to 30 distinct full reads under a cumulative 9,000-character serialized-body budget, and at most eight IDs per read. Every read rechecks confirmation, project membership, deletion and synchronization conflicts. Budget omissions are not counted as full reads. Explicit saved preference/requirement documents separately allow 12,000 characters and still apply to their saved scope. Disabling shared memory blocks both search and read without removing saved records.

FTS5 trigrams index only completed user/assistant messages, not streaming deltas. Failed messages and undelivered guidance are excluded. Search terms are literal SQL parameters; results are scoped and paginated. Reads return at most 20,000 characters with continuation offsets. A task allows at most 80 memory/history tool calls. Message metadata records recalled IDs, instruction revisions, candidates and historical sources. Tools appear in the existing task-flow view; native private reasoning is not reconstructed.

Confirmed memory changes/removals, recall settings, instructions, project membership and the recall-policy version affect the native-session fingerprint. The next task creates a fresh native context when needed and rebuilds from Starport history. The retrieval-v3 upgrade does not resume a native session carrying older automatic memory bodies or missing the new tool definitions. Active tasks retain their original context, and on-demand reads fetch currently eligible records. Original native goals belong to their original session; changes during a paused goal require a fresh native session on continuation. Already sent text may remain in old chats/native transcripts; retrieval does not delete memory or rewrite history.

A reserved trailing starport-memory fenced JSON array remains a fallback for proposals. It is hidden in rendering and validated. Invalid proposals cannot confirm memories or change permissions. A tool proposal may remain pending if its task later fails; it still requires confirmation.

## Deletion and backup

Removing a memory deletes only its row. A content digest discourages automatic repetition of dismissed proposals without storing plaintext; manual addition remains possible. This is ordinary deletion, not forensic erasure.

Deleting a source chat removes its derived search entries, nulls source pointers and retains independently saved memories/evidence. Memory removal/search does not delete attachments, workspaces, generated files, backups or native histories.

Export includes memories, instruction records and project membership. Import remains compatible with old v1/v2 backups, remaps project IDs and restores memories as candidates. Imported preferences/requirements appear as pending content; saving is required to activate them. Existing active instructions remain effective. Source pointers are not blindly reused. Malformed imports roll back together; sharing settings remain unchanged.

## Local API

Optional multi-computer sharing uses your own synchronized folder, without a Starport account. See [Personal memory sync](memory-sync.md). The live SQLite file remains local; sync has a separate opt-in control, explicit conflicts and preserved candidate confirmation.

Routes reuse loopback, origin and token protection:

- GET /api/memories?view=confirmed|candidate|profile&project=<id-or-global>&search=&offset=0&limit=50
- POST /api/memories: kind/title/content, optional project_id/supersedes; confirmed:true is explicit manual save. Superseding updates remain candidates.
- GET/PATCH/DELETE /api/memories/:id; changes require revision.
- PATCH /api/memories/config: boolean enabled/capture/search.
- GET/PATCH /api/context/preferences; writes require content/revision.
- GET/PATCH /api/projects/:id/requirements; same revision contract.
- POST /api/context/history/search: query, optional projectId/all/offset/limit.
- POST /api/context/history/read: chatId, optional messageId/projectId/all/start/maxChars.
- GET /api/projects; POST /api/projects {workspace} adds a folder before its first chat; POST /api/projects/:id/attach {workspace} reconnects a legacy/missing folder. The legacy unmark endpoint returns 409 because folders and projects are now inseparable.
- POST /api/folders/rename {path,name}: renames the folder on disk with every Starport path inside it; refused while a chat inside is running.
- PATCH /api/chats/:id no longer accepts project_id: the project follows workspace.

Standalone provider apps/CLIs do not automatically receive Starport memory. This implements shared context, not autonomous orchestration or embodied hardware.

# Database architecture

English | [简体中文](zh-CN/database-architecture.md)

StarPort uses relational SQLite. A single main database file is SQLite's normal storage format; it does not mean every record is packed into one table or a JSON document. The local, single-user workspace does not require a separately administered database server or a database per conversation.

## Tables and relationships

| Table | Purpose | Relationships |
| --- | --- | --- |
| `groups` | Conversation groups | Referenced by conversations and projects |
| `chats` | Title, workspace, tool and conversation settings | May belong to a group |
| `messages` | User/assistant messages, status and native execution details | Belong to a conversation |
| `sessions` | Native session mapping and context cursor | One mapping per conversation and tool |
| `history_imports` | Native import provenance and deduplication | Points to the imported conversation |
| `chat_transfers` | Session-file digests and import deduplication | Points to the local copy |
| `projects` | Selected working folders | Exact folder identity; subfolders are separate projects |
| `history_archive_locations` | Historical conversation-archive locations | Tracks old locations needing retry after a workspace move |
| `settings` | Application and connection settings | Retrieved by key |
| `attachments` | Attachment data, metadata and copied-file locations | Referenced by messages |
| `chat_summaries` | Compaction summaries and their coverage | One per conversation; removed with it |
| `companions` | Companion identity, tool, model and working mode | Joined to rooms through membership |
| `room_members` | Room membership and memory options | References groups and companions |
| `room_calls` | Per room, whom each caller (主模型 or a companion) may call mid-task | References groups and the called companion; removed when a companion leaves the room |
| `workflows` | Reusable stages, seats and verification | Mounted on conversations |
| `workflow_mounts` | Conversation placement, seat assignments and triggers | References workflows and conversations |
| `companion_desks` | Companion sessions within a conversation | Hidden desk conversations follow the parent |
| `prediction_scores` | Brier scores for matured ledger predictions | Stored per mount and proposition |

Primary and composite keys identify records and native mappings. Foreign-key checks are enabled; messages are indexed by conversation and creation time. Groups organize conversations independently of folders and models. Memory and synchronization add their own relational tables and indexes; inspect the schema modules for the full current schema.

## Files

- `.data/hub.sqlite`: the main local database.
- `.data/hub.sqlite-wal`: the live write-ahead log; it can contain committed data not yet copied into the main file.
- `.data/hub.sqlite-shm`: the WAL shared-memory index.
- `.data/attachments/`: attachment file copies managed alongside database metadata.
- Native tool histories and user workspaces are managed separately.

WAL and SHM are live database components, not garbage. JSON fields retain provider-specific execution details and workflow run-card records; conversation titles, messages, groups and mappings remain separate relational records.

## Backup and growth

Use **Settings → Connections & data** for logical exports. To copy database files directly, stop the service normally or use SQLite's consistent backup mechanism. Do not copy only a running main file while omitting its WAL.

Add indexes, pagination or maintenance based on measured query costs. Consider a separate database service when multi-machine access or substantial concurrent writing requires it, rather than basing a migration on the number of files.

Deleting a conversation removes that conversation's StarPort records, messages and mappings, plus its own history archive. Attachments, workspaces, native histories, exports and backups remain. Related files require separate inspection and explicit removal. Automatic checkpoint/VACUUM is not part of normal conversation deletion.

References: [SQLite use cases](https://www.sqlite.org/whentouse.html), [single-file database](https://www.sqlite.org/onefile.html), [WAL](https://www.sqlite.org/wal.html).

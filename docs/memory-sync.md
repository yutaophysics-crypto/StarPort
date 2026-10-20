# Personal memory sync

English | [简体中文](zh-CN/memory-sync.md)

> **Testing:** built and covered by automated tests, but not yet used between two real computers. Before turning it on, export a backup from **Settings → Connections & data → Export all records**.

Starport supports an opt-in shared folder without a Starport account. Your existing cloud drive, file sync application or network share transports the files. Starport has no hosted service, registration, provider-password form or built-in cloud-drive login.

## Set up two computers

1. On computer A, open **Shared memory → Device sync**.
2. Browse to a private folder already managed by your file sync application, and choose **Enable sync**. Starport creates a dedicated `StarportMemory` subfolder.
3. Wait until the sync application delivers that subfolder, including `space.json`, to computer B.
4. On computer B, open the same control, choose the corresponding **parent folder** and enable sync. Local paths may differ. The shared `space.json` identity makes them one memory space.

Start with one device. Do not independently initialize two empty, disconnected folders: each would create its own space. If the space identity changes, Starport pauses instead of replacing local memory. Resolve any cloud-drive conflict involving `space.json` before reconnecting. A local write/check is not proof that the cloud or another computer has received it.

While Starport is running, it checks the folder every 15 seconds. **Sync now** checks immediately. Your other computer receives changes after the external sync application transfers them and its Starport checks the folder. An unavailable folder leaves local records intact; the next successful check records and exports the latest local state. A new task uses the latest synchronized, eligible memory; synchronization does not change the context of a task already running.

## Shared and local data

- Shared: confirmed memories, candidates, memory kind/scope, evidence quotes and source labels; saved personal preferences and project requirements; project identities and names. The user profile is derived from the confirmed global memories.
- Confirmed items retain confirmation, and candidates remain candidates. Synchronization is a trusted replica of your own memory space; the separate backup importer still requires review.
- Local: chat text, messages, source-message links, native sessions, tool permissions, provider credentials, attachments, generated files, work-folder paths, browser state and unsaved drafts. A source title/quote can be read on another computer, but retrieving its original chat requires separately importing that chat.
- Project memory follows the shared project identity. A remote project is created with an empty local work path; select it for a chat independently of that chat's work folder. Existing same-named projects with different identities remain separate.

The sync files contain plaintext memory **and immutable change history**, including previous versions of later-deleted items. Choose a folder accessible only to you. This is not end-to-end encryption or forensic erasure. Starport does not upload to a cloud provider itself; your chosen file sync tool controls that transfer. Do not commit this directory to the StarPort source repository.

## Conflicts and deletion

Each change identifies the versions it was based on. Concurrent edits keep both versions instead of choosing by computer clock. Conflicts are listed with device names, timestamps and content; choose a version and explicitly confirm it. Conflicting memory/preferences are withheld from new assistant prompts until resolved. A changed conflict rejects a stale selection and requires another review.

Deletion is a replicated change, so an offline stale copy cannot silently restore an item. A concurrent edit/delete conflict hides the item and preserves both versions for explicit resolution. Changes to a confirmed item and approval of a proposed update remain guarded: a proposal based on an older confirmed version cannot overwrite a newer one.

**Disable sync** retains local memory, queued changes and the shared files. It does not delete cloud data, chats, attachments or directories. Reconnecting to the same space retains the previous causal history. A copied backup with identical memory content is linked to the existing remote identity where possible; conflicting versions and ambiguous duplicates require review.

## File and database contract

The live SQLite database stays local. Local tables `memory_sync_changes`, `memory_sync_entities` and `memory_sync_candidate_bases` track changes, applied state, conflicts and proposal baselines; local settings hold the chosen folder and enabled flag. An outbox persists changes before file publication and retries interrupted writes.

`StarportMemory/space.json` carries the space identity. `changes/<UUID>.json` files are immutable, bounded, checksummed operations with causal parents. Writers use separate temporary files and rename completed files; no shared writable snapshot, distributed SQLite access or wall-clock conflict winner is used. Partial/missing/invalid files are counted for retry, and child operations wait for their parents. Space and change subdirectories reject symbolic links. This validates format/integrity, not the identity of an attacker: anyone able to alter the trusted sync folder can propose changes. Stop sync and inspect the folder if unexpected files or versions appear.

The operational history grows over time. This initial personal-use version does not compact history or erase it automatically. Preserve a backup before any manual reorganization. It is designed for personal memory records, not attachment archives or unlimited team throughput.

Local token/origin checks protect these endpoints: `GET/PATCH /api/memory-sync`, `POST /api/memory-sync/run`, `POST /api/memory-sync/resolve`. No new externally reachable server is opened.

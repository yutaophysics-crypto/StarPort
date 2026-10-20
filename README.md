# StarPort

English | [Chinese](README.zh-CN.md)

<img src="public/icon.svg" width="64" height="64" alt="StarPort">

A local workspace for conversations with Codex, Claude Code, Antigravity and DeepSeek Harness. Keep conversations, groups and shared memory together while using each tool's existing local login and models. Group conversations let people invoke agents on their own connected computers and share the replies.

The local workspace does not require a StarPort account. Group conversations use accounts on the server you choose; model credentials stay on each participant's computer. StarPort does not provide model subscriptions or transfer credentials between providers.

## Get started

### Windows

1. Install [Node.js 24 or later](https://nodejs.org/), including npm. Reopen your terminal or launcher after installation.
2. Choose **Code → Download ZIP** on this repository and extract the complete ZIP, or clone the repository using the address in the **Code** menu.
3. Double-click **Start StarPort.cmd** in the project folder. The first launch installs the pinned dependencies, then opens StarPort. Later launches reuse the installation.
4. Install and sign in to whichever supported agent tools you want to use. Open **Settings → Connections & data** to check or configure their locations.

The default workspace address is **http://127.0.0.1:3210/**. Extract the ZIP before starting; do not run the launcher from inside the archive. Python and a separate MAGI download are not required for normal use.

New installations start in **English**. Choose **Settings → General → Interface language** to switch to Chinese. A previously saved English or Chinese preference is preserved. This changes interface text, not conversation content, filenames in your projects or raw tool output.

### macOS

Requirements: macOS 14 or later, Node.js 24 or later and Apple Command Line Tools. If needed, install the tools with `xcode-select --install`.

```sh
npm ci
npm run install:macos
```

The installer creates **StarPort.app** in `~/Applications` by default. Existing installations are detected and reused, including older localized app names. Open the app from Finder or the Dock; use **File → New Window** or `⌘N` for another window. Closing a window does not stop background tasks. See the [macOS desktop guide](docs/macos-desktop.md).

### Manual launch: Windows, macOS or Linux

```sh
npm ci
npm run launch
```

Each computer needs its own installed and authenticated agent tools. Downloading StarPort does not download conversations, memory, credentials, native tool installations or model access from another computer.

## One workspace, native agent capabilities

| Tool | Connection | Configuration |
| --- | --- | --- |
| Codex | Local Codex App Server | Existing Codex login; native models, reasoning levels and permission modes |
| Claude Code | Official Claude Agent SDK driving the local CLI | Existing Claude login or native configuration; model-specific effort and permissions |
| Antigravity | Local AGY CLI with streaming JSON | Native login, model options and permissions |
| DeepSeek Harness | Native SDK / JSON-RPC | Native profiles, providers and models; supports the desktop distribution's CLI runtime |

Only the tools you install are needed. StarPort discovers available runtimes and lets you specify an executable when discovery is insufficient. Tool and model settings remain independent; unsupported capabilities are explained rather than silently mapped to a different behavior.

Select models from the current tool's list or enter a supported model identifier. Reasoning levels follow the selected native tool and model. Permission choices include the modes supported by that tool; the native tool can still enforce its own restrictions or require approval. Selecting a working folder alone does not create an operating-system sandbox.

The Codex interface includes goal and plan controls where supported. Claude Code supports native approval and question callbacks. Approval cards let you allow or reject actions, answer questions or skip a question without granting permission. Remaining-usage reports show the fields available from each vendor's own interface; missing data is not invented.

## Conversations and task progress

- Organize conversations into groups independently of their working folders. Conversations in one group may use different folders, tools and models.
- The selected working folder is the project. Conversations in the same folder share its project instructions and memory; subfolders are separate projects.
- View the final answer alone, a task overview, or detailed available execution records. During a task the overview stays visible; after completion it collapses and can be reopened. Select a step or subagent to inspect its recorded activity.
- Native reasoning summaries and execution records are shown only when the tool supplies them. StarPort does not invent hidden reasoning or claim to reproduce a vendor's private desktop UI exactly.
- Running conversations show a spinner; completed replies awaiting review show a blue dot. Native failures, interrupted tasks and unconfirmed completion remain distinct.
- Messages sent while a task is running enter a queue. Edit, remove or explicitly **Steer** a queued message into the current task. Entered text changes the Stop control into a Send arrow; clearing the input restores Stop.
- A task is not stopped merely because it is quiet. Explicit time limits, cancellation and native failures retain their own behavior. Subagent completion is tracked before declaring a task finished.

When switching tools, StarPort starts or resumes the appropriate native session and supplies conversation context within the configured budget. Older content can be compacted by a selected model; full local history remains available through the history tools and a conversation-specific archive under `.starport/history/`. See **Settings → Context** for budgets and compaction options.

## Shared memory and project instructions

StarPort's memory is independent of provider accounts. It supports candidate extraction, confirmation, retrieval at the start of a new request and additional retrieval during a task. Personal preferences and project instructions are managed separately.

Candidates require confirmation before becoming shared memory. Memory selection is based on relevance to the current request, with no fixed list of supported topics. The model can inspect candidate indexes, read selected entries and retrieve supporting history when more detail is needed.

The memory link beneath a reply opens a receipt for that request: which entries were supplied and which new candidates it produced. It does not present the entire memory collection as if all entries had been used.

- [Shared memory](docs/shared-memory.md)
- [Retrieval architecture](docs/memory-retrieval.md)
- [Sync memory between computers](docs/memory-sync.md)

For personal device sync, select corresponding folders managed by your existing sync service, such as Nutstore, OneDrive or Syncthing. StarPort creates a `StarportMemory` subfolder and checks it every 15 seconds while running. Confirmed memory, candidates, profiles and saved instructions can sync; chats, attachments, logins and working folders stay local. Conflicts retain both versions for review. Use a private sync folder because the files contain memory text and revision history.

## Companions, workflows and exams

Create named companions with their own tools, models, working modes and memory preferences. Add them to a room and invoke them in a conversation; their saved replies remain visible afterwards.

Reusable workflows can assign stages and seats to companions, review results and repeat or verify work. Mount a workflow on a conversation and run it manually, on a schedule or at an interval. Schedules run in the StarPort service, so closing the page does not stop them; the service itself must remain running.

Exams let companions solve a task independently. A proposal specifies a paper folder, instructions, seats, optional reference material and per-seat limits. Nothing starts until you review the proposal and choose **Start exam**. Each seat gets a separate folder and session, and results include recorded file changes and boundary checks. These checks are retrospective; a seat is not an operating-system sandbox. Native global tool instructions can still apply.

Notifications show completed or failed tasks with a short summary and a link back to the conversation. The bell controls do-not-disturb; **Settings → Notifications** controls sound and test notices. Explicitly saved language and notification preferences are retained.

## Group conversations and phones

Open **Group chat & mobile**, choose a server and sign in to an account on that server. A group owner shares the server address and invitation code. Each person connects their own computer and selects which folders and tools it exposes.

Participants can chat with each other and invoke agents in the group. Shared replies are visible to the group; only the caller can answer their own approvals or stop their tasks. Calls use that caller's connected computer and native model credentials, not another member's subscription.

The phone interface is a responsive PWA served over HTTPS. A local `127.0.0.1` address cannot reach another computer. Installation depends on the phone and browser; ordinary web access remains available. The repository does not ship native IPA, APK or HAP packages.

Self-host the account and group services from **Settings → Connections & data → This computer's server**, or use the supplied Docker Compose and Caddy deployment. Do not expose the private local workspace on port 3210 to the internet.

- [Groups, mobile access and deployment](docs/collaboration.md)
- [Servers and accounts](docs/account-center.md)

## Files, browser pages and subtitles

Attach files or folders directly from StarPort. Folder browsing shows folders on the computer running the service. A folder reference does not recursively copy that folder.

The optional [Edge extension](extensions/edge) pairs with StarPort and lets you explicitly attach a browser tab or read Bilibili subtitles using that browser's current login. Browser credentials remain in Edge. The tool reads only the requested pages or videos; it does not read browsing history, password fields or unrelated form input. Missing subtitles or failed authentication produce an explanation, not a fabricated transcript. See the [browser subtitle guide](docs/browser-video-subtitles.md).

Local file links in replies can be opened with the default application. On Windows, the context menu offers **Open file**, **Show in File Explorer** with the file selected, and the system **Open with** chooser. Ambiguous relative filenames require a choice. Rendering a message does not execute a file action, and executable or unknown file types use an application chooser.

## Import, export and move to another computer

Use **Import conversations** to select local Codex or Claude Code history, preview it and choose a destination group. Imports are independent copies, not live synchronization; they do not inherit native permissions or automatically run tasks. Claude imports read local CLI history, not Claude web history.

For one conversation, choose **Export conversation** from its menu:

- **Session file** (`.starport.json`) carries that conversation's messages, available execution records and supported uploaded attachments. Import it on another computer and choose a local working folder.
- **Markdown** produces a readable transcript.

A session file does not contain other conversations, shared memory, account logins, native session bindings, permissions or queued jobs. Files generated in the working folder need to be moved separately. Reimporting identical content opens the existing copy rather than overwriting another conversation. Current limits are 120 MB per session file and 8 MB per uploaded attachment.

**Settings → Connections & data** also exports and imports a complete logical backup of StarPort records. Imported memory requires review and confirmation. Folder references and browser connections need to be configured on the destination computer. Backups must not be committed to Git.

Deleting a conversation removes its StarPort records and its own `.starport/history/` archive. Attachments, generated files, working folders, native tool history, exports and backups remain. Related material must be checked and removed separately. Ordinary deletion does not perform automatic database compaction or promise irreversible erasure.

## Local storage and maintenance

The local workspace uses relational SQLite tables with WAL mode. The main database is `.data/hub.sqlite`; a single database file is normal SQLite storage. The WAL and SHM files are part of the live database, not disposable leftovers. See [database architecture](docs/database-architecture.md).

Use logical exports for routine backups. Before copying database files directly, stop the service normally or use SQLite's consistent backup facilities; copying only a live main file can omit committed WAL data.

Windows helper files:

| File | Purpose |
| --- | --- |
| `Start StarPort.cmd` | Install dependencies if needed and start the local workspace |
| `Restart StarPort.bat` | Wait for active conversations before restarting |
| `Clean StarPort leftovers.bat` | Explicit, optional checkpoint and compaction of the local database |

The maintenance helper is not run automatically when you delete a conversation. It does not replace checking individual attachments, workspaces or external backups. Do not run maintenance while a task is active.

## Themes

The themes are **Azure → Starport → Deep Space**, with Azure as the default. Existing choices are preserved. **Home** opens the theme's welcome view without stopping current tasks. Backgrounds and interface assets are bundled locally; conversation views dim decorative backgrounds for readability and respect reduced-motion preferences.

[Branding](docs/branding.md) · [Azure](docs/star-sea-theme.md) · [Starport](docs/spaceport-theme.md) · [Deep Space](docs/deep-space-theme.md)

## Development

Requirements: Node.js 24 or later. Python 3.10 or later is optional for skill installation and host-catalog generation.

```sh
npm ci
npm test
npm start
```

The test runner uses an isolated temporary folder and cleans it afterwards. A single test has a two-minute limit; a test file that does not exit within five minutes is reported and stopped. Run selected files with `npm test -- tests/i18n.test.mjs`. GitHub Actions runs the suite on Windows with Node 24 for pushes to `main` and pull requests.

| Location | Responsibility |
| --- | --- |
| `src/server.mjs` | Local HTTP API and static assets |
| `src/runner.mjs`, `src/adapters/` | Context assembly, task lifecycle and native adapters |
| `src/storage.mjs`, `src/compaction.mjs` | SQLite records and conversation compaction |
| `src/workflows.mjs`, `src/workflows/` | Companions, rooms, workflow scheduling, ledgers and exams |
| `public/app*.js` | Main workspace, views, settings and interaction |
| `public/i18n.js` | English and Chinese interface translations |
| `public/mobile/`, `src/collaboration/` | Group and mobile interface, service and execution bridge |
| `tests/` | Unit, integration and isolated UI fixtures |

The frontend uses ordered plain scripts rather than a framework build. `node tests/ui-fixture.mjs` starts an isolated demonstration server with temporary data and simulated tools. Do not connect tests to personal accounts or production histories.

Optional tool entry points can be installed with `python scripts/install-skills.py`; rerun it after moving the project. In Codex, invoke `$harness-hub`. The entry point opens StarPort's own local interface and does not replace a native tool's UI.

StarPort reuses MAGI's host registration catalog and bundled marked, KaTeX and Archivo resources, preserving their notices. The conversation database, adapters and workspace frontend are implemented here. The complete MAGI repository is not a runtime dependency. To regenerate the catalog, place the pinned [MAGI 2.8.0 source](https://github.com/Misaka16384/magi/tree/e95f14a4a1601008cee9a00aa2b5e78c49842794) in ignored `vendor/magi`, then run `npm run sync-magi`.

## Contributing

Fork this repository and open a pull request against `main`. The repository owner reviews and merges contributions. Changes after approval require another review; contributors do not receive direct upstream write access. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

StarPort's own source is licensed under [MIT](LICENSE). Bundled third-party code, fonts and assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Vendor CLIs, SDKs, models and subscription services remain subject to their respective terms.

# StarPort

English | [简体中文](README.zh-CN.md)

<img src="public/icon.svg" width="64" height="64" alt="StarPort">

StarPort is a local workspace for Codex, Claude Code, Antigravity and DeepSeek Harness, plus local models through Ollama. Conversations, rooms, shared memory and project instructions live in one place, while each tool keeps its own login, models and permission modes. Companions and workflows let several agents work in the same conversation. Group conversations, where people call agents on their own connected computers, are in development.

The local workspace does not need a StarPort account. Group conversations use accounts on a server you choose; model credentials stay on each participant's computer. StarPort does not provide model subscriptions or move credentials between providers.

## Highlights

- **Prompts at hand.** Save the prompts you use often. **Prompts**, next to the send button, lists them; pick one to insert it at the cursor. The same menu saves what you have typed as a new prompt, and renames, reorders or deletes prompts.
- **Memory you manage yourself.** All four tools share one memory, independent of any vendor account. Models only propose candidates; nothing is remembered until you confirm it. You can add, edit, search and remove entries yourself, and personal preferences and each project's instructions are kept separately. The receipt under each reply shows which entries that request received.
- **Bring your conversations along.** Import local Codex history, as well as Claude Code, Antigravity and DeepSeek history, with titles, working folders and a record of tool calls. Then continue in StarPort with any tool, so changing tools does not mean starting over.

## Feature status

StarPort is a personal project that its author uses every day, and most of what this page describes is in regular use. Two labels mark the rest:

- **Testing**: built and covered by automated tests, but not yet used in real work. Expect rough edges.
- **In development**: not finished. Behavior and stored data may still change.

| Feature | Status |
| --- | --- |
| [Moving conversations and backups to another computer](#import-export-and-move-to-another-computer) | Testing |
| [Memory sync between computers](docs/memory-sync.md) | Testing |
| [One-way mentions](docs/rooms-and-workflows.md#one-way-mentions) | Testing |
| [Importing from Claude Code, Antigravity and DeepSeek](#import-export-and-move-to-another-computer) | Testing |
| [Workflow ledgers](docs/rooms-and-workflows.md#ledgers) | Testing |
| [`@主模型` in mentions](docs/rooms-and-workflows.md#mentions) | Testing |
| [Companions calling companions](docs/rooms-and-workflows.md#companions-calling-companions) | Testing |
| [Project previews and per-service networking for Claude on Windows](docs/external-tools.md#persistent-project-previews) | Testing |
| [Group conversations and phones](#group-conversations-and-phones) | In development |
| [Exams](docs/rooms-and-workflows.md#exams) | In development |

If you try one of these and something goes wrong, please [report it](#feedback-and-bug-reports).

## Get started

### Windows

1. Install [Node.js 24 or later](https://nodejs.org/), including npm. Reopen your terminal or launcher after installation.
2. Choose **Code → Download ZIP** on this repository and extract the whole archive, or clone the repository using the address in the **Code** menu.
3. Double-click **Start StarPort.cmd** in the project folder. The first launch needs an internet connection to install the pinned dependencies; later launches reuse them.
4. Install and sign in to the agent tools you want to use. **Settings → Connections & data** shows which tools StarPort found and lets you set an executable path.

The workspace opens at **http://127.0.0.1:3210/**. Run the launcher from the extracted folder, not from inside the ZIP. Python and a separate MAGI download are not needed for normal use.

New installations start in English. **Settings → General → Interface language** switches to Chinese, and a saved choice is kept. Only interface text changes; your messages, names, file names and tool output stay as written.

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

Each computer needs its own installed and signed-in agent tools. This repository holds source code, theme assets and tests only. It contains no conversations, memory, credentials or tool installations. To bring your own records along, see [Import, export and move to another computer](#import-export-and-move-to-another-computer).

## Agent tools

| Tool | Connection | Options in StarPort |
| --- | --- | --- |
| Codex | Local Codex App Server (JSON-RPC) | Model, reasoning effort, plan and goal modes, goal budget, **Ask for approval** / **Approve for me** / **Full access** |
| Claude Code | Official Claude Agent SDK driving the local CLI | Model, reasoning effort, working mode (including plan, **Auto review** and **Bypass permissions**), separate Git worktree, approvals and questions |
| Antigravity | Local AGY CLI with streaming JSON | Model, reasoning effort, chat, edit or plan mode, **Allow all tools** or native permissions, agent, terminal sandbox |
| DeepSeek Harness | Official SDK over JSON-RPC | Model, model provider, reasoning effort; also works with the desktop app's bundled CLI |
| Ollama *(testing)* | Local Ollama HTTP API | Downloaded local models; thinking on/off where the model supports it |

Ollama is text-only: it does not read or write files, run commands or use StarPort's tools, and StarPort sends the conversation record with every turn. It talks to the Ollama service on this computer (`http://127.0.0.1:11434` by default, or `OLLAMA_HOST`); download models first with `ollama pull`. Ollama is not offered in group conversations.

Only the tools you install are needed. Model lists and reasoning levels come from each tool. When StarPort cannot confirm what a model supports, it says so instead of guessing. Permission choices map to the tool's own modes, and the tool can still enforce its rules or ask for approval. Choosing a working folder does not create an operating-system sandbox.

Approval cards let you allow or decline an action, answer a question, or skip it without granting permission. **Check remaining usage** shows what each vendor's own interface reports; missing fields are not estimated. Sessions that StarPort starts in Antigravity default to **Allow all tools**; choose **Use native permissions** under **Tool permissions** to keep Antigravity's own rules.

Details: [Agent tools: models, permissions and usage](docs/agents.md).

## Conversations

- **Rooms** in the sidebar group your conversations. Conversations in one room can use different folders, tools and models. Drag rooms, and conversations within a room, into your own order.
- The working folder is the project. Conversations in the same folder share project instructions and project memory; subfolders are separate projects. Choose or rename the folder from the folder picker below the input.
- **Activity display** sets how much of a task you see: **Hidden**, **Overview** or **Full**. During a task the overview stays open; afterwards it collapses behind **View activity**. Subagents appear inside the reply they belong to. StarPort shows only what the tool reports and does not invent hidden reasoning.
- A spinner marks a running conversation, including one that companions are working for; a blue dot marks a finished reply you have not viewed. Failures, stopped tasks and unconfirmed endings are shown separately.
- Messages you send during a task wait in **Queued messages**, where you can edit or delete them. With Codex and Claude Code, **Steer** hands a queued message to the running task. Queued messages can carry attachments. A task is never stopped just because it is quiet.
- **Branch from here**, under a finished reply, starts a new conversation with the history up to that reply. **Prompts**, next to the send button, inserts your saved prompts. Each code block has a **Copy** button that copies the original text.
- The **Context** indicator below the input shows the latest context usage reported by Codex or Claude Code.

*(testing)* One Claude response, thinking included, stops at 128,000 tokens. That is the ceiling for every current model, and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` cannot raise it. Thinking that hits it before producing text or a tool call is discarded whole, while thinking before a tool call is kept and the next response starts with a fresh limit. So every Claude run gets a read-only checkpoint tool (`mcp__starport_thinking__checkpoint`, no approval needed) and is told to record what it has established, what is open and what comes next once a stretch of thinking runs long, then think on. Split this way, total thinking is not bound by the per-response limit, and Claude is not asked to think less.

The Codex interface includes goal and plan controls where supported. Claude Code supports native approval and question callbacks. Approval cards let you allow or reject actions, answer questions or skip a question without granting permission. Remaining-usage reports show the fields available from each vendor's own interface; missing data is not invented.
Details: [Conversations, files and context](docs/workspace.md).

## Long conversations and context

When you keep using the same tool, Codex, Claude Code and Antigravity resume their native sessions, receive only the messages they have not seen and manage their own context. When a new session has to read the history (after you switch tool or model, branch, or change conversation settings, and on each DeepSeek or Ollama turn), StarPort sends the history within a per-tool budget. If it does not fit, a summarizer model compacts older messages into a structured summary that keeps your own points. The model then receives the summary and the recent messages verbatim. The summary belongs to the conversation and is reused after later switches; StarPort compacts again only when new content no longer fits.

- Organize conversations into groups independently of their working folders. Conversations in one group may use different folders, tools and models.
- The selected working folder is the project. Conversations in the same folder share its project instructions and memory; subfolders are separate projects.
- A room can have a default working folder (room menu → Default working folder…, or a conversation's menu → Use as the room's default working folder). New conversations started in the room begin there; existing conversations keep their own folders. Hovering the room name shows it.
- View the final answer alone, a task overview, or detailed available execution records. During a task the overview stays visible; after completion it collapses and can be reopened. Select a step or subagent to inspect its recorded activity.
- Native reasoning summaries and execution records are shown only when the tool supplies them. StarPort does not invent hidden reasoning or claim to reproduce a vendor's private desktop UI exactly.
- Antigravity's stream leaves out its thought summaries and gives file reads only as a line and byte count. While it works, StarPort reads agy's own local transcript (`~/.gemini/antigravity-cli`, read-only) and adds both to the reply's steps; read results keep up to 8,000 characters. *(testing)*
- Running conversations show a spinner; completed replies awaiting review show a blue dot. Native failures, interrupted tasks and unconfirmed completion remain distinct.
- When a conversation's own model stops to ask you a question (Claude's AskUserQuestion, Codex's request for input), its conversation shows an amber question mark instead of the spinner until you answer, and a popup at the bottom right says "Needs your answer" with the question, in its own colour and with its own chime, apart from the "Done" popup. Permission requests and companions' desks raise none.
- Messages sent while a task is running enter a queue. Edit, remove or explicitly **Steer** a queued message into the current task. Entered text changes the Stop control into a Send arrow; clearing the input restores Stop.
- A task is not stopped merely because it is quiet. Explicit time limits, cancellation and native failures retain their own behavior. Subagent completion is tracked before declaring a task finished.

Messages that are not sent verbatim are saved to `.starport/history/<conversation id>.md` in the working folder, where the model can read them; `.starport/` contains its own `.gitignore`. **Settings → Context** turns automatic compaction on or off, sets each tool's budget (by default 100k tokens for Codex and Claude Code, 60k for Antigravity and DeepSeek) and chooses up to three summarizer models. Each request to Antigravity is also capped at 184,000 bytes to avoid truncated input.

### Selected text: explain and read aloud *(testing)*

Select text in a conversation and a small bar offers **Translate/Explain** and **Read aloud**.

- **Translate/Explain** opens a card under the selection. Each click starts a new hidden conversation that receives only the prompt and the selected text: no conversation history, memory or instructions from StarPort. The default is Antigravity `gemini-3.8-flash-low` with the prompt 用三句话解释这个词语/短语/句子. **Settings → Selection** changes the tool, model and prompt; a local Ollama model also works. The tool's own built-in instructions and global files such as `CLAUDE.md` or `GEMINI.md` may still apply.
- **Read aloud** uses the browser's voices and picks a voice for the text's language. A bar at the top of the page shows that it is speaking and has a **Stop** button.

The selection bar can be turned off per device in **Settings → Selection**.


## Shared memory and project instructions

StarPort's memory is independent of provider accounts, and all four tools share it. It supports candidate extraction, confirmation, retrieval at the start of a new request and additional retrieval during a task. Personal preferences and project instructions are managed separately.

Candidates require confirmation before becoming shared memory. Memory selection is based on relevance to the current request, with no fixed list of supported topics. The model can inspect candidate indexes, read selected entries and retrieve supporting history when more detail is needed.

The memory link beneath a reply opens a receipt for that request: which entries were supplied and which new candidates it produced. It does not present the entire memory collection as if all entries had been used.

- [Shared memory](docs/shared-memory.md)
- [Retrieval architecture](docs/memory-retrieval.md)
- [Sync memory between computers](docs/memory-sync.md)

*Testing.* For personal device sync, choose matching folders managed by your existing sync service, such as Nutstore, OneDrive or Syncthing. StarPort creates a `StarportMemory` subfolder and checks it every 15 seconds while running. Confirmed memory, candidates, profiles and saved instructions can sync; chats, attachments, logins and working folders stay local. Conflicts keep both versions for review. Use a private sync folder, because the files contain memory text and revision history.

## Rooms, companions and workflows

Rooms can also hold **companions**: named agents with an avatar, role, personality, tool, model, reasoning effort and an unattended working mode (the tool's native permission mode). Personality changes only the tone a companion uses with you, not its analysis. A companion can join any number of rooms.

- **Mentions**: type `@name` to give a task to a companion. A single mention goes straight to that companion. When a message mentions several, a planner model first sets the order, for example one companion does the work and another reviews it. **Settings → Workflows** sets three planner models, tried in order; if none responds, the order in your message is used. Each companion has its own desk session in each conversation.
- **One-way** *(testing)*: the companion receives only this message, plus results from companions earlier in the same mention, and not the conversation history. Its reply still returns to the conversation. This is an instruction, not technical isolation, because the companion shares the working folder.
- **Working alongside** *(testing)*: while a companion works, you can mention other companions to work in parallel, or talk to the conversation's model without a mention. A second request to the same companion waits its turn and shows as queued; its clock starts when its turn comes. The room panel shows each working companion's elapsed time, updated every second.
- **`@主模型`** *(testing)*: a message that mentions companions goes to them alone. Write `@主模型` before a part of the message to give that part to the conversation's own model, which takes its place in the order of work, for example after the companion whose results it summarizes.
- **Calling companions** *(testing, off by default)*: per room, tick whom the conversation's model and each companion may call while they work. An allowed caller hands part of its task to a companion, which works at a fresh desk and reports back; a "X calls Y" card shows the call. Calls nest at most three deep and cannot loop.
- **Workflows** are reusable templates made of stages and seats. Seats in one stage run in parallel, and the next stage sees their results. A review seat can send work back for up to three retries. Manage workflows in the **Workflow library**, then mount one on any conversation and choose a companion for each seat. Companions from outside the room join it automatically.
- **Triggers**: manual, daily at a set time (optionally on chosen weekdays), or at an interval. Schedules run in the StarPort service, so closing the page does not stop them, but nothing runs while the service is off. A missed run can catch up once or be skipped.
- **Run cards** record each run in the conversation. Expand a card to follow each step, stop the run, or **Reply** so that your next message includes the run's results. Every run starts fresh desk sessions that do not read the conversation history.
- **Ledgers** *(testing)* (optional, off by default) carry notes between runs: a PLAN, claims, an append-only CHANGELOG and checks, committed to Git after each run. Companions can only propose PLAN changes, which take effect after you confirm them. Dated predictions are scored with the Brier score. Ledgers live in `.starport/ledgers/` in the working folder and are shared by conversations in that folder that mount the same workflow.
- **Exams** *(in development)* let companions solve the same task independently, without the conversation's context. The conversation model proposes an exam with `starport_exam_propose`; nothing is copied until you review the proposal and choose **Start exam**. Each seat gets its own copy of the paper under `StarPortExams` on your desktop, with reference material if the seat is open book. Afterwards StarPort checks each seat for changed or added files and for tool calls outside its folder. A seat is not a sandbox: the checks find problems afterwards rather than prevent them, and each tool's global instructions still load.
- **Memory**: in each room, every companion has two switches, **Read long-term memory** (on by default) and **Propose memory candidates** (off by default). A companion's candidates must quote your own words and still need your confirmation.

Details: [Rooms, companions and workflows](docs/rooms-and-workflows.md).

*Testing.* **Reference material** (知识库): hang local folders on a room (room menu → Reference material…), a conversation (conversation menu) or a companion (its settings). A turn reads its room's and its conversation's folders; a companion at work also reads its own. Exam seats and Starport's own desks read none. Folders stay where they are: the model gets their paths and top-level contents, and searches them with its own tools. They are read-only: Claude gets them as extra working directories with edits denied, and its sandboxed terminal may only read them; Codex's sandbox reads outside the working folder but blocks writes there (except with full access); agy gets `--add-dir`, and Antigravity and DeepSeek are only asked not to write. Ollama cannot read files. A resumed session is told again only when the list changes. A folder that contains the working folder is skipped for that turn, and drives, the home folder, Starport's data folder and credential folders are refused. To add to them, ask in the conversation, e.g. "download this paper into the room's knowledge base": the model then calls `starport_knowledge_save`, and Starport itself downloads the URL (http/https, up to 500 MB, never from this computer's own addresses) or copies a file from the working folder into the chosen folder, without overwriting unless asked. The save is refused unless your message in that turn mentions the knowledge base (知识库, knowledge base, reference material); everything else is written to the working folder as before. The conversation's own model can save into the room's, the conversation's and the room companions' folders; a companion @-mentioned in the conversation into the room's, the conversation's and its own. Called companions, workflow steps and exam seats never save. A Codex conversation starts a new native session once when it first gets somewhere to save, because Codex fixes its tools when a session starts.

*Testing.* agy retries within a turn when its reply hits the model's output limit or its stream or connection drops, yet still reports that error at the end. A turn that finished with a complete final answer after such a retry counts as complete. If an Antigravity companion at an unattended desk (a call, an exam seat, an @mention or a workflow step) really does stop mid-turn on one of these, StarPort resumes the same agy conversation and asks it to carry on, at most twice; each time is noted on the card. The conversation's own model is not resumed automatically.

*Testing.* While a companion works, you can mention other companions to work alongside it, or talk to the conversation's model without a mention. A second request to the same companion waits its turn and shows as queued; its clock starts when its turn comes. The room panel shows each working companion's elapsed time, updated every second.

## Notifications and settings

When a task finishes or fails, StarPort shows a notification with the room, conversation title and a short summary; clicking it opens the conversation. On Windows this is a native popup with a short chime, and the taskbar button flashes while StarPort is in the background. Other systems use browser notifications. A message that mentions companions notifies once, when everyone it named has finished. The conversation you are viewing, tasks you stopped and tasks with messages still queued do not notify. The bell in the top bar turns **Do not disturb** on or off.

**Settings** holds the global options: **General** (language and theme), **Notifications** (sound and a test notice), **Workflows** (planner models, retries and step time limits), **Context** (compaction and budgets) and **Connections & data** (tool locations, the local server and backups).

## Group conversations and phones

> **In development.** Group conversations, the phone interface and the self-hosted server are not finished. Expect bugs, and expect behavior and stored data to change.

Open **Groups & mobile**, choose a server and sign in to an account on that server. A group owner shares the server address and an invitation code. Each person connects their own computer and chooses which folders and tools it exposes.

Participants can chat with each other and invoke agents in the group. Shared replies are visible to the group; only the caller can answer their own approvals or stop their tasks. Calls use that caller's connected computer and native model credentials, not another member's subscription.

The phone interface is a responsive PWA served over HTTPS. A local `127.0.0.1` address cannot reach another computer. Installation depends on the phone and browser; ordinary web access remains available. The repository does not ship native IPA, APK or HAP packages.

Self-host the account and group services from **Settings → Connections & data → Local server**, or use the supplied Docker Compose and Caddy deployment. Do not expose the private local workspace on port 3210 to the internet.

- [Groups, mobile access and deployment](docs/collaboration.md)
- [Servers and accounts](docs/account-center.md)

## Files, browser pages and subtitles

The **+** menu below the input attaches files, folders, browser tabs and video subtitles. It also contains **Work in a project**, the Codex **Goal**, **Plan mode** and a **Draw** canvas. Files are stored as local copies, up to 8 MB each and 16 items or 24 MB per message. A folder is attached as a path and is not copied. The folder browser shows folders on the computer running the service.

The optional [Edge extension](extensions/edge) pairs with StarPort and lets you explicitly attach a browser tab or read Bilibili subtitles using that browser's current login. Browser credentials remain in Edge. The tool reads only the requested pages or videos; it does not read browsing history, password fields or unrelated form input. Missing subtitles or failed authentication produce an explanation, not a fabricated transcript. See the [browser subtitle guide](docs/browser-video-subtitles.md).

Local file links in replies can be opened with the default application. On Windows, the context menu offers **Open file**, **Show in File Explorer** with the file selected, and the system **Open with** chooser. Ambiguous relative filenames require a choice. Rendering a message never runs a file action, and executable or unknown file types open the application chooser.

## LaTeX editor *(testing)*

The TeX button in the top bar opens a LaTeX editor beside the conversation: source on one side, the PDF built with your computer's TeX on the other. Dock it left or right of the conversation (drag its edge to resize) or open it in its own window; each conversation remembers its place.

- The first time, pick the main file: a `.tex` file in the working folder with `\documentclass`. The file menu switches to the project's other files or to another main file.
- Edits are saved to disk about a second after you stop typing, and each save builds the PDF (turn off **Auto** to build with Ctrl S instead). The engine follows `% !TEX program = …`, uses XeLaTeX for ctex, fontspec and similar packages, and pdfLaTeX otherwise. Build output goes to the working folder's `.starport/latex/`.
- Errors and warnings are listed below and marked in the source; each opens its file and line. Double-click the PDF to jump to the source; **Find in PDF** (Ctrl Alt →) marks the caret's position in the PDF.
- **Visual mode** (the **Visual** switch, on by default) changes only how the source looks; the file stays standard `.tex`. Formulas are drawn in place with KaTeX using your preamble's macros and common `physics` commands, numbered as the last build numbered them, with or without a `\label`; TikZ and Feynman pictures are compiled alone by your TeX with your real preamble; headings and bold or italic text show their look; `\ref`, `\eqref` and `\cite` show the last build's numbers; `\includegraphics` shows the image. Wherever the caret goes the source comes back, with a live preview under a formula or picture being edited. A formula KaTeX cannot draw stays source, and a picture that depends on a macro in the body is cut from the built PDF.
- Select source in the editor and a dashed quote card appears above the composer, leaving again when nothing is selected. To quote several places, press Ctrl L or the pin on the card to keep it, then select elsewhere; kept cards stay until sent or removed, also across a page reload. The next message carries them in front of what you write. While the editor is open, the conversation's model hears each turn which main file and section you are in and how the last build went. When a model or another editor changes a file on disk, the editor merges it in, lights the changed lines and builds again; if you have unsaved edits too, you choose which version to keep.
- Builds run with your user account outside the agent sandbox. StarPort skips the project's latexmk configuration and uses restricted shell escape. File-read restrictions depend on the TeX distribution and do not reliably confine TeX to the project, so compile only sources you trust. LuaLaTeX requires per-project permission, which can be withdrawn in the file tree. Pictures are included directly in the PDF instead of using the TikZ externalization workflow.
- Needs TeX Live, MiKTeX or MacTeX. If `latexmk` is not found, set `STARPORT_TEX_BIN` to its bin folder. Source files must be UTF-8.

## Import, export and move to another computer

Use **Import conversations** to select local Codex, Claude Code, Antigravity or DeepSeek history, preview it and choose a destination room. Codex import is in regular use; Claude Code, Antigravity and DeepSeek import are in testing. Imports are independent copies, not live synchronization; they do not inherit native permissions or automatically run tasks. Tool calls come along as a record and are never run again; hidden reasoning is not copied. Claude imports read local CLI history, not Claude web history. Antigravity imports read `~/.gemini/antigravity-cli` and DeepSeek imports read `~/.dsh/sessions` (or `DSH_HOME`), both read-only. Conversations that StarPort still holds are not listed, and neither are subagent tasks or the DeepSeek sessions that StarPort opens for each turn.

For one conversation, choose **Export conversation** from its menu:

- **Export conversation file** (`.starport.json`) *(testing)* carries that conversation's messages, available execution records and supported uploaded attachments. Import it on another computer and choose a local working folder.
- **Export Markdown** produces a readable transcript.

A conversation file does not contain other conversations, shared memory, account logins, native session bindings, permissions or queued jobs. Files generated in the working folder need to be moved separately. Reimporting identical content opens the existing copy rather than overwriting another conversation. Current limits are 120 MB per conversation file and 8 MB per uploaded attachment.

**Settings → Connections & data → Export all records** creates a complete logical backup of your StarPort records, and **Import backup** *(testing)* restores it on another computer as new copies (up to 128 MB). Imported memory requires review and confirmation. Working folders, folder references and browser connections need to be set up again on the destination computer. Backups must not be committed to Git.

Deleting a conversation removes its StarPort records and its own `.starport/history/` archive. Attachments, generated files, working folders, native tool history, exports and backups remain. Check and remove related material separately. Ordinary deletion does not compact the database automatically or promise irreversible erasure.

## Local storage and maintenance

The local workspace uses relational SQLite tables in WAL mode. The main database is `.data/hub.sqlite`; a single database file is normal SQLite storage. The WAL and SHM files are part of the live database, not disposable leftovers. See [database architecture](docs/database-architecture.md).

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

The test runner uses an isolated temporary folder and cleans it afterwards. A single test has a two-minute limit; a test file that does not exit within five minutes is reported and stopped. Run selected files with `npm test -- tests/i18n.test.mjs`. GitHub Actions runs the suite on Windows, macOS and Linux with Node 24 for pushes to `main` and pull requests.

| Location | Responsibility |
| --- | --- |
| `src/server.mjs` | Local HTTP API and static assets |
| `src/runner.mjs`, `src/adapters/` | Context assembly, task lifecycle and native adapters |
| `src/explain.mjs`, `public/selection-tools.js` | Explain and read-aloud for selected text |
| `src/storage.mjs`, `src/compaction.mjs` | SQLite records and conversation compaction |
| `src/workflows.mjs`, `src/workflows/` | Companions, rooms, workflow scheduling, ledgers and exams |
| `src/external-tools/` | Project tool grants, sandboxed terminal, approved host launches and persistent applications |
| `public/app*.js` | Main workspace, views, settings and interaction |
| `public/agents-room.js`, `public/room-*.js`, `public/workflow*.js` | Rooms, companions and workflow dialogs |
| `public/i18n.js` | English and Chinese interface translations |
| `public/mobile/`, `src/collaboration/` | Group and mobile interface, service and execution bridge |
| `tests/` | Unit, integration and isolated UI fixtures |

The frontend uses ordered plain scripts rather than a framework build. `node tests/ui-fixture.mjs` (port 3211), `node tests/completion-ui-fixture.mjs` (port 3216) and `node tests/interactions-ui-fixture.mjs` (port 3217) start isolated servers with temporary data and simulated tools. `node scripts/live-check.mjs codex antigravity deepseek` makes one real model call per tool and uses your quota. Do not connect tests to personal accounts or production histories.

Optional tool entry points can be installed with `python scripts/install-skills.py`; rerun it after moving the project. In Codex, invoke `$harness-hub`; in other tools, ask them to open StarPort with the harness-hub skill. The entry point opens StarPort's own local interface and does not replace a native tool's UI.

StarPort reuses MAGI's host registration catalog and bundled marked, KaTeX and Archivo resources, preserving their notices. The conversation database, adapters and workspace frontend are implemented here. The complete MAGI repository is not a runtime dependency. To regenerate the catalog, place the pinned [MAGI 2.8.0 source](https://github.com/Misaka16384/magi/tree/e95f14a4a1601008cee9a00aa2b5e78c49842794) in ignored `vendor/magi`, then run `npm run sync-magi`.

## Feedback and bug reports

Found a bug, or want something to work differently? [Open an issue](https://github.com/yutaophysics-crypto/StarPort/issues/new/choose). A bug report is easiest to fix when it says:

- what you did, what you expected and what happened instead;
- your operating system, Node.js version, and the agent tool and version involved;
- when you downloaded StarPort or which commit you run, plus any error text or a screenshot.

Reports about features marked *testing* are especially welcome. Do not paste conversations, memory, credentials, tokens or private file paths; replace them with placeholders.

## Contributing

Fork this repository and open a pull request against `main`. The repository owner reviews and merges contributions. Changes after approval require another review; contributors do not receive direct upstream write access. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

StarPort's own source is licensed under [MIT](LICENSE). Bundled third-party code, fonts and assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Vendor CLIs, SDKs, models and subscription services remain subject to their respective terms.

## Project external development tools

Click **External tools** beside the workspace folder below the message box to grant the current project's Claude Code session read/run access to an installed SDK or engine on Windows, while keeping installation files read-only. See [project tool access](docs/external-tools.md).

**Host compatibility execution and persistent applications** *(testing)*: when a registered program cannot run in the sandbox, Claude can ask to launch it with your Windows user permissions after your approval, and can keep an editor open across turns. See [host compatibility execution](docs/external-tools.md#host-compatibility-execution).

**Project previews** *(testing)*: Claude can serve a built website or Cocos build from the project on a local address that stays up across commands, turns and StarPort restarts, and you can start or stop previews under **External tools → Project previews**. **Per-service networking** *(testing)* keeps Claude clients behind a fixed proxy while Git, downloads and builds in the project terminal use normal networking. See [persistent project previews](docs/external-tools.md#persistent-project-previews) and [service-scoped networking](docs/external-tools.md#service-scoped-networking-on-windows).

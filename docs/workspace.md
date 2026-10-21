# Conversations, files and context

English | [简体中文](zh-CN/workspace.md)

This page covers everyday work in StarPort: folders and projects, the conversation menu, the input's **+** menu, long conversations, local file links, imports and notifications.

## First conversation

Choose a tool, select the working folder below the input, then send a message. The **Tools** tab in the side panel changes with the selected tool. Rooms in the sidebar group conversations; the **⋯** menu at the top right of a conversation can rename it, move it to another room or change its working folder.

## Rooms, folders and projects

Rooms only organize conversations. Each conversation keeps its own working folder, tool and model, so one room can contain conversations from several folders and tools. The **+** next to a room's title starts a new conversation in that room.

The working folder is the project; nothing needs to be marked. Conversations in the same folder share project instructions and project memory. Subfolders are separate projects. If a workflow has its [ledger](rooms-and-workflows.md#ledgers) turned on, the ledger is also stored in the working folder. Existing conversations belong to the project of their current folder.

Select the working folder below the input to browse folders on the computer running the service: drives, the home folder, the parent folder, a name filter, or a pasted full path. **Conversation settings** has the same browser. Only folders are listed, and cancelling leaves the current folder unchanged. Browsing alone does not create a project.

When a conversation changes folder, its own `.starport/history/<conversation id>.md` archive moves with it. Other conversations' archives, the project marker and shared ledgers stay in the old folder. If the archive cannot be moved, the folder is not changed.

**Rename** in the folder picker renames the folder on disk and updates every conversation and project in StarPort that uses it or one of its subfolders. Renaming is refused, with a reason, while a conversation in the folder is running, while another program holds files in it, or when it contains StarPort's own program or data.

## Conversation menu and deletion

Hover over a conversation in the sidebar to show its **⋯** menu; it is also reachable by keyboard focus and on touch screens. The menu moves the conversation to another room, a new room or Ungrouped without switching what you are reading or changing its folder, model or running state.

Deleting a conversation needs confirmation, and a running conversation must be stopped first. Deletion removes the conversation's records, messages, native session bindings and import mappings from the StarPort database, and its own archive under `.starport/history/`. Attachment records and file copies, working folders and generated files, the tool's own history, exports and backups all remain. Check and remove related material yourself; StarPort does not scan for or delete it. Deleting does not purge the database and does not promise irreversible erasure. Deleting the open conversation returns you to a new conversation and clears its draft in the browser.

## Prompts, branching and code

- **Prompts**: the document icon next to the send button lists your saved prompts; select one to insert it at the cursor. The same menu saves the current input as a prompt, and creates, renames, reorders or deletes prompts. Prompts are stored in StarPort's database.
- **Branch from here**: hover below a finished reply and choose **Branch from here**. StarPort creates a new conversation with the records up to that reply, in the same room and with the same tool, model and working folder. The first message in the new conversation gives the copied records to the model as context.
- **Copy**: hover over a code block to show **Copy** at its top right. It copies the original code, with TeX backslashes and `$$` unchanged.

## Formulas

Replies support `$...$`, `$$...$$` and the bracket delimiters found in older messages. Formulas are protected before Markdown is parsed, so equals signs, vertical bars and underscores inside them are not mistaken for headings, tables or emphasis. Code blocks and inline code keep their original text. Long formulas scroll horizontally in their own area. Incomplete or unsupported formulas are shown as written without affecting neighboring text, and stored messages are never changed.

## Long conversations and compaction

When you keep using the same tool, Codex, Claude Code and Antigravity resume their native sessions and manage their own context. A new session has to read the history when you switch tool or model, branch a conversation or change conversation settings, and on every DeepSeek turn. If the history does not fit that tool's budget, a summarizer model compacts the older part into a structured summary that keeps each of your points. The model then receives the summary plus the recent messages verbatim.

The summary belongs to the conversation. Switching models reuses it, and StarPort compacts again only when new content no longer fits. While compaction runs, the conversation and the status bar show **Compacting context…**.

Messages not sent verbatim are written to `.starport/history/<conversation id>.md` in the working folder, so tools with a sandbox can read them too; `.starport/` contains its own `.gitignore`. The model can also search and read the full local history with StarPort's history tools.

**Settings → Context** controls:

- Automatic compaction on or off. When it is off, only the recent messages that fit are sent.
- Each tool's budget for a new session. Defaults: 100k tokens for Codex and Claude Code, 60k tokens for Antigravity and DeepSeek.
- Up to three summarizer models, tried in order.

Each request to Antigravity is also limited to 184,000 bytes. This is StarPort's guard against truncated input, not a model limit.

## The + menu

- **Files and folders**: choose or drag files, paste images, or browse folders. Files are saved as local copies; a folder is attached as a path and does not change the working folder. Up to 8 MB per item, and up to 16 items and 24 MB per message.
- **Attach Microsoft Edge**: load `extensions/edge` once from `edge://extensions`, create a pairing code from StarPort's menu and connect in the extension. You can then pick a tab in StarPort; its text becomes an attachment you can preview, and it is given to the model only when you send. You grant page access in the extension. StarPort does not read browsing history, password fields or form input, and it does not automate the browser. The pairing token is separate from the main StarPort token.
- **Read video subtitles**: available for all four tools. Enter a Bilibili link or BV ID in the menu, or send one in a message, and StarPort reads its subtitles through the connected Edge before sending. Parts such as `?p=2` are supported. Chinese subtitles are preferred, auto-generated subtitles are labeled and timestamps are kept. Login stays in Edge, and signed subtitle URLs are not passed to StarPort or the model. Up to 3 videos per message, 90,000 characters of subtitles per video and 100,000 characters of attachment text in total; content over the limit is not attached in truncated form. If subtitles are missing, a login is needed or the read times out, your draft is kept and StarPort explains why. It never substitutes the description or claims an audio transcription. See the [browser subtitle guide](browser-video-subtitles.md).
- **Work in a project**: lists existing project folders and starts a new conversation in one, or lets you choose a new working folder. You can pick the room separately.
- **Goal**: Codex's native goal mode, with an optional budget. It starts with the next message.
- **Plan mode**: the native plan mode of Codex, Claude Code and Antigravity. It is disabled for DeepSeek, whose SDK has no equivalent.
- **Draw**: a mouse or touch canvas with color, stroke width, eraser, undo and redo. The drawing is attached as a PNG. Codex, Claude Code and DeepSeek receive it as a native image; Antigravity receives the file path.

## Opening local files from replies

`file:///` links, Windows absolute paths, relative paths and plain file names such as `PROJECT_NOTES.md` in a reply can be clicked. Clicking opens the file with its default Windows application. The context menu offers **Open file**, **Show in File Explorer**, which opens the parent folder with the file selected, and **Open with**, the native Windows application chooser. Attachments have the same context menu, and left-click still previews them. Shift+F10, the arrow keys and Esc work in the menu.

Relative paths and bare file names are looked up in the conversation's working folder first. If nothing matches, StarPort searches subfolders for the same path ending; for example, `preview.html` can find `game/preview.html`. A single match from a complete search opens directly, and several matches are listed for you to choose. Absolute paths and paths that point to a parent folder are not searched this way. The search does not follow symbolic links or junctions and never leaves the working folder. It stops after 5 seconds, 50,000 entries or 50 candidates; an incomplete search lets you pick only from what was found or enter a full path. Code blocks, formulas and web links are never turned into file buttons.

Scripts, programs and unrecognized file types open the application chooser, so clicking a code file never runs it. File actions are sent only as authenticated same-origin requests and never run while a message renders. File names are passed as data, not built into shell commands. Only ordinary local files are supported, not network or device paths. Opening a file changes nothing in conversations, attachments, backups or the file itself, and does not change file associations. Windows APIs used: [SHOpenFolderAndSelectItems](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems) and [SHOpenWithDialog](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenwithdialog).

## Importing history

> **Testing:** importing from Claude Code, Antigravity and DeepSeek has not been used in real work yet. Codex import is in regular use.

**Import conversations** reads local Codex, Claude Code, Antigravity or DeepSeek history. Search, preview and select conversations, then add them to an existing or new room. Codex can include archived threads; the other sources can be searched by title or original folder. Claude history is read from local `.claude/projects` (or `CLAUDE_CONFIG_DIR`) through the official Agent SDK, following each record's message chain, with no model call and no working account needed. Claude web history is not read.

Antigravity history is read from the conversation index and transcripts under `~/.gemini/antigravity-cli`, and DeepSeek history from `~/.dsh/sessions` (or `DSH_HOME`), both read-only. Conversations that StarPort still holds and subagent tasks are not listed, and neither are the DeepSeek sessions StarPort opens for each of its own turns. An Antigravity conversation that StarPort started but no longer holds is marked **From Starport**; importing it removes the instructions StarPort added and turns the history it passed along back into messages.

Imports keep both sides' text, titles, working folders and available times, plus a record of tool calls that is never run again. Images, audio and files are kept as references; hidden reasoning and subagents' internal messages are not copied. An import is an independent copy that does not continue the original thread or inherit its permissions or goals. Imported Claude conversations start in plan mode and Codex conversations in **Ask for approval**. If the original folder no longer exists, choose a working folder again in StarPort.

Each source is deduplicated, and import mappings are kept in StarPort backups. A conversation is saved only after it has been read completely, so a failure never leaves half a record. Codex imports need a version that supports `thread/turns/list`. Limits: 64 MB of text per conversation, 2 million characters per message and 128 MB per Claude, Antigravity or DeepSeek source file. Larger content reports an error rather than being truncated.

## Moving a conversation to another computer

> **Testing:** built and covered by automated tests, but not yet used between two real computers.

Choose **↗** at the top right of a conversation, or **⋯ → Export conversation** in the sidebar, then **Export conversation file** (`.starport.json`, restorable on another computer) or **Export Markdown** (for reading). A conversation file contains only that conversation: messages, times, saved activity, uploaded images and files, and web attachment text. Exporting a running conversation saves a snapshot, with unfinished output marked as interrupted.

On the other computer, choose **Import conversations → Starport conversation file**, preview the file, then choose a room and a local working folder. The import creates an independent copy that uses that computer's tool logins; the history is supplied to a new native session, and no task runs automatically. Uploaded attachments move with the file, while generated files in the working folder must be moved separately and folder attachments need to be added again. Limits: 120 MB per conversation file and 8 MB per uploaded attachment. Shared memory moves through [memory sync](memory-sync.md) or a full backup.

## Notifications

When a task finishes or fails, a notification shows the room, the conversation title and one or two lines of the result. Clicking it opens the conversation. On Windows it is a native popup at the bottom right that closes after 10 seconds, with a short chime, and the taskbar button flashes while StarPort is in the background. Other systems use browser notifications.

There is no notification for the conversation you are viewing, a task you stopped, or a task that still has queued messages to run. The bell in the top bar turns **Do not disturb** on or off. **Settings → Notifications** can turn off the sound or send a test notification.

## Layout and Home

On desktop, drag the border between panels to resize them and double-click it to reset. With the border focused, the left and right arrow keys resize it, and Home or 0 resets it. Widths are saved in the browser and limited automatically on narrow windows so the conversation keeps enough space.

**Home**, below **New chat** in the sidebar, opens the theme's welcome view; the theme can be switched at its top right. **Back to conversation**, or Esc, returns to your work with the draft, cursor position and attachments intact, and running tasks continue. On a phone, open the menu at the top left first.

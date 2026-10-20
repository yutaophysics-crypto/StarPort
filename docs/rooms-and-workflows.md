# Rooms, companions and workflows

English | [简体中文](zh-CN/rooms-and-workflows.md)

Rooms group conversations in the sidebar. A room can also hold companions, agents you name and configure once and then call into any conversation in that room. Workflows turn a repeated piece of work into a template that companions run together, manually or on a schedule. Companions, rooms and workflows are saved by the StarPort service, so refreshing or closing the page does not affect them.

## Rooms

Create a room with **New room** in the sidebar. The room menu can start a new conversation in the room, manage the room's companions, open the workflow library, or delete the room. When you delete a room you choose what happens to its conversations: move them to Ungrouped, export them to a folder and then delete them, or delete them all.

The **Room** tab in the side panel lists the current room's companions and the workflows mounted on the open conversation. The **Tools** tab keeps the tool, model and option controls.

## Companions

A companion has a name, avatar, role and personality, plus a tool, model, reasoning effort and an unattended working mode. The working mode is the tool's native permission mode, such as Claude Code's **Auto review**. Personality changes only the tone a companion uses when talking to you; it does not change its analysis or conclusions.

Companions can join and leave any room. Their personality and model travel with them; what they do in a workflow depends on the workflow seat they fill. Companions work unattended: actions that still need approval are declined automatically, and questions they raise are skipped. Choose a working mode that allows what the companion needs to do.

Each companion has its own desk session in each conversation. A desk remembers earlier work in that conversation; in another conversation the companion starts from scratch. Open a companion's card to see what it has done in the current conversation.

## Mentions

Type `@` followed by a companion's name to give it a task. With one mention, the message goes straight to that companion and its reply appears as a card in the conversation. Mentions cannot carry attachments yet.

When one message mentions several companions, a planner model first writes the order of work. Steps can depend on each other, for example one companion does the work and another reviews it. **Settings → Workflows** sets three planner models: if the first is unavailable StarPort tries the second, then the third; if none responds, companions run in the order they appear in your message. By default the planners are GPT-6 Luna in Codex, Claude Sonnet 5.5 (low) in Antigravity and DeepSeek Flash in DeepSeek Harness. Change them to models you have access to.

The same settings decide how many times a mention is redone when a review fails (0–3) and whether each step has a time limit. Steps have no total time limit by default. After 5 minutes without new activity StarPort shows a reminder, and the task keeps running. When you enable the step time limit (3–240 minutes, 30 by default), StarPort warns as the limit approaches, then stops the step and keeps its progress and records. Changes affect only steps that start afterwards.

## One-way mentions

When a message mentions companions, a **One-way** switch appears in the input. StarPort remembers it per conversation. With it on, the companion receives only this message, plus the results of companions earlier in the same mention. It does not see the conversation title or earlier messages, and it works in a separate one-way desk that does not carry the memory of its normal desk.

The reply still comes back as a card. The conversation model can see it and can read the one-way desk's full record with the history tools, and later normal mentions include these one-way replies. The companion shares the conversation's working folder, so "do not read conversation archives under `.starport/history`" is an instruction, not technical isolation. Long-term memory still follows the room's memory switches.

## Workflows

A workflow is a reusable template made of stages and seats. Seats in the same stage run in parallel, and each stage sees the results of the stage before it. A seat can be marked as a review seat: it checks the earlier results against the workflow's acceptance criteria and ends with a pass or a fail. When a review fails, the workflow redoes the stage before the review seat with the reviewer's notes, up to the retry count you set (0–3).

Manage workflows in the **Workflow library**. You can also save the order of a mention as a new workflow. A workflow can be mounted on any conversation in any room. When you mount it, you choose a companion for each seat; companions from outside the room join it automatically. While a seat is empty, the workflow is paused.

## Triggers and schedules

Each mounted workflow has a trigger:

- **Manual**: runs only when you start it.
- **Daily**: runs at a set time, optionally only on chosen weekdays.
- **Interval**: runs every set number of minutes or hours.

Schedules run inside the StarPort service. Closing the browser does not stop them, but nothing runs while the service is off. For each mount you choose whether a run missed while the service was off catches up once after it starts again, or is skipped. Scheduled runs can be paused and resumed.

## Run cards

Every run adds a card to the conversation. Finished runs are collapsed; failed runs and failed reviews stay expanded. From a card you can stop the run, see each step's activity, or choose **Reply** so that your next message carries the run's results.

Each run starts every seat in a fresh desk session that does not read the conversation's history. Use a ledger or **Reply** to carry information between runs.

## Ledgers

A ledger is an optional notebook a workflow keeps across runs. It is off by default and is turned on per workflow. Following Anthropic's practice for long-running agent work, it is split into a PLAN, claims, an append-only CHANGELOG and checks, and it is committed to Git after each run.

Companions can only propose changes to the PLAN; a change takes effect after you confirm it. Claims can carry dated predictions, which are scored with the Brier score when they resolve. A workflow can provide a PLAN template.

Ledgers are stored in `.starport/ledgers/` inside the working folder. Conversations in the same folder that mount the same workflow share one ledger. When a conversation moves to another folder, the old ledger stays where it was and the conversation uses the destination folder's ledger, which is created on the next run if needed. Private ledgers in older versions' data folders are not moved automatically.

## Exams

An exam lets companions solve the same task independently, without the conversation's context, so you can compare their answers.

1. The conversation model proposes an exam with `starport_exam_propose`: a paper folder, instructions, up to eight seats (one companion can take several), optional reference material and a time limit for each seat. A paper can hold up to 10,000 files and 2 GB. An **Awaiting start** card appears. Nothing has been copied yet.
2. Review the card. You can add or remove seats, set each seat to **Open book** or **Closed book**, and change the time limits. Choose **Start exam** to begin, or cancel the proposal. The exam never starts on its own.
3. StarPort copies the paper into a new folder under `StarPortExams` on your desktop, one copy per seat, without `.git`. Open-book seats also get the reference material in a `知识库/` folder.
4. All seats work at the same time. Each examinee starts a new session with only the exam rules and the instructions. It cannot see the conversation, long-term memory, your StarPort preferences or the other seats. Each tool's own global instructions, such as `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`, still load.
5. After a seat hands in, StarPort checks it: whether paper files were changed or deleted, which files were added, and whether any tool call touched the original workspace, the original paper or reference material, StarPort's data folder or another seat.

The answers and check results come back as an exam card. The conversation model can see them and can read each seat's full record with the history tools. A seat is not a sandbox: crossing a boundary can only be found afterwards, not prevented.

## Memory in rooms

Open **Manage companions** from the room menu. In each room, every companion has two switches:

- **Read long-term memory** (on by default): the companion receives relevant confirmed memory, like the conversation model does.
- **Propose memory candidates** (off by default): the companion may suggest new memory. Its candidates can only quote your own words and still need your confirmation before they are saved.

See [Shared memory](shared-memory.md) for how memory is selected and confirmed.

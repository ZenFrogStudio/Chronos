# Chronos

Schedule Claude Code tasks from Markdown plan files, inside VS Code.

Right-click a `.md` file and choose **Schedule with Chronos**, pick a time, and
Chronos runs `claude` against it — once, daily, or on chosen weekdays — saving a
transcript of every run.

## The manager

Chronos is a single editor tab: your plan library on the left, detail on the
right — schedule, working directory, permissions, the plan text itself, and run
history. Clicking the dragon icon in the activity bar opens it, alongside the
Tasks view. You can also open it from the status bar item, the **Open Manager**
button in the Tasks view, or `Chronos: Open Manager`.

Add a plan four ways:

- **New plan** creates one in your library.
- **Right-click any `.md` file** — in the VS Code explorer or on an editor tab —
  and choose **Schedule with Chronos**. Multi-select works.
- **Drag `.md` files onto the manager tab**, from either the VS Code explorer
  (hold **Shift**) or Windows Explorer.
- **Import** picks files with a file dialog.

Every one of them **copies the file into your library and schedules the copy**.
Your original stays exactly where it is, and Chronos never edits or moves it —
which also means editing your original afterwards will not change what runs. The
notice after adding says so.

A plan dropped from a project keeps that project as its working directory, even
though the plan file itself now lives in the library.

## Tasks — capturing work before it is a plan

The dragon icon in the activity bar opens **Tasks** — and the manager tab behind
it, without taking focus off the sidebar. Tasks is a one-line inbox for things
you have not written a plan for yet. It exists because a plan is a considered
document and a thought is not, and because the sidebar is always there — no tab
switch between having the idea and writing it down.

Type the task in the field at the top and press Enter, or click **Add**. That is
the whole capture step. Hover a row for the three things you can do to it:
generate a plan, edit the text in place, or delete it.

A row's colour says what is happening to it — plain with a hollow dot while it
is only captured, amber and pulsing while a planning session is open for it,
green while a run started from here is in flight.

Press **Generate plan** (the lightbulb on a task row) and Chronos opens a
terminal running `claude`, already working from your task. Claude can ask you
anything it needs before committing to an approach — that is why the session is
interactive rather than headless. Approve the plan and it is written into your
library as a real plan file, the task disappears, and the manager opens with the
new plan selected and ready to schedule:

```
capture → generate → schedule → run
```

Back out at any point — Escape, closing the terminal, never approving — and
nothing is created; the task stays exactly where it was.

You do not have to be at that terminal. By default the session's questions come
out through Chronos's MCP server, so you can answer them from Claude Desktop or
from your phone; see
[Answering a planning session from somewhere else](#answering-a-planning-session-from-somewhere-else).

Every generated plan ends with a closing step: bump the project version, add a
matching changelog entry, and commit the result to git. That is what stops an
unattended overnight run finishing with new behaviour, an untracked working tree
and no record of what changed. Two more steps are there and switched off —
running the test suite and rebuilding the project. Each of the five is its own
setting under `chronos.planStep.*`, on the same **Settings** page, and turning
one off changes only the plans generated afterwards; plans already in your
library are untouched.

Planning uses whichever model `chronos.planModel` names — set it on the manager's
**Settings** page, behind the gear beside the plan library. It does not affect
scheduled runs, which use each plan's own model setting.

A task is a `.md` file in `.chronos/tasks`, so it is just a file like everything
else here: it can grow past one line, you can edit it in a real editor, and it
survives anything that resets Chronos's state.

## Everything is per folder

Chronos keeps one set of tasks, plans, schedules and run history **per folder**,
in a `.chronos` directory inside it:

```
your-project/
  .chronos/
    plans/          your plan .md files
    tasks/          the task inbox
    archive/        plans and tasks that have left the library
    results/        run transcripts
    logs/           raw event streams
    state.json      schedules and run history
    scheduler.lock
```

Open a project and you see that project's work and nothing else. The folder is
ignored from git on creation (`.chronos/.gitignore` contains `*`) — edit that
file if you would rather commit your plans.

Because the schedule lives in the folder, **a folder's tasks only run while a VS
Code window is open on it**. Two windows on two different projects now both
schedule, where before only one window scheduled anything at all.

If your workspace has more than one folder, a dropdown above the plan list
chooses which one Chronos is showing. **Chronos: Select Folder** does the same
from the command palette. Switching is refused while a run is in flight.

The first folder you open after upgrading adopts whatever was in the old
machine-wide storage — plans, tasks, transcripts, schedules and history. The
originals are copied, not moved, so nothing is lost if you would rather
redistribute them by hand.

## The plan library

A plan is a `.md` file in one folder — `.chronos/plans`, or wherever
`chronos.libraryPath` points. There is no index or database: the directory *is*
the list, so editing a plan outside Chronos can never desynchronise anything.

Every scheduled plan lives here; there is only one kind of plan. Delete a plan
file from the folder and its schedule goes with it, whether Chronos is open at
the time or not.

**A plan that has run moves to `.chronos/archive/plans`.** A one-shot has no
future once it has completed, so its file leaves the library and its row leaves
the list — the run card and its transcript stay under **Runs**. Only a
*successful* run archives: a plan that failed or was cancelled stays in the
library, visible, so you can fix it and run it again. Recurring plans never
leave. Bringing one back is the **Import** button, and nothing in the archive is
ever pruned.

Change a plan's **Repeat** from Daily or Weekly back to Once and it stays in the
library until it has run once on its own. The runs behind it were made while it
was still repeating, and counting those would archive it the moment you switched
it — before the single run you had just set up ever fired.

Note that pressing **Run now** on a one-shot archives it as soon as it completes,
even if its scheduled time has not arrived — the plan is leaving the library, so
that occurrence is consumed with it rather than firing later out of a folder you
are not looking at.

The in-app editor autosaves on blur. It is a plain textarea — for real editing,
**Open in editor** gives you the actual VS Code editor on the same file. If a
plan changes on disk while you have unsaved edits, Chronos says so rather than
picking a winner.

## How it works

Chronos pipes your plan file to the Claude Code CLI in headless mode:

```powershell
claude -p --output-format stream-json --verbose --permission-mode <mode>
```

The plan text travels on **stdin**, not the command line. That means no argument
length limit, no shell escaping, and paths containing spaces stop mattering.

Each run appears as a live terminal tab. The final `type: "result"` event
supplies the exit status, session id and cost.

## Reading what a run did

A scheduled job runs while you are away, so the record it leaves is the whole
point. Every run writes a Markdown transcript:

```
.chronos/results/
  nightly-audit/
    2026-07-26-213045-completed.md
    2026-07-27-213012-failed.md
```

One folder per plan, one file per run, named by local start time and outcome —
so the folder tells you which nights went wrong before you open anything. Each
file records the conditions the run executed under, the agent's narration, every
tool call with its target, and a footer with the outcome, turns, cost and
duration.

The agent's closing message is also kept on the run itself and shown in full in
the manager's **Runs** section. **result** opens the transcript in Markdown
preview; **raw log** still reaches the underlying event stream when something
needs debugging.

Transcripts live in `.chronos/results` inside the folder by default; set
`chronos.resultsPath` to put them anywhere. **Show results folder** in the
manager opens them in your file manager. Unlike raw logs, they are never
deleted automatically.

## Connecting an agent

Chronos speaks the Model Context Protocol, so any MCP-capable coding agent —
Claude Code, Codex, Cursor, Copilot — can drive the authoring half of the pipeline
itself: capture a task, write it up as a plan, and put it on the schedule. The
open VS Code window picks the schedule up and runs it that night, with the
transcript landing in `.chronos/results` exactly as if you had scheduled it by
hand.

The server is a small Node process the agent spawns, scoped to one project
folder. It works with VS Code closed — the writes land on disk and fire when a
window next opens. **There is still no port and no token**: the server speaks
over stdio to the process that started it, so nothing about registering it opens
anything to the network, and nothing leaves the machine.

### Registering it

Run **Chronos: Copy MCP Server Config...** from the command palette, pick your
client from the list, and paste what lands on the clipboard into the file it
names. Each client wants a different shape, and Chronos writes the one yours
wants rather than a snippet you have to translate:

| Client | Paste it into |
|---|---|
| Claude Code | `.mcp.json` in the project root |
| Claude Desktop | `claude_desktop_config.json` |
| Codex CLI / ChatGPT desktop | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| Cursor | `.cursor/mcp.json`, or `~/.cursor/mcp.json` for every project |
| VS Code / Copilot | `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| opencode | `opencode.json` in the project root |

Claude Code and Codex also get a one-line CLI equivalent in the message that
follows, if you would rather not edit a file:

```bash
claude mcp add chronos -- node "<launcher>" --folder "<project>"
codex  mcp add chronos -- node "<launcher>" --folder "<project>"
```

Three things are worth knowing about particular clients. VS Code is the only one
that uses `servers` rather than `mcpServers`, and its MCP tools only run in
**Agent** mode. Claude Desktop installed from the Microsoft Store keeps its
config under `%LOCALAPPDATA%\Packages\…\LocalCache\Roaming\Claude` rather than
`%APPDATA%\Claude`. And Codex needs its `tool_timeout_sec` raised, which is
covered below.

**The path you paste does not change when Chronos updates.** VS Code installs an
extension into a folder named after its version, so a config pointing straight at
`dist/mcp-server.js` breaks on every update — silently, because the client goes on
starting a file that is no longer there and simply lists no tools. What Chronos
copies instead is a small launcher in its own storage folder, which is not keyed
by version and is re-pointed at the current install each time the extension
starts. Register it once and it keeps working.

**Long waits, and clients that cut them off.** `ask_user` blocks for up to four
minutes waiting for an answer. Claude Code has no tool timeout and is fine as it
is; Codex defaults to 60 seconds and Gemini to 10 minutes, so the configs Chronos
copies for those two set the timeout explicitly (`tool_timeout_sec = 300` and
`"timeout": 300000`). On any client that still cuts a call off, pass a smaller
`waitSeconds` — the tool hands back a question id, and calling it again with that
id picks the wait back up where it left off.

### The tools

Fifteen tools, seven that read and eight that write:

| | |
|---|---|
| `list_plans` `read_plan` | The plan library |
| `list_tasks` | The capture inbox |
| `list_schedule` `list_runs` `read_transcript` | What is scheduled, and what happened |
| `add_task` `add_plan` | Capture and authoring |
| `schedule_plan` `update_schedule` `unschedule` | The schedule |
| `list_questions` `answer_question` | Planning sessions waiting on you |
| `ask_user` `submit_plan` | Used *by* a planning session — see below |

Each one carries the standard MCP hints, so a client that decides for itself what
to auto-approve can tell reading the schedule from rewriting it. `unschedule` is
the only one marked destructive — it drops a series together with its run
history. The hints are advice to the client and change nothing about what the
server permits; the rule below is the actual boundary.

**An agent cannot set a task's permission mode.** New tasks get the ordinary
`auto` default, and raising one to `bypassPermissions` stays a decision you make
in the manager, looking at a plan you have read — otherwise an agent could grant
itself unattended, recurring, unrestricted tool access on your machine without
you ever seeing it. Asking for it over MCP is refused, with a message saying
where the setting lives.

There is also no "run now" tool. An agent sets a time and the window fires it,
which keeps every run on the one path that has the concurrency cap, the
watchdogs, the retry logic and the transcript machinery.

Plans are addressed by name rather than by path, so a scheduled task can only
ever point at a file inside the library, and everything written goes under the
project's own `.chronos`.

### Answering a planning session from somewhere else

**Generate plan** needs you at the keyboard: it always runs in plan mode, so the
session writes a plan and cannot change anything, and it asks its questions in
that terminal and waits there.

When you know you are about to walk away, run **Chronos: Generate Plan (Answer
Remotely)** from the command palette instead. It asks which task, then opens the
same session with its questions coming out through this MCP server, so you can
answer them from Claude Desktop, or from a phone driving Claude Desktop on the
same machine.

It is a separate command rather than a setting because the two cannot share a
session: plan mode refuses an MCP tool call outright, allowlisted or not, so a
routed session has to run in `default` mode. That is a real trade, and it should
be a choice you make on the way out rather than one a default makes for you.

Register the server for the project in whichever client you want to answer from
(**Chronos: Copy MCP Server Config...** gives you the config). Then run the command
and walk away. Ask the answering agent what Chronos is waiting on:

- `list_questions` shows each open question, what the session is asking about,
  and which task it came from.
- `answer_question` records your answers, and the waiting session picks them up
  within a second or two and carries on.

The questions travel this way; the finished plan does not come back as one. As
soon as the plan is written the session calls `submit_plan`, the plan lands in
your library and the task clears. You read it — and change it, if it needs it —
in the manager, which opens with the new plan already selected, before you
schedule it.

The session gets `ask_user` and `submit_plan` and nothing else. It cannot
schedule anything, which matters because nobody is watching it.

Nothing leaves the machine. A question is a file in `.chronos/questions` and an
answer is the same file written back, so the two ends never need a port, a token
or an account between them. Unanswered questions are swept after a week.

## Read this before scheduling anything unattended

Chronos runs an AI agent **while you are away from the machine**. Three things
follow from that:

1. **Tasks default to `auto`.** Chronos runs plans with nobody at the keyboard,
   so the default leans on the CLI's own judgement about what is safe to do
   unattended rather than waiving permissions outright. The trade-off is that a
   mode which can still stop and ask has no one there to answer it at 3am, so a
   run may end having done only part of the job. **Reviewing the plan before you
   schedule it is the safety step.** `bypassPermissions` (full auto,
   unrestricted tool access — and one bad plan on a recurring schedule repeats
   indefinitely), `acceptEdits` (auto-approve edits, still gate shell commands)
   and `plan` all remain selectable per task.
2. **Runs cost money.** A trivial prompt can cost ~$0.17 once context is loaded.
   A daily series with a broken plan bills every day until you notice. The
   manager footer shows a rolling 7-day total for exactly this reason.
3. **A run can "succeed" while doing less than you asked.** If permission gating
   blocks tools, the run still exits 0. Chronos surfaces this as a
   `⚠ N denied` badge rather than a silent success, and does not retry it —
   retrying would hit the same gate.

## Behaviour worth knowing

**Missed windows.** If your machine was asleep or VS Code was closed when a task
was due, Chronos does **not** run it late. Past the grace window (15 minutes by
default) the occurrence is marked *missed* and waits for your decision: run it
now, reschedule, or skip. A week-long outage collapses into one decision, not
seven notifications.

**Retries.** A failed run is retried after one hour, up to `maxRetries` (3).
Failures that retrying cannot fix — a deleted plan file, a missing working
directory, a cancelled run — are not retried at all.

**Recurrence and DST.** Recurrence is stored as local wall-clock time, so
"daily at 09:00" stays 09:00 across daylight-saving transitions. Concrete UTC
instants are derived from the rule, never accumulated.

**Crash recovery.** A run left `running` because VS Code closed mid-flight is
reconciled to failed on next launch and retried, rather than holding its
concurrency slot forever.

**The schedule is re-read when it changes on disk.** A task scheduled by a
connected agent, or by a second VS Code window on the same folder, appears
without reloading anything and fires on the next 30-second tick.

**Chronos only runs while VS Code is open.** It is an extension, not a daemon.
Tasks due while VS Code is closed are caught up (or marked missed) at next
launch. For true machine-level scheduling you would want Windows Task Scheduler
invoking `claude` directly.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `chronos.claudePath` | `claude` | Path to the CLI |
| `chronos.libraryPath` | *(`.chronos/plans` in the folder)* | Where your plan `.md` files live |
| `chronos.resultsPath` | *(`.chronos/results` in the folder)* | Where run transcripts are written |
| `chronos.maxConcurrent` | `1` | Parallel agents in one repo will collide — raise deliberately |
| `chronos.maxRetries` | `3` | Attempts after a failure |
| `chronos.retryDelayMinutes` | `60` | Delay before retrying |
| `chronos.graceWindowMinutes` | `15` | How late a task may still run |
| `chronos.idleTimeoutMinutes` | `15` | Kill a run producing no output |
| `chronos.maxRuntimeMinutes` | `60` | Hard ceiling on one run |
| `chronos.logRetentionDays` | `30` | Transcript retention |

## Development

```bash
npm install
npm run watch      # esbuild in watch mode
npm run typecheck
npm test           # pure-logic tests, no VS Code host needed
npm run package    # typecheck + bundle + vsce package
```

Press <kbd>F5</kbd> to launch an Extension Development Host.

`outcome.ts` and `recurrence.ts` deliberately avoid importing `vscode` so the
result interpretation and recurrence math can be tested in a plain Node runner.

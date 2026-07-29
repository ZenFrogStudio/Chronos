# Chronus

Schedule Claude Code tasks from Markdown plan files, inside VS Code.

Drop a `.md` file onto the Chronus manager, pick a time, and Chronus runs
`claude` against it — once, daily, or on chosen weekdays — saving a transcript
of every run.

## The manager

Chronus is a single editor tab: your plan library on the left, detail on the
right — schedule, working directory, permissions, the plan text itself, and run
history. Open it from the status bar item, the **Open Manager** button behind the
clock icon in the activity bar, or `Chronus: Open Manager`.

Add a plan two ways: **New plan** creates one in your library, or drop a `.md`
file anywhere onto the manager — or use **Import** — to schedule one you already
have. A dropped file is scheduled where it lies and listed under **External**;
**Import** copies it into the library instead.

## The plan library

A plan is a `.md` file in one folder — `chronus.libraryPath`, defaulting to the
extension's own storage. There is no index or database: the directory *is* the
list, so editing a plan outside Chronus can never desynchronise anything.

Plans you schedule from elsewhere on disk keep working and appear under
**External**. They are edited in place — saved back to their own path, never
copied into the library.

The in-app editor autosaves on blur. It is a plain textarea — for real editing,
**Open in editor** gives you the actual VS Code editor on the same file. If a
plan changes on disk while you have unsaved edits, Chronus says so rather than
picking a winner.

## How it works

Chronus pipes your plan file to the Claude Code CLI in headless mode:

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
results/
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

Transcripts live in `results` beside your plan library by default; set
`chronus.resultsPath` to put them anywhere. **Show results folder** in the
manager opens them in your file manager. Unlike raw logs, they are never
deleted automatically.

## Read this before scheduling anything unattended

Chronus runs an AI agent **while you are away from the machine**. Three things
follow from that:

1. **Tasks default to `bypassPermissions` — full auto.** This is deliberate.
   Chronus exists to run plans with nobody at the keyboard, and every gentler
   mode blocks on a prompt no one is there to answer; the run then exits 0
   having quietly done a fraction of the job. The consequence is that a
   scheduled task has unrestricted tool access, and one bad plan on a recurring
   schedule repeats indefinitely. **Reviewing the plan before you schedule it is
   the safety step.** `acceptEdits` (auto-approve edits, still gate shell
   commands) and `plan` remain selectable per task.
2. **Runs cost money.** A trivial prompt can cost ~$0.17 once context is loaded.
   A daily series with a broken plan bills every day until you notice. The
   manager footer shows a rolling 7-day total for exactly this reason.
3. **A run can "succeed" while doing less than you asked.** If permission gating
   blocks tools, the run still exits 0. Chronus surfaces this as a
   `⚠ N denied` badge rather than a silent success, and does not retry it —
   retrying would hit the same gate.

## Behaviour worth knowing

**Missed windows.** If your machine was asleep or VS Code was closed when a task
was due, Chronus does **not** run it late. Past the grace window (15 minutes by
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

**Chronus only runs while VS Code is open.** It is an extension, not a daemon.
Tasks due while VS Code is closed are caught up (or marked missed) at next
launch. For true machine-level scheduling you would want Windows Task Scheduler
invoking `claude` directly.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `chronus.claudePath` | `claude` | Path to the CLI |
| `chronus.libraryPath` | *(extension storage)* | Where your plan `.md` files live |
| `chronus.resultsPath` | *(`results` beside the library)* | Where run transcripts are written |
| `chronus.maxConcurrent` | `1` | Parallel agents in one repo will collide — raise deliberately |
| `chronus.maxRetries` | `3` | Attempts after a failure |
| `chronus.retryDelayMinutes` | `60` | Delay before retrying |
| `chronus.graceWindowMinutes` | `15` | How late a task may still run |
| `chronus.idleTimeoutMinutes` | `15` | Kill a run producing no output |
| `chronus.maxRuntimeMinutes` | `60` | Hard ceiling on one run |
| `chronus.logRetentionDays` | `30` | Transcript retention |

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

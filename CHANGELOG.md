# Changelog

All notable changes to Chronus are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A visual redesign of the manager, which has been the extension's only UI since
the sidebar was removed. It was a flat stack of identically weighted sections, so
nothing answered *when does this run next?* at a glance and the run history — the
record of what the agent did overnight — sat below a 260px textarea, usually off
screen. Nothing outside `media/` changed: no logic, no message types, no storage.

Also in this release: test coverage for three of the 0.8.0-rc.3 audit fixes that
shipped without any, because they lived in modules that import `vscode` and
cannot load in the plain Node test runner. Closing the gaps meant moving the
logic out; one of the moves also narrowed a guard.

### Fixed

- **The external-plan guard no longer folds case on filesystems that don't.**
  The check deciding whether the manager may write to an absolute path compared
  paths lowercased on every platform. On Linux `Plan.md` and `plan.md` are two
  different files, so the guard was wider than intended there and would have
  permitted a write to a file the caller never named. Case is now folded only on
  Windows. No change to Windows behaviour.

### Changed

- **The detail pane follows the authoring flow: write the plan, decide when it
  runs, read what happened.** Plan text is first, schedule second, runs third.
  Rename, Duplicate and Delete move to the bottom under a **Manage plan** heading
  — they are rare and one is destructive, but they sat directly under the title
  competing with the schedule. `Open in editor` moves inline beside the *Plan
  text* label, where the affordance belongs. The editor's default height drops
  from 260px to 180px so the schedule and runs stay reachable without scrolling;
  it is still resizable.
- **The head is now the hero, and it carries the countdown.** A plan's next run
  used to hide inside the *Schedule* section heading, set in the same font as
  everything else. It is now a large amber countdown beside the title
  (`in 6h 12m · daily 21:30`), with the file path demoted to a quiet third line.
- **One owned colour.** The shell still derives every background, border and
  focus ring from `--vscode-*`, so the manager belongs to whatever theme you run.
  Chronus owns a single amber — sodium — and spends it only on liveness and
  imminence: the countdown, the ring, the queued badge, and a left edge on a plan
  that is running right now. Focus rings stay `--vscode-focusBorder`; splitting
  focus from status is what stops one accent becoming decoration. Light themes
  get a darker sodium, and **high-contrast themes fall back to the focus colour**
  rather than having amber painted over an accessibility theme.
- **Run badges read as a traffic light.** A completed run used to wear a *blue*
  outline borrowed from the focus colour, which is not a verdict. Completed is
  now green, queued is sodium, and failed / missed / auth required / denied stay
  red. Cost, `retry N` and cancellation stay neutral grey — they are facts, not
  verdicts, and colouring them would dilute the three that matter.
- **Two typefaces, one rule.** Prose — titles, buttons, notices — is set in the
  UI font; every measurement — time, duration, cost, badge, path, section label —
  is set in the editor font with `tabular-nums`, so costs and durations align
  into a column down the runs list. No web font is bundled: a display face would
  fight every theme and inflate the `.vsix` for nothing.
- **A time axis, in two expressions.** A countdown ring in the head fills as the
  current interval elapses toward the next run — a weekly plan uses its own
  interval, and a one-shot shows an outline with no arc rather than inventing a
  progress figure. The runs list gains a vertical rail with one dot per run,
  replacing the flat bordered rows; the dot carries the same three-state colour
  as the badges. Circles are occurrences, the rail is elapsed time, and nothing
  else in the UI uses the motif.
- The elapsed-run ticker generalises to drive the countdown text and the ring's
  arc as well. The arc is written with `setAttribute('stroke-dashoffset', …)` —
  an SVG presentation attribute — because the webview's CSP allows no inline
  styles. Reduced motion disables the ring sweep and the running dot's halo while
  leaving the arc rendered.
- The drop overlay reads *Drop a .md file to schedule it*; the common case is one
  file and the active voice matches the rest of the UI.

- `samePath` and the scheduled-plan check moved from `manager.ts` to
  `library.ts`, which already owns the library's traversal guard and has no
  `vscode` import. A duplicated copy of `samePath` went with the move.
- `finaliseInterrupted` moved from `runner.ts` to `transcript.ts`, taking its
  filesystem and logging as injected operations in the manner of
  `preflightError`. `runner.ts` keeps a one-line wrapper supplying the real
  `fs`; `Scheduler.reconcile` is unchanged. The cases worth testing here are the
  ones where the disk refuses — a rename or an append that throws must return the
  original path and must not take the scheduler down at startup — and those are
  awkward to force against a real directory.
- New `test/source-guards.test.ts` fails the build if `Math.random(` reappears
  anywhere in `src/`. The CSP nonce's only worthwhile property is that it cannot
  be guessed, which no assertion on a returned string can demonstrate; a test
  that two nonces differ would pass for a counter. Reading the source is the
  check that would actually have caught the original defect.
- `docs/TEST-PLAN.md` gains step 7.8, confirming by eye that the nonce reaches
  the document and changes between opens — the half of the fix no test reaches.
- The manual test plan's numbered sections are **steps** rather than *gates*,
  and each one's table column is **Check** rather than *Step* — the old naming
  had a "Step 1" containing fourteen "steps". Sprint exit criteria in the
  planning documents keep the word *Gate*, as do the concurrency and permission
  gates in the source; those are different things.

### Removed

- `.badge.is-repeat` — dead CSS, nothing ever emitted the class.
- Status dots on library list items, which were redundant: each item already
  prints its next run in text.

## [0.8.0-rc.3] - 2026-08-02

A full audit of the codebase, and the ten defects it found. Two of them could
lose or duplicate real work; the rest are hardening. No feature changes.

### Fixed

- **A task queued behind a busy slot is no longer marked missed.** With
  `maxConcurrent` at 1 — the default — any run lasting longer than the 15-minute
  grace window caused whatever was queued behind it to age out and be reported as
  *missed while VS Code was closed*, with the editor open in front of you. The
  task then never ran. The scheduler now records the runs it deferred for
  capacity and exempts them from the grace window, so a queued run waits rather
  than expiring. Deferrals are held in memory, not the store: after a restart or
  a suspend nothing was holding the run back, and the grace window should judge
  it normally again.
- **Two VS Code windows no longer run every scheduled task twice.** Each window
  activates its own extension host, and `globalState` gives neither any sight of
  the other's writes — so both saw the same task as due and both spawned an
  agent for it, in the same repository, at the same moment. `maxConcurrent` could
  not help; it counts one window's runs. A lock file beside the state now decides
  which window schedules. The others show the UI, say so in a banner, and stay
  out of the way. Closing the holder hands scheduling over within about a minute.
  This also stops a second window reconciling — and failing — a run the first
  window is still executing.
- **One unusable repeat rule no longer stops every other task.** A recurrence
  with no days, or a time that is not a wall clock, threw inside the scheduler's
  tick, which caught it and moved on — silently halting the entire schedule every
  30 seconds with nothing but a log line. A broken rule is now caught per series:
  that one task is paused and reported, and everything else keeps running.
- **Transcripts left behind by a crash are closed out on the next launch.**
  Killing VS Code mid-run left the file without its footer and without its
  `-failed` suffix, so the results folder stopped answering "which nights went
  wrong" for exactly the runs that went most wrong. Reconciling an orphaned run
  now appends the footer and applies the suffix.

### Security

- **The manager's schedule edits are validated rather than trusted.**
  `updateSeries` accepted any `Partial<TaskSeries>` — a type erased at runtime —
  and wrote it straight to the store. Two of those fields leave the process:
  `model` becomes an argv entry for a shell-invoked spawn on Windows, where Node
  does not quote arguments, and `filePath` decides which file the agent is handed
  as its prompt. A new `edit.ts` checks every field against the same
  allowlist-and-reject pattern `command.ts` already uses for the phone; identity
  fields are not editable at all.
- **Editing an external plan is confined to plans that are actually scheduled.**
  `savePlan` would write arbitrary text to any absolute path the webview named.
  The design note that justified bypassing the library guard rested on those
  paths already being trusted because the runner executes them — true only of
  paths in the schedule, which is now what the code checks.
- **The webview CSP nonce comes from `crypto`,** not `Math.random()`.

### Changed

- Missed runs are capped at 100, so a catch-up decision that is never answered
  cannot grow the store without bound. Finished runs keep their own cap of 50.
  Pending and running runs are still never pruned.
- `chronus.logRetentionDays` said it deleted transcripts; it deletes raw logs,
  and the transcripts are kept indefinitely. The description now says so, and no
  longer contradicts `chronus.resultsPath`.

### Internal

- New `vscode`-free modules on the test allowlist: `lock.ts` (which window
  schedules), `edit.ts` (what the manager may change), `history.ts` (what is
  pruned). Run-history pruning moved out of `store.ts` so the one place Chronus
  deletes user data is covered by tests.
- 257 tests across 59 suites, up from 201 across 45.

## [0.8.0-rc.2] - 2026-07-28

### Added

- **Pick a specific model per schedule.** The Model dropdown now offers pinned
  versions — Opus 5, Opus 4.8, Sonnet 5, Haiku 4.5, Fable 5 — alongside the
  account default and the bare family aliases (Opus/Sonnet/Haiku "latest", which
  track the newest of a family). The selected value is passed to the CLI's
  `--model` verbatim, so a run is reproducible against a named model rather than
  whatever the default happens to be that week.

## [0.8.0-rc.1] - 2026-07-27

Chronus had two renderers over one store — a sidebar and a manager — and neither
was complete, so every feature since 0.6.0 was built twice or landed in only one.
This release removes the sidebar and leaves the manager as the single UI, after
first porting everything the sidebar could do that the manager could not.

### Added

- **Drop zone in the manager.** Drag `.md` files anywhere onto the manager to
  schedule them; a whole-pane overlay marks the target. `readDrop` was ported
  verbatim from the sidebar rather than rewritten — it is the only drop code
  exercised against real events. A dropped file is scheduled **in place** and
  listed under **External**; **Import** still copies into the library, the
  deliberately different gesture. Text dragged inside the plan editor is left
  alone.
- **Missed-run actions in the manager.** A missed one-shot offers **run now** /
  **reschedule** (prefilling the run's own time of day on its next occurrence); a
  missed recurring series offers **run now** / **skip**.
- **Setup-problem banner in the manager.** An unreachable `chronus.claudePath`
  now surfaces as a sticky banner here too, replayed when the tab is revealed.
- **External plans are editable.** A plan scheduled from outside the library is
  now edited in place and saved back to its own path — never copied in. Its
  directory is watched, so the two-editor conflict logic works outside the
  library too. New `readPlanAt` / `writePlanAt` operate on absolute paths; the
  name-derived `resolveInLibrary` guard is unchanged and still tested.
- **Activity-bar launcher.** The branded clock icon stays, backed by an empty
  view whose `viewsWelcome` content is a button to the manager — a launcher, not
  a second renderer.

### Removed

- **The sidebar webview.** `src/panel.ts` and `media/panel.{html,css,js}` are
  gone, along with the `chronus.dashboard` view, its `view/title` menu and the
  `chronus.open` command. `chronus.addFiles` now targets the manager.

### Changed

- The manager carries the house glass aesthetic the sidebar had: `backdrop-filter`
  panels and hairline borders, plus a first-run empty state explaining what
  Chronus does and the two ways to add a plan.
- Tests: **160, up from 157** — covering the absolute-path plan helpers.
- Docs: README rewritten from "two views" to the single manager; `TEST-PLAN.md`
  folds Step 8b into one manager step and adds drop-zone and missed-action cases.

## [0.7.0-rc.1] - 2026-07-26

Chronus could tell you a scheduled job had finished, what it cost and how long
it took — but not what it did. This release makes the result of a run the thing
you get back from it.

### Added

- **Run transcripts.** Every run now writes a readable Markdown file: a header
  recording the conditions it executed under (time, directory, permission mode,
  model, retry number), the agent's narration and every tool call with its
  target, and a footer stating the outcome, turns, cost and duration.
- **A results folder you can actually browse.** One subfolder per plan, one file
  per run, named `2026-07-26-213045-completed.md`. The filename carries the
  outcome, so the folder answers "which nights failed" before anything is
  opened. Defaults to `results` beside the plan library; set
  `chronus.resultsPath` to move it. **Show results folder** in the manager opens
  it in the file manager.
- **The agent's closing message is kept and shown.** It appears under the run in
  both views — clamped to three lines in the sidebar, in full in the manager —
  with **View result** opening the transcript in Markdown preview. **Raw log**
  still reaches the underlying stream for debugging.
- Permission denials are called out prominently in the transcript footer, since
  a gated run exits successfully having quietly done a fraction of the work.

### Changed

- **New tasks default to `bypassPermissions` instead of `acceptEdits`.** Chronus
  runs plans while nobody is at the keyboard, and every gentler mode blocks on a
  prompt no one is there to answer — the run then exits 0 having done part of
  the job. Reviewing a plan before scheduling it is the safety step; a
  permission dialog at 3am is not. Existing tasks are untouched.
- NDJSON rendering moved out of `runner.ts` into `transcript.ts`, which parses
  each event once and formats it twice — ANSI for the live terminal, Markdown
  for the file. It was previously untestable behind the `vscode` import.
- Transcript path arithmetic lives in `results.ts`, reusing the plan library's
  existing slug and containment rules rather than a second implementation.
- Tests: **157, up from 124.**

### Fixed

- **A run no longer holds its entire output in memory.** `runner.ts` accumulated
  every byte of stdout for the life of the run purely to read the final result
  line back out at the end, while the same bytes were already streaming to disk.
  Only the last result line is retained now.

### Notes

- Raw logs are still pruned on `chronus.logRetentionDays`. Transcripts are
  **not** deleted automatically — they are written to be kept and read, and
  silently deleting a record of unattended work is the wrong default.
- `bypassPermissions` is paired with `--allow-dangerously-skip-permissions`,
  which the CLI documents as making the bypass *available* rather than active.
  That pairing is still unverified end to end — `docs/TEST-PLAN.md` Step 2.

## [0.6.0-rc.4] - 2026-07-26

### Fixed

- **A run's terminal was effectively invisible.** The tab was created without
  being revealed, and on completion the runner fired the pseudoterminal's
  `onDidClose`, which makes VS Code dispose the tab. A run lasting seconds
  therefore appeared in a tab list nobody was looking at and then deleted
  itself. The terminal is now revealed on start (focus is left alone) and stays
  open after the run, ending with a "Run finished" line.

### Added

- `chronus.showTerminalOnRun` (default `true`) to turn the reveal off.

### Notes

- Chronus has never used an existing terminal, and still does not. Runs are
  spawned as their own process and mirrored into a dedicated
  `Chronus: <plan>` pseudoterminal — `terminal.sendText()` carries no exit
  code, which would make the retry logic unimplementable.

## [0.6.0-rc.3] - 2026-07-26

### Added

- Branding from `favicon.ico`. The extension tile and the manager's editor tab
  now use the full-colour clock-and-arrows mark (`media/icon.png`, 128×128).
- The activity bar icon was redrawn to echo it — clock plus recurrence ring —
  as a monochrome SVG.

### Notes

- `favicon.ico` cannot be used directly. VS Code needs SVG for the activity bar
  and PNG ≥128×128 for the extension tile, and the source is a 48×48 BMP that is
  **fully opaque**. The activity bar masks icons into a flat silhouette, so an
  opaque square would render as a solid block — hence a matching SVG instead of
  the bitmap.

## [0.6.0-rc.2] - 2026-07-26

### Fixed

- The **Open Manager** toolbar icon used `$(window)`, which is not a codicon
  present in every VS Code build — an unknown name renders as blank space, so
  the button was there but invisible. Now `$(multiple-windows)`.

## [0.6.0-rc.1] - 2026-07-26

The plan manager. Still a candidate: the manager's own UI has not been driven by
hand, and the 0.5.0 steps in `docs/TEST-PLAN.md` remain outstanding. What *is*
confirmed is that the execution engine works — a real run completed on
2026-07-26 (2 turns, $0.26, no permission denials), which was the one genuinely
unproven layer.

### Added

- **Plan manager** — a full editor-tab webview (`Chronus: Open Manager`), with a
  plan library on the left and detail on the right. The sidebar stays as the
  compact status view; both read the same store, so there is one source of truth
  and two renderers.
- **Plan library** — a folder of `.md` files with create, rename, duplicate,
  delete, import and search. Deliberately no index or manifest: an index is a
  second source of truth that drifts from the filesystem the moment a file is
  edited outside Chronus. Configurable via `chronus.libraryPath`.
- **In-app Markdown editor** with autosave on blur and a 2s debounce, a dirty
  indicator, and **Open in editor** for anything longer than a tweak.
- **Status bar item** — the persistent launch surface. Shows the next run,
  spins while running, warns on missed tasks, and opens the manager on click.
- **First-run starter plan**, written only when the library is first created.
- Renaming a plan repoints any series scheduled against it, rather than
  stranding them on the old path.
- Deleting a scheduled plan asks whether to remove the schedule too.

### Notes

- **No schema change.** `TaskSeries.filePath` stays an absolute path, so plans
  outside the library keep working and appear under *External*. Nothing to
  migrate.
- `window.prompt()` is not implemented in Electron, so plan naming uses VS Code
  input boxes rather than a webview dialog.
- The webview does not set `retainContextWhenHidden`; a panel serializer
  restores the tab across reloads instead of holding it in memory.

## [0.5.0-rc.1] - 2026-07-26

Release candidate, not a release: everything below is typechecked and covered by
tests, but **no part of Chronus has yet been observed running end-to-end**. The
manual gates in `docs/COMPLETION-PLAN.md` Sprints 8 and 12 promote this to
0.5.0.

### Fixed

- **F5 works on a clean machine.** The launch task referenced `$esbuild-watch`,
  a problem matcher that ships in a third-party extension, so a machine without
  it failed with "error exists after running preLaunchTask" before the extension
  host ever started. `esbuild.js` now logs single-line, matcher-readable build
  state and `tasks.json` carries its own inline matcher — no extension needed.
- **Pausing a series now stops its queued retries.** The pending-run loop looked
  up the series but never checked `enabled`, so a retry queued before a pause
  still fired. "Run now" is the deliberate exception, marked by a new `manual`
  flag on `TaskRun`.
- **Bumping the schema no longer destroys stored state.** The store had a
  version *gate* — exact equality, everything else moved to a backup key and
  replaced with empty state — but no migration *path*. Added a real `migrate()`
  ladder that upgrades known versions and refuses only genuinely foreign shapes,
  including state written by a newer Chronus.
- `TaskSeries.enabled` no longer carries two meanings. A fired one-shot is now
  `spent`; `enabled` is the user's pause alone. Conflating them stranded a
  materialised run that had not yet found a concurrency slot — it would have
  been skipped forever.

### Added

- **`Chronus: Open Dashboard` command.** The activity-bar container is titled
  Chronus but the view inside it is named "Scheduled Tasks", so the panel was
  hard to find by name. VS Code's generated `<viewId>.focus` command exists but
  is listed under the view's name; this gives it an obvious entry.
- **Authentication failures are reported, not retried.** An expired token failed
  every task identically and burned three retries across three hours first.
  Detected via `api_error_status` or the result text, and only ever on a run
  that actually failed — a healthy run that merely *mentions* a 401 is not one.
- **`claude` is probed at activation**, asynchronously so it never delays
  startup. A bad `chronus.claudePath` now surfaces as a sticky panel banner
  instead of a failed run at 2am.
- **Live elapsed time on running rows**, computed in the webview from
  `startedAt` rather than pushed per-second from the extension.
- **Cancel button** for a running task. `Runner.cancel()` already existed; the
  only way to reach it was closing the terminal tab.
- **Queued group** showing pending runs with a countdown and `retry N/max`, so a
  waiting retry — or a run stranded by the concurrency gate — is visible.
- Spent one-shots leave the Scheduled group rather than lingering as a card
  offering to pause something that will never fire again.

### Changed

- Scheduler split into a pure decision function (`decide.ts`) and an applier.
  `buildArgs` and pre-flight moved to `launch.ts`; the watchdog rules to
  `watchdogVerdict()`. All are `vscode`-free and on the `tsconfig.test.json`
  allowlist. `scheduler.ts` is 205 lines, down from 280.
- Tests: **93, up from 36** — including the eleven cases owed since the
  recurrence amendment, which were unwritable while the logic imported `vscode`.

### Notes

- The auth-detection patterns are inferred, not observed. Sprint 12 forces one
  real auth failure to correct them.

### Added — developer tooling

- `docs/TEST-PLAN.md` — the ten manual steps that unit tests structurally cannot
  reach: process spawning, drag-and-drop, real editor restarts, theme rendering.
- `.sandbox/` — a throwaway working directory the Extension Development Host
  opens at launch, so smoke runs have somewhere safe to write.
- A second launch config, **Run Chronus (no build)**, for when the task layer
  misbehaves.

### Added — documentation

- `docs/PLAN.md` — the original implementation plan and its two amendments,
  recovered from the design session and kept as a record of intent. Excluded
  from the packaged extension.
- `docs/COMPLETION-PLAN.md` — Sprints 8–12 to reach 0.5.0, written against the
  audited state of 0.4.0.
- `docs/GUI-PLAN.md` — Sprints 13–18 for the editor-tab manager and plan
  library, targeting 0.6.0. Gated on 0.5.0 passing its smoke test first.

## [0.4.0] - 2026-07-26

### Added

- **Sidebar dashboard**: drag-and-drop of `.md` files (handling both
  `application/vnd.code.uri-list` from the VS Code explorer and OS-level drops),
  with an always-available browse fallback. Datetime picker, quick chips,
  recurrence controls, and an Options disclosure for working directory,
  permission mode and model. Groups render only when they have content.
- **Execution engine**: spawns `claude -p --output-format stream-json --verbose`,
  mirroring live progress into a `Pseudoterminal` tab and the run transcript.
  The plan travels on stdin. Concurrency gate, pre-flight file and cwd checks.
- **Watchdogs** for idle and total runtime, compared against wall-clock
  timestamps rather than timers — Windows suspends timers during sleep and fires
  them on resume, which would otherwise kill a task that had just woken.
- **Scheduler**: 30-second tick with drift-based sleep detection, a three-way
  due / within-grace / missed split, and startup reconciliation of runs orphaned
  by a mid-flight shutdown.
- **Recurrence**: daily and weekly rules, with catch-up collapsing an outage into
  a single decision rather than one notification per missed occurrence.
- **Retry**: failed runs requeue after one hour up to `maxRetries`. Failures that
  retrying cannot fix — deleted plan file, missing working directory,
  cancellation — are not retried.
- **Permission denial reporting**: a run can exit 0 with tools blocked. Chronus
  surfaces this as a badge and a warning instead of a silent success, and does
  not retry it.
- Run transcripts with configurable retention, rolling 7-day cost footer, and a
  README covering the unattended-execution risks.
- 36 unit tests over the pure result and recurrence logic, including both DST
  transition directions.

### Notes

- `--allow-dangerously-skip-permissions` is passed automatically when a task
  selects `bypassPermissions`, since that flag makes the capability available
  rather than applying it. This pairing follows the CLI's documented semantics
  and has not been exercised end-to-end.

## [0.2.0] - 2026-07-26

### Added

- Data model separating `TaskSeries` (the definition you create) from `TaskRun`
  (one execution attempt). Keeps per-run history intact when a recurring series
  fires repeatedly.
- `Recurrence` stored as local wall-clock time (`daysOfWeek` + `timeLocal`) so a
  rule like "weekdays at 09:00" holds across DST boundaries. Concrete UTC
  instants are derived from it, never incremented.
- `Store` over `globalState`: write-through CRUD for both collections, an
  `onDidChange` event, and finished-run history capped at 50.
- Unrecognised stored state is preserved under a backup key rather than dropped.
- `chronus.addFiles` now creates a real series, defaulting to one hour out
  rounded to the next quarter hour, with `cwd` resolved to the workspace folder
  containing the plan file.

### Notes

- Schema starts at version 1. Earlier "v2/v3" numbering tracked plan revisions,
  not shipped schemas; the migration hook is in place for real future changes.

### Added

- Project skeleton: TypeScript (strict), esbuild bundling, zero runtime dependencies.
- Extension manifest with a Chronus activity bar container and `chronus.dashboard` webview view.
- Commands: `chronus.addFiles`, `chronus.showLogs`.
- Settings: `claudePath`, `maxConcurrent`, `maxRetries`, `retryDelayMinutes`,
  `graceWindowMinutes`, `idleTimeoutMinutes`, `maxRuntimeMinutes`, `logRetentionDays`.
- Placeholder dashboard panel confirming the extension host loads.

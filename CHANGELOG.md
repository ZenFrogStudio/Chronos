# Changelog

All notable changes to Chronos are documented here. Entries below predate the
rename from Chronus and are left as written.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A visual redesign of the manager, which has been the extension's only UI since
the sidebar was removed. It was a flat stack of identically weighted sections, so
nothing answered *when does this run next?* at a glance and the run history — the
record of what the agent did overnight — sat below a 260px textarea, usually off
screen. That redesign changed nothing outside `media/`: no logic, no message
types, no storage.

Also in this release: test coverage for three of the 0.8.0-rc.3 audit fixes that
shipped without any, because they lived in modules that import `vscode` and
cannot load in the plain Node test runner. Closing the gaps meant moving the
logic out; one of the moves also narrowed a guard.

### Added

- **A task can now run on an engine other than Claude.** The Schedule section
  gains an **Engine** dropdown beside **Model**, and picking `opencode` runs that
  plan through the `opencode` CLI instead — which is one binary that routes to
  Kimi, the GPT family and a local Ollama model through a single interface. That
  is the whole reason it was chosen over adding one integration per vendor:
  Chronos gets "other models" without growing a stream parser per provider.

  Claude remains the default and its path is untouched. A series with no engine
  set *is* a Claude series, which is what every existing schedule already means,
  so there was no migration and no schema bump.

  The dropdown only lists engines this machine answered `--version` on, checked
  once at startup by the same probe that already reported a broken `claudePath`.
  If you have no `opencode` on PATH the field does not appear at all. Claude is
  the exception: it stays listed even when broken, because a missing default is
  a setup problem to fix rather than a choice to withdraw.

  What made this small is that `TranscriptEvent` never named a vendor — it is
  `session | text | tool | result`. Both engines produce that union, so the live
  terminal, the Markdown transcript, the run cards and the status bar are all
  unchanged. Only the parse forks.

  Three things worth knowing:

  - **opencode has one approval control where Claude has six.** Its `--auto` is
    the only lever, so the Permissions dropdown offers just two options when the
    engine is opencode — auto-approve, and plan — rather than four more that
    would quietly mean the same thing. Switching engines does not overwrite a
    stored mode, so switching back restores it.
  - **Credentials stay with opencode.** It keeps its own provider logins and
    Chronos never sees a token, so there is nothing new stored on disk. The
    model list offers opencode's free hosted catalogue; anything else — Kimi,
    GPT, a local Ollama model — needs `opencode providers login` first and is
    then reached through the new **Custom…** box, since neither CLI can
    enumerate what your account can actually run.
  - **The phone still cannot change it.** `agent` joins `permissionMode` and
    `model` as published-but-read-only over the remote channel: which engine
    runs is *what* a task does, and a remote caller may only change *when*.

  New setting `chronos.opencodePath`. `src/models.ts` became `src/agents.ts`,
  which now holds the engine table and both model lists.

- **The activity-bar view is now a task inbox.** It held two rows — *Open
  Manager* and *Schedule a Markdown file…* — both of which the status bar, the
  command palette and the manager already offered, so it read as a second,
  thinner UI beside the one that matters. The intent was to delete it outright.
  That is not possible: VS Code only draws an activity-bar icon for a view
  container, a container must hold at least one view, and there is no "icon runs
  a command" API. Keeping the clock icon means a panel opens either way, so the
  only real question was what goes in it.

  It is now the front of the pipeline the manager does not have — **capture →
  generate → schedule → run**, reading left to right across the two surfaces
  with no overlap. Type a one-line task, press **Generate plan**, and Claude
  works it into a real implementation plan that lands in the library ready to
  schedule. The sidebar owns capture, because it is always visible and costs no
  tab switch; the manager owns everything after it.

  A task is a `.md` file in `<library>/tasks/` — no schema bump and no new
  store, since `library.ts` is already parameterised by directory and
  `listPlans` skips subdirectories, so `tasks/` never appears as a plan. A task
  therefore survives a state reset, and can grow past one line.

  Generation is an *authoring* session, like the manager's own Generate plan
  button and outside the scheduler for the same reason: no `TaskRun`, no
  concurrency slot, no transcript, no leader lock. It is a real terminal running
  `claude` in plan mode, so Claude can ask clarifying questions before you
  approve. The destination file appearing in the library is the completion
  signal — the CLI exits when *you* close it, long after the plan is written —
  at which point the task is cleared and the manager opens with the new plan
  selected. Backing out at any point creates nothing and leaves the task where
  it was.

  The model comes from a QuickPick backed by a new `chronos.planModel` setting,
  which remembers your last choice and renders as a dropdown in Settings. The
  model list moved out of the webview and is sent to it in its state message, so
  the sidebar picker and the manager's Model dropdown can no longer drift apart.

  The drop controller moved to the new view unchanged: dropping a `.md` on the
  panel still schedules it in place. That is why the view contributes no
  `viewsWelcome` — welcome content cannot accept a drop, and the empty body has
  to stay a drop target.

- **A Generate plan button beside *Open in editor*, which turns a rough note in
  the Plan text box into a run-ready plan.** Writing a plan meant either typing
  the finished thing by hand or opening a terminal yourself, changing directory
  to the right repo, remembering the plan-mode flag and pasting the text in.
  Pressing the button saves what you have written, then opens a terminal in the
  plan's working directory running `claude` in plan mode on the plan's chosen
  model, already planning from your text. Approve the plan and Claude writes it
  over the plan file; the library watcher reloads the Plan text box on its own,
  so the result lands back in the manager without you fetching it.

  This is a real interactive terminal — `createTerminal` and `sendText` — not
  the read-only pseudo-terminal a scheduled run streams into, because the point
  is to talk back to Claude. It is an authoring session rather than a run, so it
  deliberately sits outside the scheduler: no concurrency slot, no run record,
  no transcript, no leader lock.

  The plan text is named, not pasted. `sendText` writes a single line into a
  shell; a plan body is multi-line and can be tens of kilobytes, cmd.exe caps a
  command line at 8191 characters, and every shell treats newlines, quotes and
  `$` differently. The prompt therefore names the file and Claude reads it with
  its own Read tool — no length limit, and only a path to quote. `--add-dir` on
  the plan's own folder covers the usual case of a plan living in the library
  while the working directory is the repo. Quoting branches on `vscode.env.shell`,
  since no one form is safe in PowerShell, cmd and bash alike.

- **A Runs panel across the bottom of the manager, listing every run for every
  plan.** Run history only ever lived inside the selected plan's detail pane, so
  answering *what is Chronus doing, and did anything fail?* meant clicking each
  plan in turn. The panel is pinned under whatever plan you have open and splits
  into **Upcoming** — each active series' next occurrence, plus any retry the
  scheduler has queued ahead of time — and **Recent**, everything that has
  already happened, newest first. Countdowns and elapsed timers tick there as
  they do in the detail pane. The per-plan Runs section is unchanged; the panel
  is the overview, the section is the detail.

  Row actions — cancel, skip, reschedule, result, raw log — work on runs
  belonging to plans you are not looking at, which is the one thing the per-plan
  section could not do. The plan name on each row is a button that selects it.
  A filter narrows to **Upcoming**, **Completed** or **Needs attention** (failed,
  missed, auth required, denials — cancelling is left out, since you did that
  yourself). **Hide** collapses the panel to its header, and both the collapse
  state and the filter survive a reload.

  *Upcoming* deliberately means only occurrences that exist: a series' own
  `nextRunAt` and a queued retry's `scheduledAt`. Expanding a recurrence rule
  across the coming week would be a forecast, and this panel is a record.

  The panel reuses the statusline's space, so the 7-day cost figure moves into
  its header rather than costing another strip. No schema, scheduler or runner
  changes: `TaskSeries` and `TaskRun` are untouched, and `Manager.post()` sends
  one new derived field over the state message it already sent.

- New `src/activity.ts` — `buildActivity(series, runs, now)`, pure and unit
  tested, holding the ordering and the upcoming/recent split. The webview renders
  what it is handed. `recency()` is now exported from `history.ts` and shared, so
  "newest first" has one definition rather than two that can drift; it gained a
  `startedAt` step for runs that have neither finished nor been missed, which
  pruning never sees.

- **Right-click any `.md` file → Schedule with Chronus.** In the explorer or on
  an editor tab; multi-select works. This is now the shortest way in and the one
  that does not depend on drag-and-drop working, which — see below — it largely
  had stopped doing. Hidden from the command palette, since it needs a file to
  act on and `Chronus: Schedule Markdown File…` already covers the palette case.

- **The activity-bar view accepts dropped files.** It was an empty tree dressed
  up with `viewsWelcome` links; it is now two real rows — *Open Manager* and
  *Schedule a Markdown file…* — behind a `TreeDragAndDropController`. Welcome
  content cannot be a drop target, which is why the rows had to become real ones.
  Drops here work from both the VS Code explorer and Windows Explorer, need no
  modifier key, and schedule the file **in place**. New `src/launcher.ts` holds
  the view and its controller, out of `extension.ts`.

- **A Completed section pinned to the foot of the plan library.** A one-shot
  that has run keeps its place in the list forever, so the top of the sidebar
  slowly fills with plans that will never fire again and the ones that still
  have a future get pushed down. Finished one-shots now drop out of **Library**
  and **External** and collect under **Completed**, newest first, with their
  names dimmed. Their meta line says when they ran rather than *Ran once*, which
  under that heading would only repeat it.

  The section sits outside the scrolling list, anchored above the folder links,
  so a growing pile of finished plans neither pushes the live ones out of view
  nor scrolls away itself. It takes a third of the panel at most and scrolls
  within that.

- **Rename (✎) and delete (×) buttons on every library plan in the sidebar.**
  Both meant selecting the plan and scrolling the detail pane to **Manage plan**
  — several steps to act on a file already in front of you. They appear on
  hover, stay visible on the selected row, and are reachable by keyboard.

  Renaming saves the open editor first: a rename moves the file, so anything
  typed has to reach the old path before it goes. Deleting does the opposite and
  drops a queued save for that plan, which would otherwise have written the file
  back a second or two after the delete removed it.

  External plans get neither. Their file lives outside the library and is not
  Chronus's to rename or delete — **Unschedule** in the detail pane is the
  equivalent, and it is the same line the Manage plan section used to draw.

  "Completed" is stricter than the stored `spent` flag, which the scheduler also
  sets the moment a run starts and on a one-shot that was missed. A plan only
  moves once its last run has actually finished — so a one-shot mid-run stays
  put and reads *Running now*, and a missed one stays put and reads *Missed*,
  since that one is still waiting for you to run or reschedule it.

### Fixed

- **Dragging a file from Windows Explorer onto the manager works again.** It had
  been failing with *"Could not read the dropped files — use Import instead."*
  for some time, and the cause was outside Chronus: the code read the dropped
  file's location from `File.path`, a non-standard property Electron added and
  then removed in version 32. Every current VS Code build is well past that, so
  the property was simply `undefined` and the list came back empty.

  There is no replacement — a sandboxed webview cannot learn where a file lives
  any more, by design. What it can still do is read the contents, so an OS drop
  now copies the file into your plan library and schedules the copy, exactly as
  **Import** does. The notice after the drop says so, because "scheduled" and
  "copied, then scheduled" differ in a way you would otherwise discover later:
  edits to the original would never run. Drops onto the activity-bar view and the
  right-click command still schedule in place, and remain the better route.

- **Dragging from the VS Code explorer onto the manager no longer silently does
  nothing.** VS Code disables mouse interaction over a webview while a drag is in
  flight, so the manager never saw the drag unless you held Shift
  ([vscode#182449](https://github.com/microsoft/vscode/issues/182449)). Nobody
  would guess that. The Shift path still works, but the activity-bar view added
  above is a real drop target that needs no modifier.

- **The external-plan guard no longer folds case on filesystems that don't.**
  The check deciding whether the manager may write to an absolute path compared
  paths lowercased on every platform. On Linux `Plan.md` and `plan.md` are two
  different files, so the guard was wider than intended there and would have
  permitted a write to a file the caller never named. Case is now folded only on
  Windows. No change to Windows behaviour.

### Changed

- **One schedule toggle instead of two buttons (0.8.0-rc.23).** The detail pane
  had a **Schedule this plan** button when a plan had no schedule and a separate
  **Pause** / **Resume** button once it did. They are now a single control that
  reads its own state: grey **Schedule** when nothing is scheduled, sodium amber
  **Scheduled** while the job is live, grey **Paused** when it is scheduled but
  paused. Clicking it schedules the plan, or toggles between live and paused.

  The colour is the point. Amber is the one thing Chronos spends on liveness, so
  it appears only while the job will actually fire — a paused series and a spent
  one-shot both stay quiet, the same rule the countdown ring already follows.
  **Run now** and **Unschedule** are unchanged, and so is everything outside
  `media/`.

- **The Schedule section's When field is a real picker now (0.8.0-rc.22).** It
  was a native `datetime-local` input, which meant setting a time was six typed
  segments — `MM/DD/YYYY hh:mm AM` — and the calendar it opened was drawn by the
  browser, outside the page, where the only thing Chronos could change about it
  was whether it came up dark or light. A white-and-blue Chromium calendar over
  the manager looked like it belonged to a different program, because it did.

  It is now a button that reads the scheduled time back to you, and opens a
  popover built from the same palette as everything else: a month grid you click
  a day in, arrows to page through months, and three dropdowns for hour, minute
  and AM/PM. Nothing is typed. The selected day is filled in sodium, the same
  colour the countdown ring and the run dots use for the scheduled instant, and
  today is outlined.

  Two details worth naming. Past days are still clickable — the native input
  allowed them and the host is what decides whether a past time means anything,
  so nothing new was invented here. And the minute dropdown steps in fives but
  always includes whatever minute is already set: a series running at `:07` does
  not get quietly rounded to `:05` just because you opened its picker to change
  the hour.

  The value itself is unchanged. It still leaves through the same path it always
  did, so recurring series keep moving their rule with their time, and nothing on
  the host side knows the control was replaced.

- **A generated plan is now named after the change it makes (0.8.0-rc.21).**
  Chronos used to name the file before the plan existed, by slugging the first
  line of the task — so the library filled with truncated request text on files
  whose contents said something else entirely. A plan about controlling the
  desktop from a phone was filed as
  `when-clicking-generate-plan-in-the-task-sidecar-i-would-like.md`. Claude now
  names the file itself, as part of approving the plan: it knows what the plan
  does, and Chronos does not.

  That name has to land somewhere safe, because a self-chosen one could collide
  with a plan you already have. So each planning session writes into its own
  staging folder, `.pending/<session>/` inside the library, and Chronos adopts
  the file from there through the same door every imported plan comes through —
  which slugs the name and appends `-2` rather than overwriting anything. The
  folder is also what still matches a finished plan back to the task that asked
  for it, so the task clears exactly as before, even with two sessions open at
  once. Backing out of a session still creates nothing; its folder is cleared on
  the next window reload.

  Plans already in your library keep the names they have — nothing is renamed
  retrospectively. Import, drag-and-drop and **Schedule with Chronos** are
  unchanged, and so is the manager's own **Generate plan** button, which rewrites
  a plan in place under the name you gave it.

- **The Tasks view is a real to-do list now (0.8.0-rc.20).** It was a native tree:
  one grey circle per row, and adding a task meant clicking **＋** in the title
  bar and answering a pop-up input box. It is now an HTML view, styled like the
  manager, with a **What needs doing?** field and an **Add** button always
  visible at the top — type, press Enter, and the row is there. Editing happens
  in place on the row rather than in a pop-up: the pencil turns the text into a
  field, Enter saves, Esc cancels. Deleting still asks first, because the file is
  unlinked rather than recycled.

  Each row carries a status dot, the same one the Runs panel uses. A captured
  task is a hollow neutral ring; a task with a planning session open glows amber
  with a halo, so the list says which of them Claude is working on. Nothing new
  is stored for this — the dot reads the same in-memory map that already clears a
  task when its plan lands, so a window reload leaves the dot neutral while the
  plan still arrives.

  A tree cannot host an input field, in-body buttons or freely coloured rows —
  that is an API limit, not a styling one — so the view had to change technology
  to change shape. The cost is below, under Removed.

- **The clock icon in the activity bar now opens the manager too.** Clicking it
  used to show only the Tasks inbox, so the most visible thing Chronos puts in
  the editor did not lead to Chronos' actual UI — you needed a second click on
  **Open Manager**, the status bar item, or the command palette to get there.
  Now one click reveals the Tasks sidebar exactly as before *and* opens the
  manager tab behind it.

  The sidebar deliberately stays open. It is the capture inbox, so collapsing it
  to make the icon a pure launcher would cost more than it gained.
  The manager opens without taking focus, which means your keystrokes stay in the
  sidebar where you clicked. **Open Manager**, the status bar item and
  `Chronos: Open Manager` all still work and still open the manager *with* focus
  — they are how you get the tab back after closing it.

  One consequence worth knowing: if VS Code reopens a window with the Chronos
  container showing, the manager opens with it.

- **The two folder links in the plan library are now icon buttons, up in the
  header.** *Show library folder* and *Show results folder* were underlined blue
  text stacked on two lines in a footer — the loudest thing in the panel, spent
  on the two actions you reach for least. They are now two 24px codicon buttons
  sitting beside **Import**, quiet at `--muted` and lighting on hover, like the
  rename and delete actions on a plan row. The tooltip and the screen-reader
  label both still say the full wording, and clicking either does exactly what
  it did before.

  Moving them retires the footer entirely, so the plan list and the **Completed**
  section now run to the bottom of the pane. The class is `.icon-action` rather
  than `.foot-action`, since it no longer describes where the button lives. The
  header row wraps rather than shrinks: at a large editor font four controls do
  not fit 260px, and a squashed *New plan* reads worse than a second row.

  This adds the official VS Code **codicon** font to the project, vendored as
  `media/codicon.css` and `media/codicon.ttf`. The webview may only load from
  `media/` and the packaged `.vsix` excludes `node_modules/`, so the files are
  committed there rather than copied by the build. Both are byte-identical to
  upstream `@vscode/codicons`, so refreshing them is a re-copy, not a merge.

- **There is one kind of plan now: every scheduled plan lives in the library.**
  Chronos used to have two. Library plans were `.md` files in the library folder,
  addressed by name. *External* plans were files anywhere else on disk that had
  been scheduled where they lay — addressed by absolute path, listed under their
  own heading with a badge, and denied rename and delete.

  Nobody asked for that distinction, and it cost a second file watcher, a second
  security model on the load and save messages, an `external` flag threaded
  through the webview protocol, and a second list in the sidebar. It was already
  inconsistent with itself: dropping a file onto the manager tab copied it into
  the library, while dropping the same file onto the activity-bar view scheduled
  it in place, and the README carried a paragraph whose only job was to explain
  why.

  **Every way of adding a plan now copies the file into your library and
  schedules the copy** — New plan, Import, right-click → **Schedule with
  Chronos**, and a drop onto either the activity-bar view or the manager tab.

  Copy, never move: **your original file stays exactly where it is**, and Chronos
  never edits or moves it. The consequence is worth stating plainly, because it
  is the one thing this changes for you — after adding a file, editing your
  original no longer affects what runs. The notice after adding says so.

  A plan added from a project keeps that project as its working directory. The
  file moves into the library; the work it does still belongs where it was.

- **Plans scheduled in place by an older version are copied into the library on
  first launch, and their schedules repointed at the copy.** Time, recurrence,
  permission mode and working directory all survive; only the file path changes.
  Two schedules pointing at the same file share one copy rather than getting two,
  and a name that collides with an existing plan is imported as `name-2.md` with
  both schedules intact. `Chronos: Show Logs` names every file it copied.

  This runs on every activation and needs no schema bump — once it has run, every
  path is already inside the library, so a second pass finds nothing to do.

- **A schedule whose plan file no longer exists is removed, along with its run
  history.** Previously it stayed in the list and fired on time, forever, failing
  every time because the file it names is gone. Delete a plan file in your file
  manager and the row now disappears within a second or so, whether the manager
  tab is open at the time or not; the removal is recorded in the log, since it
  discards work you created and the row is the only other place it was accounted
  for.

  A library folder that cannot be *read* is never mistaken for one that is empty.
  If `chronos.libraryPath` points at an unplugged drive or an offline share,
  Chronos touches nothing at all and says why in the log — pruning on that would
  destroy an entire schedule over a kicked-out cable.

- **New tasks default to the `auto` permission mode, not `bypassPermissions`.**
  The old default handed every scheduled task unrestricted tool access, and on a
  recurring series that waiver repeats indefinitely. `auto` leans on the CLI's
  own judgement about what is safe to do unattended instead.

  The trade-off is the reason the old default existed, and it has not gone away:
  a mode that can still stop and ask has nobody to answer at 3am, so a run may
  end having done only part of the job. Reviewing a plan before scheduling it
  remains the real safety step, and `bypassPermissions` is still one click away
  in the manager, still carrying its ⚠.

  **Existing tasks are untouched.** The default applies when a series is
  created; anything already scheduled keeps the mode stored with it. To move an
  old task, change **Permissions** on it in the manager.

- **The date picker no longer opens a white panel over a dark editor.** The
  **When** field's popup is browser chrome — drawn outside the page, where no
  selector reaches inside it. The one lever that does is `color-scheme`, now
  declared on `body` and flipped for both light themes, which decides whether
  Chromium paints the calendar, the **Repeat** dropdown and the native
  scrollbars dark or light. The popup keeps Chromium's own layout; it stops
  being the only light surface in the window.

  What *is* reachable is the control itself, and that is what you look at the
  rest of the time. The field now uses the editor font with tabular figures —
  the two-typeface rule the rest of the manager already follows, since a date is
  a measurement. The segment being edited is highlighted in sodium rather than
  the OS selection blue, which belonged to no theme here, and the calendar glyph
  sits muted and lights on hover, the same move the sidebar row actions make.

- **The publisher is now `Z3n`, not `onemedialabs`.** The extension id becomes
  `Z3n.chronos`, and the MIT copyright holder changes to match.

  Note that VS Code lowercases extension ids, so the installed extension reports
  itself as `z3n.chronos`. `package.json` keeps the capitalisation.

  **This resets your data a second time,** for the same reason the rename below
  did: VS Code keys stored state by the full id, and the publisher is half of
  it. Scheduled tasks and run history do not carry over. Plan files are ordinary
  Markdown and survive — copy them from the `onemedialabs.chronos\plans\` folder
  in globalStorage into the new `Z3n.chronos\plans\` one and re-schedule them.
  Settings are keyed by `chronos.*`, not by publisher, so those are kept.

  **Uninstall `onemedialabs.chronos` before installing this build**, on the same
  grounds as below: a changed id means the new build installs alongside the old
  one rather than over it, and two schedulers can fire the same plan twice.

- **The extension is now called Chronos, not Chronus.** The name was always meant
  to be Chronos; it had simply been misspelled everywhere since the first commit.
  Because it was never published, fixing it properly was still cheap, so the
  rename goes all the way down: extension id (`onemedialabs.chronos`), settings
  (`chronos.*`), command ids, view ids, storage keys and the `ChronosState` type.

  **This resets your data.** VS Code keys an extension's stored state by id, so
  `onemedialabs.chronos` starts with an empty one: scheduled tasks, run history
  and any customised `chronus.*` settings do not carry over, and no migration was
  written. Plan files are unaffected — they are ordinary Markdown in
  globalStorage, so copy them from the `onemedialabs.chronus\plans\` folder into
  the new `onemedialabs.chronos\plans\` one and re-schedule them.

  **Uninstall the old extension before installing this build.** Two installs mean
  two schedulers holding two separate lock files, neither aware of the other, and
  the same plan can fire twice.

- **New extension icon** (`media/icon.png`, 128×128) — the faceted sculpted
  head, replacing the clock-and-arrows mark. It is the marketplace icon and the
  manager panel's tab icon.

  `media/chronos.svg`, the activity-bar icon, is deliberately left as the old
  line mark. VS Code masks that icon to a single theme colour, so a photographic
  image can only arrive there as a silhouette.

- **Deleting a plan always asks now, and says the file is not recycled.** It
  only asked when the plan was scheduled; an unscheduled one was unlinked on the
  first click, with no way back. That was survivable while Delete was buried at
  the bottom of the detail pane, but the new sidebar × puts a permanent delete
  one misclick from every row. Both prompts now carry the same detail line —
  *The file is deleted, not moved to the recycle bin* — because `removePlan`
  unlinks, and a dialog that does not say so is worse than none.

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

- **The sidebar is no longer a drop target (0.8.0-rc.20).** Dragging a `.md` file
  onto the Tasks view used to schedule it, and a webview cannot accept that drop
  the way a tree could — VS Code blocks mouse events over a webview mid-drag, and
  Electron 32 removed `File.path`, so a sandboxed view can no longer learn where
  a dropped file came from. `PlanDropController` is gone with it.

  The three other routes are unchanged and one of them is a drop: drag onto the
  **manager** pane (hold **Shift** when dragging from the VS Code explorer),
  right-click a `.md` file → **Schedule with Chronos**, or use **Schedule
  Markdown File…** in the Tasks view's **⋯** menu. All four still end the same
  way — a copy in the library, scheduled, your original untouched.

  The **＋** button in the Tasks title bar went too, since adding is now a field
  in the panel itself. `Chronos: Add Task` remains in the command palette. The
  `chronos.generatePlan`, `chronos.editTask` and `chronos.deleteTask` commands
  are gone: they existed only to put icons on a tree row, were hidden from the
  palette, and the row buttons now speak to the view directly.

- **The External group and its badge**, along with everything that existed to
  support the second kind of plan: the second `fs.watch` on an external plan's
  own directory, `readPlanAt` / `writePlanAt` / `isScheduledPlan`, and the
  `external` flag in the webview protocol.

  The messages that address a plan — `loadPlan`, `savePlan`, `openInEditor`,
  `schedulePlan`, `generatePlan` — now carry a **name and nothing else**. No
  absolute path crosses the webview boundary in either direction, so every read,
  write, schedule and open resolves through the one library guard rather than
  through an "is this path actually in the schedule?" check standing in for it.
  With a single group, the **Library** heading over it named nothing, so it went
  too.
- `.badge.is-repeat` — dead CSS, nothing ever emitted the class.
- Status dots on library list items, which were redundant: each item already
  prints its next run in text.
- **The Manage plan section at the foot of the detail pane.** Rename and Delete
  moved to the sidebar row, where they act on a plan without selecting it first;
  the section held nothing else worth the heading. The detail pane now ends
  after the Runs section.
- **Duplicate**, which had no home once the section went and no other entry
  point. `library.duplicatePlan` and its tests are kept — the function is pure
  and harmless, and restoring the feature is then a UI change only — but the
  `duplicatePlan` webview message and its handler are gone, so nothing can
  reach it. The IPC surface should not outlive the button.

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

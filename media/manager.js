// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const listEl = /** @type {HTMLElement} */ (document.getElementById('plan-list'));
  const completedEl = /** @type {HTMLElement} */ (document.getElementById('completed'));
  const completedListEl = /** @type {HTMLElement} */ (document.getElementById('completed-list'));
  const detailEl = /** @type {HTMLElement} */ (document.getElementById('detail'));
  const noticeEl = /** @type {HTMLElement} */ (document.getElementById('notice'));
  const setupEl = /** @type {HTMLElement} */ (document.getElementById('setup'));
  const searchEl = /** @type {HTMLInputElement} */ (document.getElementById('search'));
  const costEl = /** @type {HTMLElement} */ (document.getElementById('cost'));
  const activityEl = /** @type {HTMLElement} */ (document.getElementById('activity'));
  const activityListEl = /** @type {HTMLElement} */ (document.getElementById('activity-list'));
  const activityFilterEl = /** @type {HTMLSelectElement} */ (document.getElementById('activity-filter'));
  const activityToggleEl = /** @type {HTMLElement} */ (document.getElementById('activity-toggle'));

  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /**
   * Approval settings, per engine. opencode has one control where Claude has
   * six, so it is offered the two that mean something — approve everything, or
   * plan only — rather than four more that would quietly map onto the same flag.
   */
  const PERMISSION_MODES = {
    claude: ['acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'],
    opencode: ['auto', 'plan']
  };

  /** Never a real model id: it starts with `_`, which the host's pattern rejects. */
  const CUSTOM_MODEL = '__custom';
  const SAVE_DEBOUNCE_MS = 2000;

  /** @type {{plans: any[], series: any[], runs: any[], activity: {upcoming: any[], recent: any[]}, costLast7Days: number, libraryPath: string, agents: {id: string, label: string, models: {value: string, label: string}[]}[], setupProblem?: string, schedulerElsewhere?: boolean}} */
  let state = {
    plans: [],
    series: [],
    runs: [],
    activity: { upcoming: [], recent: [] },
    costLast7Days: 0,
    libraryPath: '',
    // Sent by the extension from `src/agents.ts`, so the sidebar's model picker
    // and these dropdowns cannot drift apart, and only engines this machine can
    // actually run are listed. Empty only before the first state message
    // arrives, which is why every read below tolerates an empty list.
    agents: []
  };

  /** Selection and editor buffer live here, never in the DOM — a re-render
   *  must never be able to lose what you typed. */
  let selected = /** @type {string|null} */ (null);
  /** Runs-panel state, held here for the same reason. */
  let activityFilter = 'all';
  let activityCollapsed = false;
  /** A plan is addressed by name alone — no path from here ever reaches the
   *  filesystem, which is what lets the host resolve every read and write
   *  through the one library guard. */
  let editor = {
    name: /** @type {string|null} */ (null),
    text: '',
    dirty: false,
    conflict: false
  };
  let saveTimer = 0;
  let noticeTimer = 0;
  let elapsedTimer = 0;
  /** Whether the Model field is showing its free-text box. Curated lists go
   *  stale, and the host validates whatever is typed by shape. */
  let customModel = false;

  const previous = vscode.getState();
  if (previous && previous.selected) selected = previous.selected;
  if (previous && previous.activityFilter) activityFilter = previous.activityFilter;
  if (previous && previous.activityCollapsed) activityCollapsed = true;
  activityFilterEl.value = activityFilter;
  paintActivityCollapse();

  // ---------- helpers ----------

  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const send = (message) => vscode.postMessage(message);

  function toLocalInput(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const toUtcIso = (localValue) => new Date(localValue).toISOString();
  const localTimeOf = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function dayDiff(a, b) {
    const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((da.getTime() - db.getTime()) / 86400000);
  }

  function formatWhen(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diff = dayDiff(d, new Date());
    if (diff === 0) return `Today ${time}`;
    if (diff === 1) return `Tomorrow ${time}`;
    if (diff === -1) return `Yesterday ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(total % 60)}s`;
  }

  function formatAge(ms) {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  const planByName = (name) => state.plans.find((p) => p.name === name);
  const seriesForPlan = (plan) =>
    plan ? state.series.find((s) => samePath(s.filePath, plan.filePath)) : undefined;
  const seriesById = (id) => state.series.find((s) => s.id === id);

  /** The plan a panel row should select. Absent once the series is unscheduled. */
  function planForSeries(id) {
    const series = seriesById(id);
    return series ? state.plans.find((p) => samePath(p.filePath, series.filePath)) : undefined;
  }

  const repeatOf = (s) =>
    !s.recurrence ? 'once' : s.recurrence.daysOfWeek.length === 7 ? 'daily' : 'weekly';

  /** A series with no engine is a Claude series — the same rule the host uses. */
  const agentIdOf = (s) => (s && s.agent) || 'claude';
  const agentOf = (s) =>
    state.agents.find((a) => a.id === agentIdOf(s)) || state.agents[0];
  const modelsOf = (s) => (agentOf(s) || { models: [] }).models;

  const isRunning = (s) =>
    !!s && state.runs.some((r) => r.seriesId === s.id && r.status === 'running');

  // ---------- the time axis ----------

  /** Circumference of the ring's r=16 circle, in user units. */
  const RING_C = 100.53;

  /**
   * How long the current interval is, so the ring knows what fraction of it has
   * elapsed. A one-shot has no interval — there is nothing to be a fraction of.
   */
  function intervalMs(s) {
    if (!s || !s.recurrence) return null;
    const days = s.recurrence.daysOfWeek;
    if (!days.length) return null;
    if (days.length === 7) return 86400000;

    // Weekly: the gap back to whichever scheduled day precedes the next run.
    const next = new Date(s.nextRunAt).getDay();
    const earlier = days.filter((d) => d !== next);
    if (!earlier.length) return 7 * 86400000;
    return Math.min(...earlier.map((d) => (next - d + 7) % 7)) * 86400000;
  }

  /** Dash offset for a full circumference dasharray: full ring at 0% elapsed. */
  function ringOffset(iso, interval) {
    const left = new Date(iso).getTime() - Date.now();
    const done = Math.min(1, Math.max(0, (interval - left) / interval));
    return (RING_C * (1 - done)).toFixed(2);
  }

  const countdownText = (iso) => {
    const left = new Date(iso).getTime() - Date.now();
    return left > 0 ? `in ${formatDuration(left)}` : 'due now';
  };

  function cadenceOf(s) {
    const time = localTimeOf(s.nextRunAt);
    const repeat = repeatOf(s);
    if (repeat === 'daily') return `daily ${time}`;
    if (repeat === 'weekly') {
      return `${s.recurrence.daysOfWeek.map((d) => DAY_NAMES[d]).join(' ')} ${time}`;
    }
    return `once · ${formatWhen(s.nextRunAt)}`;
  }

  /** The one line that answers "when does this run next?". */
  function headStatus(s) {
    if (!s) return '<p class="head-status">Not scheduled</p>';
    if (s.spent) return '<p class="head-status">Ran once</p>';
    if (!s.enabled) return '<p class="head-status">Paused</p>';
    if (isRunning(s)) return '<p class="head-status"><span class="head-count">running now</span></p>';
    return `<p class="head-status">
      <span class="head-count" data-countdown="${esc(s.nextRunAt)}">${esc(countdownText(s.nextRunAt))}</span>
      &middot; ${esc(cadenceOf(s))}
    </p>`;
  }

  /**
   * Future time, cyclical. The arc fills as the current interval elapses. A live
   * run replaces it with a sweep; a one-shot gets an outline and no arc, which is
   * honest rather than inventing a progress figure.
   */
  function ringMarkup(s) {
    const track = '<circle class="ring-track" cx="20" cy="20" r="16" />';
    const interval = intervalMs(s);
    const live = s && s.enabled && !s.spent;

    let inner = '';
    if (isRunning(s)) {
      inner = '<circle class="ring-sweep" cx="20" cy="20" r="16" />';
    } else if (live && interval) {
      inner = `<circle class="ring-arc" cx="20" cy="20" r="16"
        data-ring-next="${esc(s.nextRunAt)}" data-ring-interval="${interval}"
        stroke-dasharray="${RING_C}" stroke-dashoffset="${ringOffset(s.nextRunAt, interval)}" />`;
    }

    return `<svg class="ring" viewBox="0 0 40 40" aria-hidden="true">${track}${inner}</svg>`;
  }

  // ---------- render ----------

  /**
   * Rebuilding innerHTML destroys focus and cursor position. Rather than reach
   * for a framework, the two places it matters are handled explicitly: focus is
   * restored around a render, and the editor is written from our own buffer.
   */
  function withFocusPreserved(render) {
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const key = active && active.dataset ? active.dataset.focusKey : undefined;
    const start = active && 'selectionStart' in active ? active.selectionStart : null;
    const end = active && 'selectionEnd' in active ? active.selectionEnd : null;

    render();

    if (!key) return;
    const restored = /** @type {any} */ (document.querySelector(`[data-focus-key="${key}"]`));
    if (!restored) return;
    restored.focus();
    if (start !== null && 'setSelectionRange' in restored) {
      try {
        restored.setSelectionRange(start, end);
      } catch {
        // Not all input types support selection ranges.
      }
    }
  }

  function render() {
    withFocusPreserved(() => {
      renderList();
      renderDetail();
      renderActivity();
    });

    costEl.textContent =
      state.costLast7Days > 0 ? `$${state.costLast7Days.toFixed(2)} over the last 7 days` : '';

    // A broken CLI outranks a dormant scheduler: it breaks every window, not
    // just this one.
    if (state.setupProblem) {
      setupEl.textContent = `Chronos cannot reach the Claude CLI. ${state.setupProblem}`;
      setupEl.hidden = false;
    } else if (state.schedulerElsewhere) {
      setupEl.textContent =
        'Another VS Code window is running the Chronos scheduler. ' +
        'Nothing will run from this window, and changes made here may not reach it.';
      setupEl.hidden = false;
    } else {
      setupEl.hidden = true;
    }

    startTicker();
    vscode.setState({ selected, activityFilter, activityCollapsed });
  }

  /** Mirrors `recency` in src/history.ts, which orders runs by the same rule. */
  const recencyOf = (run) => run.finishedAt ?? run.missedAt ?? run.startedAt ?? run.scheduledAt;

  const isFinished = (run) =>
    run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';

  /** The newest run of a series, whatever became of it. */
  function lastRun(series) {
    return state.runs
      .filter((r) => r.seriesId === series.id)
      .sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)))[0];
  }

  /**
   * A one-shot that has fired and finished with it. `spent` on its own is not
   * enough — the scheduler also sets it the moment a run starts, and on a
   * one-shot that was missed. Neither is done: one is still going, and the
   * other is still waiting for you to run or reschedule it.
   */
  function isDone(plan) {
    const series = seriesForPlan(plan);
    if (!series || !series.spent) return false;
    const run = lastRun(series);
    return !!run && isFinished(run);
  }

  function renderList() {
    const term = searchEl.value.trim().toLowerCase();
    const match = (p) => !term || p.title.toLowerCase().includes(term);
    const live = (p) => match(p) && !isDone(p);

    const plans = state.plans.filter(live);

    // Done plans move out, newest first. They render into their own pinned region
    // at the foot of the panel rather than into the scrolling list, so a growing
    // pile of them never pushes the live plans out of view.
    const done = state.plans
      .filter((p) => match(p) && isDone(p))
      .sort((a, b) =>
        recencyOf(lastRun(seriesForPlan(b))).localeCompare(recencyOf(lastRun(seriesForPlan(a))))
      );

    completedEl.hidden = !done.length;
    completedListEl.innerHTML = done.map(planItem).join('');

    if (!plans.length) {
      // With nothing live but something completed, the pinned region below is
      // already the answer — an empty-state above it would contradict it.
      listEl.innerHTML = done.length
        ? ''
        : `<p class="empty">${
            term ? 'No plans match.' : 'No plans yet.<br />Create one to get started.'
          }</p>`;
      return;
    }

    // No group heading: there is one kind of plan, so a heading over the only
    // group names nothing.
    listEl.innerHTML = plans.map(planItem).join('');
  }

  /** The line under a plan's name: where that plan is in its life. */
  function planMeta(plan, series) {
    if (!series) {
      return plan.modifiedMs ? `Edited ${formatAge(plan.modifiedMs)}` : 'Not scheduled';
    }
    if (!series.spent) {
      return series.enabled ? formatWhen(series.nextRunAt) : 'Paused';
    }

    // Spent, so there is no next occurrence to name — say how it ended instead.
    const run = lastRun(series);
    if (!run) return 'Ran once';
    if (run.status === 'pending') return 'Queued';
    if (run.status === 'running') return 'Running now';
    if (run.status === 'missed') return 'Missed';
    // Under the Completed heading "Ran once" would only repeat it, so say when.
    return formatWhen(recencyOf(run));
  }

  function planItem(plan) {
    const series = seriesForPlan(plan);
    const meta = planMeta(plan, series);

    const classes = [
      'plan-item',
      plan.name === selected ? 'is-selected' : '',
      isRunning(series) ? 'is-running' : '',
      isDone(plan) ? 'is-done' : ''
    ].join(' ');

    const actions = `<span class="plan-actions">
        <button class="plan-action" type="button" data-action="rename"
          data-name="${esc(plan.name)}" data-focus-key="rename-${esc(plan.name)}"
          title="Rename plan" aria-label="Rename ${esc(plan.title)}">&#9998;</button>
        <button class="plan-action is-danger" type="button" data-action="remove"
          data-name="${esc(plan.name)}" data-focus-key="remove-${esc(plan.name)}"
          title="Delete plan" aria-label="Delete ${esc(plan.title)}">&#215;</button>
      </span>`;

    // A row is a wrapper holding several buttons rather than one button, because
    // a button cannot be nested inside a button.
    return `<div class="plan-row">
      <button class="${classes}" type="button"
        data-action="select" data-name="${esc(plan.name)}" data-focus-key="plan-${esc(plan.name)}">
        <span class="plan-name">${esc(plan.title)}</span>
        <span class="plan-meta">${esc(meta)}</span>
      </button>
      ${actions}
    </div>`;
  }

  function renderDetail() {
    const plan = planByName(selected);
    if (!plan) {
      detailEl.innerHTML = state.plans.length
        ? '<p class="empty">Select a plan, or create one.</p>'
        : firstRunEmptyState();
      return;
    }

    // Write the plan, decide when it runs, read what happened — then the rare
    // and destructive management actions, last.
    const series = seriesForPlan(plan);
    detailEl.innerHTML = `
      <div class="detail-head">
        ${ringMarkup(series)}
        <div class="head-text">
          <div class="head-title-row">
            <h2 class="detail-title">${esc(plan.title)}</h2>
          </div>
          ${headStatus(series)}
          <p class="detail-path">${esc(plan.filePath)}</p>
        </div>
      </div>
      ${editorSection(series)}
      ${series ? scheduleSection(series) : unscheduledSection(plan)}
      ${series ? runsSection(series) : ''}
    `;

    mountEditor(plan);
  }

  function firstRunEmptyState() {
    return `<div class="empty-first-run">
      <h2 class="empty-title">Schedule Claude Code tasks from Markdown plans</h2>
      <p>Chronos runs a plan file with the Claude CLI on a schedule you choose —
        once, daily, or on set weekdays — and saves a transcript of every run.</p>
      <p>Two ways to add a plan:</p>
      <ul class="empty-ways">
        <li><strong>New plan</strong> — create one in your library and edit it here.</li>
        <li><strong>Drop a <code>.md</code> file</strong> anywhere on this window, or use
          <strong>Import</strong>, to schedule a plan you already have.</li>
      </ul>
    </div>`;
  }

  function unscheduledSection(plan) {
    return `<div class="section">
      <h3 class="section-title">Schedule</h3>
      <p class="plan-meta">This plan is not scheduled.</p>
      <div class="actions">
        <button class="button" type="button" data-action="schedule">Schedule this plan</button>
      </div>
    </div>`;
  }

  function scheduleSection(s) {
    const repeat = repeatOf(s);
    const dayToggles =
      repeat === 'weekly'
        ? `<div class="days">${DAY_LABELS.map(
            (label, i) =>
              `<button class="day ${s.recurrence.daysOfWeek.includes(i) ? 'is-on' : ''}" type="button"
                data-action="day" data-day="${i}" title="${DAY_NAMES[i]}">${label}</button>`
          ).join('')}</div>`
        : '';

    // The status used to live in this heading; it is the head's job now.
    return `<div class="section">
      <h3 class="section-title">Schedule</h3>
      <div class="grid">
        <label class="field">
          <span class="field-label">When</span>
          <input class="field-input" type="datetime-local" data-field="when"
            data-focus-key="when" value="${toLocalInput(s.nextRunAt)}" />
        </label>

        <label class="field">
          <span class="field-label">Repeat</span>
          <select class="field-input" data-field="repeat" data-focus-key="repeat">
            ${['once', 'daily', 'weekly']
              .map((v) => `<option value="${v}" ${v === repeat ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`)
              .join('')}
          </select>
        </label>

        ${permissionField(s)}
        ${engineField(s)}
        ${modelField(s)}
      </div>
      ${dayToggles}

      <div class="field is-spaced">
        <span class="field-label">Working directory</span>
        <div class="field-row">
          <span class="path-value" title="${esc(s.cwd)}">${esc(s.cwd)}</span>
          <button class="button is-quiet" type="button" data-action="browse-cwd">Change</button>
        </div>
      </div>

      <div class="actions">
        <button class="button" type="button" data-action="run-now">Run now</button>
        <button class="button is-quiet" type="button" data-action="toggle-enabled">${s.enabled ? 'Pause' : 'Resume'}</button>
        <button class="button is-quiet is-danger" type="button" data-action="unschedule">Unschedule</button>
      </div>
    </div>`;
  }

  /**
   * Only the modes the chosen engine actually has. When a series carries a mode
   * the engine does not offer — a Claude task switched to opencode still stores
   * `bypassPermissions` — the nearest equivalent is shown rather than written,
   * so switching back does not lose the original choice. What is shown is what
   * the run will do: `buildArgs` maps all four permissive modes onto `--auto`.
   */
  function permissionField(s) {
    const modes = PERMISSION_MODES[agentIdOf(s)] || PERMISSION_MODES.claude;
    const current = modes.includes(s.permissionMode) ? s.permissionMode : 'auto';

    return `<label class="field">
      <span class="field-label">Permissions</span>
      <select class="field-input" data-field="permissionMode" data-focus-key="perm">
        ${modes
          .map(
            (m) =>
              `<option value="${m}" ${m === current ? 'selected' : ''}>${m}${m === 'bypassPermissions' ? ' ⚠' : ''}</option>`
          )
          .join('')}
      </select>
    </label>`;
  }

  /**
   * Hidden when there is nothing to choose between — a machine with only the
   * Claude CLI installed gets the field it had before engines existed. It
   * reappears if a task is already pinned to an engine that has since gone
   * missing, so that is visible rather than silent.
   */
  function engineField(s) {
    if (state.agents.length < 2 && agentIdOf(s) === 'claude') return '';

    const options = state.agents.some((a) => a.id === agentIdOf(s))
      ? state.agents
      : [...state.agents, { id: agentIdOf(s), label: `${agentIdOf(s)} (not installed)` }];

    return `<label class="field">
      <span class="field-label">Engine</span>
      <select class="field-input" data-field="agent" data-focus-key="agent">
        ${options
          .map(
            (a) =>
              `<option value="${esc(a.id)}" ${a.id === agentIdOf(s) ? 'selected' : ''}>${esc(a.label)}</option>`
          )
          .join('')}
      </select>
    </label>`;
  }

  /**
   * The engine's curated list, plus a free-text box. The lists are hand-kept —
   * neither CLI can enumerate what your account reaches — so anything newer than
   * this build is typed in, and the host validates it by shape.
   */
  function modelField(s) {
    const models = modelsOf(s);
    const current = s.model || '';
    const listed = models.some((m) => m.value === current);
    const custom = customModel || (!!current && !listed);

    const box = custom
      ? `<label class="field">
          <span class="field-label">Model id</span>
          <input class="field-input" type="text" data-field="customModel" data-focus-key="custom-model"
            value="${esc(current)}" placeholder="provider/model" spellcheck="false" />
        </label>`
      : '';

    return `<label class="field">
      <span class="field-label">Model</span>
      <select class="field-input" data-field="model" data-focus-key="model">
        ${models
          .map(
            (m) =>
              `<option value="${esc(m.value)}" ${!custom && m.value === current ? 'selected' : ''}>${esc(m.label)}</option>`
          )
          .join('')}
        <option value="${CUSTOM_MODEL}" ${custom ? 'selected' : ''}>Custom…</option>
      </select>
    </label>
    ${box}`;
  }

  function editorSection(s) {
    // Planning is always a Claude session, whatever the series runs on — so an
    // opencode model id is not the thing to name here.
    const pinned = (s && agentIdOf(s) === 'claude' && s.model) || '';
    const known = modelsOf(s).find((m) => m.value === pinned);
    const model = pinned ? (known ? known.label : pinned) : 'your default model';
    return `<div class="section">
      <div class="section-head">
        <h3 class="section-title">Plan text</h3>
        <div class="section-actions">
          <button class="button is-quiet" type="button" data-action="generate-plan"
            title="Open a terminal running ${esc(model)} in plan mode, and plan from this text">Generate plan</button>
          <button class="link-button" type="button" data-action="open-editor">Open in editor ↗</button>
        </div>
      </div>
      <textarea class="editor" data-field="editor" data-focus-key="editor"
        spellcheck="false" aria-label="Plan text"></textarea>
      <p class="editor-status" data-role="editor-status"></p>
    </div>`;
  }

  function runsSection(s) {
    const runs = state.runs
      .filter((r) => r.seriesId === s.id)
      .sort((a, b) => (b.finishedAt ?? b.scheduledAt).localeCompare(a.finishedAt ?? a.scheduledAt))
      .slice(0, 20);

    if (!runs.length) {
      return `<div class="section"><h3 class="section-title">Runs</h3>
        <p class="plan-meta">No runs yet.</p></div>`;
    }

    return `<div class="section">
      <h3 class="section-title">Runs</h3>
      <div class="runs">${runs.map((r) => runRow(r, s)).join('')}</div>
    </div>`;
  }

  /**
   * A run you would want to be told about. Cancelling is not on the list: you
   * did that yourself, so it is history rather than something to chase.
   */
  const needsAttention = (run) =>
    run.status === 'failed' || run.status === 'missed' || !!run.authFailure || !!run.denials;

  /** The spine dot carries the same verdict as the badges, so the rail scans. */
  function dotClass(run) {
    if (run.status === 'running') return 'is-running';
    if (run.status === 'pending') return 'is-queued';
    if (needsAttention(run)) return 'is-bad';
    return run.status === 'completed' ? 'is-ok' : '';
  }

  /** Shared by the per-plan section and the Runs panel, so the two cannot drift. */
  function runBadges(run) {
    const badges = [];
    if (run.status === 'completed') badges.push('<span class="badge is-ok">completed</span>');
    if (run.status === 'failed') badges.push('<span class="badge is-bad">failed</span>');
    if (run.status === 'missed') badges.push('<span class="badge is-bad">missed</span>');
    if (run.status === 'cancelled') badges.push('<span class="badge">cancelled</span>');
    if (run.status === 'pending') badges.push('<span class="badge is-queued">queued</span>');
    if (run.authFailure) badges.push('<span class="badge is-bad">auth required</span>');
    if (run.attempt > 1) badges.push(`<span class="badge">retry ${run.attempt - 1}</span>`);
    if (run.denials) badges.push(`<span class="badge is-bad">⚠ ${run.denials} denied</span>`);
    if (run.costUsd) badges.push(`<span class="badge">$${run.costUsd.toFixed(2)}</span>`);
    return badges;
  }

  function runActions(run, series) {
    const actions = [];
    if (run.status === 'running') {
      actions.push(`<button class="link-button" type="button" data-action="cancel-run" data-run="${run.id}">cancel</button>`);
    } else if (run.status === 'missed') {
      // A recurring series has already advanced to its next occurrence, so the
      // only question is catch-up; a one-shot can be put back on the schedule.
      actions.push(`<button class="link-button" type="button" data-action="run-now" data-run="${run.id}">run now</button>`);
      actions.push(
        series && series.recurrence
          ? `<button class="link-button" type="button" data-action="dismiss-run" data-run="${run.id}">skip</button>`
          : `<button class="link-button" type="button" data-action="reschedule" data-run="${run.id}">reschedule</button>`
      );
    } else if (run.status === 'pending') {
      actions.push(`<button class="link-button" type="button" data-action="dismiss-run" data-run="${run.id}">skip</button>`);
    }
    if (run.resultPath) {
      actions.push(`<button class="link-button" type="button" data-action="open-result" data-run="${run.id}">result</button>`);
    }
    if (run.logPath) {
      actions.push(`<button class="link-button" type="button" data-action="open-log" data-run="${run.id}">raw log</button>`);
    }
    return actions;
  }

  /** A missed run has no result to show. This is what it says instead. */
  function missedNote(run) {
    if (run.status !== 'missed') return '';
    return `Missed${run.missedCount > 1 ? ` ${run.missedCount} occurrences` : ''}${
      run.missedReason === 'sleep' ? ' — machine asleep' : ' — VS Code closed'
    }`;
  }

  const whenText = (run) =>
    run.status === 'running' && run.startedAt
      ? `running <span data-started="${run.startedAt}">0m 00s</span>`
      : esc(formatWhen(run.scheduledAt));

  function runRow(run, series) {
    const note = missedNote(run);

    // The manager is where you sit down and read, so the summary is shown in
    // full rather than clamped the way the panel clamps it.
    const result = run.result ? `<p class="run-result">${esc(run.result)}</p>` : '';

    return `<div class="run">
      <span class="run-dot ${dotClass(run)}"></span>
      <div class="run-line">
        <span class="run-when">${whenText(run)}</span>
        ${runBadges(run).join('')}
        ${runActions(run, series).join('')}
      </div>
      ${note ? `<p class="run-result">${esc(note)}</p>` : ''}
      ${result}
    </div>`;
  }

  // ---------- the Runs panel: every plan, upcoming and recent ----------

  /**
   * The overview the per-plan Runs section cannot give: what is coming up and
   * what has already happened, across the whole library. Entries carry ids only
   * — the run itself is looked up in the `runs` array already on hand.
   */
  function renderActivity() {
    const activity = state.activity || { upcoming: [], recent: [] };
    const runById = new Map(state.runs.map((r) => [r.id, r]));

    const upcoming = activityFilter === 'all' || activityFilter === 'upcoming' ? activity.upcoming : [];
    const recent = (activityFilter === 'all' || activityFilter === 'completed' || activityFilter === 'attention'
      ? activity.recent
      : []
    ).filter((entry) => {
      const run = runById.get(entry.runId);
      if (!run) return false;
      if (activityFilter === 'completed') return run.status === 'completed';
      if (activityFilter === 'attention') return needsAttention(run);
      return true;
    });

    if (!upcoming.length && !recent.length) {
      activityListEl.innerHTML = `<p class="activity-empty">${
        activityFilter === 'all' ? 'Nothing scheduled or run yet.' : 'Nothing matches this filter.'
      }</p>`;
      return;
    }

    let html = '';
    if (upcoming.length) {
      html += `<p class="activity-group">Upcoming</p>${upcoming
        .map((entry) => activityRow(entry, runById.get(entry.runId)))
        .join('')}`;
    }
    if (recent.length) {
      html += `<p class="activity-group">Recent</p>${recent
        .map((entry) => activityRow(entry, runById.get(entry.runId)))
        .join('')}`;
    }
    activityListEl.innerHTML = html;
  }

  function activityRow(entry, run) {
    const plan = planForSeries(entry.seriesId);
    const title = plan
      ? `<button class="activity-plan" type="button" data-action="select" data-name="${esc(plan.name)}">${esc(entry.planTitle)}</button>`
      : `<span class="activity-plan is-gone">${esc(entry.planTitle)}</span>`;

    // No run record yet — a series' next occurrence. Nothing to cancel or skip,
    // so the row is a hollow dot and a countdown, and offers no actions.
    if (!run) {
      return `<div class="activity-row" data-series="${esc(entry.seriesId)}">
        <span class="run-dot"></span>
        ${title}
        <span class="activity-when">${esc(formatWhen(entry.at))}</span>
        <span class="activity-when is-count" data-countdown="${esc(entry.at)}">${esc(countdownText(entry.at))}</span>
      </div>`;
    }

    const series = seriesById(entry.seriesId);
    const note = run.result || missedNote(run);
    const countdown =
      run.status === 'pending' && Date.parse(run.scheduledAt) > Date.now()
        ? `<span class="activity-when is-count" data-countdown="${esc(run.scheduledAt)}">${esc(countdownText(run.scheduledAt))}</span>`
        : '';

    return `<div class="activity-row" data-series="${esc(entry.seriesId)}">
      <span class="run-dot ${dotClass(run)}"></span>
      ${title}
      <span class="activity-when">${whenText(run)}</span>
      ${countdown}
      ${runBadges(run).join('')}
      ${note ? `<span class="activity-note">${esc(note)}</span>` : ''}
      <span class="activity-actions">${runActions(run, series).join('')}</span>
    </div>`;
  }

  function paintActivityCollapse() {
    activityEl.classList.toggle('is-collapsed', activityCollapsed);
    activityToggleEl.setAttribute('aria-expanded', String(!activityCollapsed));
    activityToggleEl.textContent = activityCollapsed ? 'Show' : 'Hide';
  }

  // ---------- editor ----------

  /** Written from our buffer, never from state, so a re-render cannot lose typing. */
  function mountEditor(plan) {
    const area = /** @type {HTMLTextAreaElement|null} */ (detailEl.querySelector('[data-field="editor"]'));
    if (!area) return;

    if (editor.name !== plan.name) {
      editor = { name: plan.name, text: '', dirty: false, conflict: false };
      send({ type: 'loadPlan', name: plan.name });
    }
    area.value = editor.text;
    paintEditorStatus();
  }

  function paintEditorStatus() {
    const el = detailEl.querySelector('[data-role="editor-status"]');
    if (!el) return;

    el.classList.toggle('is-dirty', editor.dirty && !editor.conflict);
    el.classList.toggle('is-conflict', editor.conflict);
    el.textContent = editor.conflict
      ? 'Changed on disk while you were editing. Save to keep your version, or reopen the plan to discard it.'
      : editor.dirty
        ? 'Unsaved changes…'
        : 'Saved';
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (!editor.name || !editor.dirty) return;
    send({ type: 'savePlan', name: editor.name, text: editor.text });
    editor.dirty = false;
    editor.conflict = false;
    paintEditorStatus();
  }

  /** Drives everything on screen that moves with the clock: the elapsed timer of
   *  a live run, the head countdown, the ring's arc, and the Runs panel. Scoped
   *  to the document rather than the detail pane, because the panel is outside
   *  it and its countdowns must tick too. */
  function startTicker() {
    clearInterval(elapsedTimer);
    if (!document.querySelector('[data-started], [data-countdown], [data-ring-next]')) return;

    const tick = () => {
      document.querySelectorAll('[data-started]').forEach((el) => {
        el.textContent = formatDuration(Date.now() - new Date(el.dataset.started).getTime());
      });
      document.querySelectorAll('[data-countdown]').forEach((el) => {
        el.textContent = countdownText(el.dataset.countdown);
      });
      // CSP forbids inline styles, so the ring moves via its SVG presentation
      // attribute rather than el.style.
      document.querySelectorAll('[data-ring-next]').forEach((el) => {
        el.setAttribute(
          'stroke-dashoffset',
          ringOffset(el.dataset.ringNext, Number(el.dataset.ringInterval))
        );
      });
    };

    tick();
    elapsedTimer = setInterval(tick, 1000);
  }

  // ---------- events ----------

  /** Shared, because the completed plans sit outside the scrolling list. */
  function planClick(e) {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
    if (!el) return;
    const action = /** @type {HTMLElement} */ (el).dataset.action;
    const name = /** @type {HTMLElement} */ (el).dataset.name ?? null;

    // A queued save would write the file back moments after the delete removed
    // it, so a pending edit to this plan is dropped rather than resurrected.
    if (action === 'remove') {
      if (editor.name === name) {
        clearTimeout(saveTimer);
        editor.dirty = false;
      }
      return send({ type: 'deletePlan', name });
    }

    // The opposite of delete: a rename moves the file, so anything typed has to
    // reach the old path first or it lands in a file that no longer exists.
    if (action === 'rename') {
      saveNow();
      return send({ type: 'renamePlan', name });
    }

    if (action !== 'select') return;
    saveNow();
    selectPlan(name);
  }

  listEl.addEventListener('click', planClick);
  completedListEl.addEventListener('click', planClick);

  searchEl.addEventListener('input', renderList);

  /**
   * Everything a run row offers, keyed by run id and the series that owns it —
   * never by the current selection. That is what lets the Runs panel act on a
   * run belonging to a plan you are not looking at. Returns whether it handled
   * the action, so each caller can go on to its own.
   */
  function runAction(action, runId, series) {
    if (action === 'open-log') {
      send({ type: 'openLog', id: runId });
      return true;
    }
    if (action === 'open-result') {
      send({ type: 'openResult', id: runId });
      return true;
    }
    if (action === 'cancel-run') {
      send({ type: 'cancelRun', id: runId });
      return true;
    }
    if (action === 'dismiss-run') {
      send({ type: 'dismissRun', id: runId });
      return true;
    }

    if (!series) return false;

    // Passing dismissRunId is harmless when absent — the Run now in the schedule
    // section carries no run, a missed run's Run now clears itself as it fires.
    if (action === 'run-now') {
      send({ type: 'runNow', seriesId: series.id, dismissRunId: runId });
      return true;
    }

    if (action === 'reschedule') {
      const run = state.runs.find((r) => r.id === runId);
      send({ type: 'dismissRun', id: runId });
      // Prefill the missed run's own time of day on its next occurrence, and
      // clear `spent` so the one-shot is genuinely back on the schedule.
      patch(series.id, {
        nextRunAt: nextAtTimeOf(run ? run.scheduledAt : series.nextRunAt),
        enabled: true,
        spent: false
      });
      return true;
    }

    return false;
  }

  activityListEl.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
    if (!el) return;
    const action = /** @type {HTMLElement} */ (el).dataset.action;

    if (action === 'select') {
      saveNow();
      selectPlan(/** @type {HTMLElement} */ (el).dataset.name ?? null);
      return;
    }

    // The row carries the series, so a run acts on its own plan rather than on
    // whichever one happens to be open.
    const row = /** @type {HTMLElement} */ (el).closest('[data-series]');
    const series = row ? seriesById(/** @type {HTMLElement} */ (row).dataset.series) : undefined;
    runAction(action, /** @type {HTMLElement} */ (el).dataset.run, series);
  });

  activityFilterEl.addEventListener('change', () => {
    activityFilter = activityFilterEl.value;
    renderActivity();
    startTicker();
    vscode.setState({ selected, activityFilter, activityCollapsed });
  });

  activityToggleEl.addEventListener('click', () => {
    activityCollapsed = !activityCollapsed;
    paintActivityCollapse();
    vscode.setState({ selected, activityFilter, activityCollapsed });
  });

  detailEl.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
    if (!el) return;
    const action = /** @type {HTMLElement} */ (el).dataset.action;
    const runId = /** @type {HTMLElement} */ (el).dataset.run;

    const plan = planByName(selected);
    if (!plan) return;
    const series = seriesForPlan(plan);

    if (action === 'open-editor') return send({ type: 'openInEditor', name: plan.name });
    if (action === 'generate-plan') {
      saveNow(); // Claude reads the file, so what is on screen must be on disk
      return send({ type: 'generatePlan', name: plan.name, seriesId: series && series.id });
    }
    if (action === 'schedule') return send({ type: 'schedulePlan', name: plan.name });

    if (runAction(action, runId, series)) return;
    if (!series) return;

    if (action === 'unschedule') return send({ type: 'removeSeries', id: series.id });
    if (action === 'browse-cwd') return send({ type: 'browseCwd', id: series.id });
    if (action === 'toggle-enabled') {
      // Resuming a spent one-shot has to clear `spent`, or it will never fire.
      return patch(series.id, series.enabled ? { enabled: false } : { enabled: true, spent: false });
    }

    if (action === 'day') {
      const day = Number(/** @type {HTMLElement} */ (el).dataset.day);
      const days = series.recurrence.daysOfWeek.includes(day)
        ? series.recurrence.daysOfWeek.filter((d) => d !== day)
        : [...series.recurrence.daysOfWeek, day];
      if (!days.length) return;
      return patch(series.id, { recurrence: { ...series.recurrence, daysOfWeek: days.sort() } });
    }
  });

  detailEl.addEventListener('input', (e) => {
    const el = /** @type {HTMLTextAreaElement} */ (e.target);
    if (el.dataset && el.dataset.field === 'editor') {
      editor.text = el.value;
      editor.dirty = true;
      paintEditorStatus();
      queueSave();
    }
  });

  detailEl.addEventListener('change', (e) => {
    const el = /** @type {HTMLInputElement|HTMLSelectElement} */ (e.target);
    const field = el.dataset ? el.dataset.field : undefined;
    if (!field || field === 'editor') return;

    const series = seriesForPlan(planByName(selected));
    if (!series) return;

    if (field === 'when') {
      if (!el.value) return;
      return patch(series.id, whenPatch(series, toUtcIso(el.value)));
    }

    if (field === 'repeat') {
      const timeLocal = localTimeOf(series.nextRunAt);
      if (el.value === 'once') return patch(series.id, { recurrence: null });
      if (el.value === 'daily') {
        return patch(series.id, { recurrence: { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeLocal } });
      }
      return patch(series.id, {
        recurrence: { daysOfWeek: [new Date(series.nextRunAt).getDay()], timeLocal }
      });
    }

    if (field === 'permissionMode') return patch(series.id, { permissionMode: el.value });

    // A model id belongs to one engine, so switching engines drops one the new
    // engine has never heard of rather than passing it on to fail at fire time.
    if (field === 'agent') {
      const next = state.agents.find((a) => a.id === el.value);
      const keeps = !!next && next.models.some((m) => m.value === (series.model || ''));
      customModel = false;
      return patch(series.id, { agent: el.value, model: keeps ? series.model : undefined });
    }

    if (field === 'model') {
      // Custom… is a UI state, not a value: it reveals the box below, and the
      // box is what patches.
      if (el.value === CUSTOM_MODEL) {
        customModel = true;
        return render();
      }
      customModel = false;
      return patch(series.id, { model: el.value || undefined });
    }

    if (field === 'customModel') return patch(series.id, { model: el.value.trim() || undefined });
  });

  // Blur-save, so switching away never loses an edit.
  detailEl.addEventListener(
    'focusout',
    (e) => {
      const el = /** @type {HTMLElement} */ (e.target);
      if (el.dataset && el.dataset.field === 'editor') saveNow();
    },
    true
  );

  window.addEventListener('beforeunload', saveNow);

  document.getElementById('new-plan').addEventListener('click', () => send({ type: 'createPlan' }));

  document.getElementById('import-plan').addEventListener('click', () => send({ type: 'importPlan' }));
  document.getElementById('reveal-library').addEventListener('click', () => send({ type: 'revealLibrary' }));
  document.getElementById('reveal-results').addEventListener('click', () => send({ type: 'revealResults' }));

  /** Moving a recurring series' time must move its rule too. */
  function whenPatch(series, iso) {
    const p = { nextRunAt: iso, spent: false };
    if (series.recurrence) p.recurrence = { ...series.recurrence, timeLocal: localTimeOf(iso) };
    return p;
  }

  /** The next future instant at a given ISO's local time of day, as UTC ISO. */
  function nextAtTimeOf(iso) {
    const src = new Date(iso);
    const at = new Date();
    at.setHours(src.getHours(), src.getMinutes(), 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }

  const patch = (id, p) => send({ type: 'updateSeries', id, patch: p });

  /** Moving to another plan drops the Model field's free-text box, which
   *  belonged to the plan you were looking at. */
  function selectPlan(name) {
    if (name !== selected) customModel = false;
    selected = name;
    render();
  }

  function showNotice(text) {
    noticeEl.textContent = text;
    noticeEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeEl.hidden = true;
    }, 6000);
  }

  // ---------- drag and drop ----------

  function readDrop(dt) {
    const uriList = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list');
    if (uriList) {
      return uriList
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
    }
    // No path branch for an OS drop: Electron 32 removed File.path, and a
    // sandboxed webview has no other way to learn where a file lives. The drop
    // handler reads the contents instead.
    return [];
  }

  /** Only files/URIs count — a text drag inside the editor must be left alone. */
  function isFileDrag(dt) {
    return !!dt && Array.from(dt.types || []).some(
      (t) => t === 'Files' || t === 'application/vnd.code.uri-list' || t === 'text/uri-list'
    );
  }

  let dragDepth = 0;

  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });

  document.addEventListener('dragover', (e) => {
    if (isFileDrag(e.dataTransfer)) e.preventDefault();
  });

  document.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });

  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');

    const items = readDrop(e.dataTransfer);
    if (items.length) {
      send({ type: 'drop', items });
      return;
    }

    // An OS drop can no longer say where the file lives, but the contents are
    // still readable — so copy it into the library, the same as Import does.
    // preventDefault() has already run above, and a File stays readable after
    // this handler returns, so reading asynchronously is safe.
    const files = Array.from(e.dataTransfer.files || []).filter(
      (f) => f.name.toLowerCase().endsWith('.md') && f.size < 1_000_000
    );
    if (!files.length) {
      showNotice('Could not read the dropped files — use Import instead.');
      return;
    }

    Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
      .then((copies) => send({ type: 'dropText', files: copies }))
      .catch(() => showNotice('Could not read the dropped files — use Import instead.'));
  });

  // ---------- inbound ----------

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'state') {
      state = message;
      if (selected && !planByName(selected)) selected = null;
      if (!selected && state.plans.length) selected = state.plans[0].name;
      render();
      return;
    }

    if (message.type === 'planText') {
      // A load only wins if you have not typed since asking for it.
      if (message.name === editor.name && !editor.dirty) {
        editor.text = message.text;
        editor.conflict = false;
        const area = /** @type {HTMLTextAreaElement|null} */ (detailEl.querySelector('[data-field="editor"]'));
        if (area) area.value = message.text;
        paintEditorStatus();
      }
      return;
    }

    if (message.type === 'planChanged') {
      // Never silently discard either side. Clean buffer reloads; dirty warns.
      if (message.name !== editor.name) return;
      if (editor.dirty) {
        editor.conflict = true;
        paintEditorStatus();
      } else {
        send({ type: 'loadPlan', name: message.name });
      }
      return;
    }

    if (message.type === 'select') {
      selectPlan(message.name);
      return;
    }

    if (message.type === 'notice') showNotice(message.text);
  });

  send({ type: 'ready' });
})();

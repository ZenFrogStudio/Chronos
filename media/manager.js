// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const listEl = /** @type {HTMLElement} */ (document.getElementById('plan-list'));
  const detailEl = /** @type {HTMLElement} */ (document.getElementById('detail'));
  const noticeEl = /** @type {HTMLElement} */ (document.getElementById('notice'));
  const setupEl = /** @type {HTMLElement} */ (document.getElementById('setup'));
  const searchEl = /** @type {HTMLInputElement} */ (document.getElementById('search'));
  const costEl = /** @type {HTMLElement} */ (document.getElementById('cost'));

  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PERMISSION_MODES = ['acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions'];
  // `value` is passed to the CLI's --model verbatim; '' means the account default.
  // Pinned IDs run a specific model; the bare aliases track the newest of a family.
  const MODELS = [
    { value: '', label: 'Account default' },
    { value: 'claude-opus-5', label: 'Opus 5' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { value: 'claude-fable-5', label: 'Fable 5' },
    { value: 'opus', label: 'Opus (latest)' },
    { value: 'sonnet', label: 'Sonnet (latest)' },
    { value: 'haiku', label: 'Haiku (latest)' }
  ];
  const SAVE_DEBOUNCE_MS = 2000;

  /** @type {{plans: any[], external: any[], series: any[], runs: any[], costLast7Days: number, libraryPath: string, setupProblem?: string, schedulerElsewhere?: boolean}} */
  let state = { plans: [], external: [], series: [], runs: [], costLast7Days: 0, libraryPath: '' };

  /** Selection and editor buffer live here, never in the DOM — a re-render
   *  must never be able to lose what you typed. */
  let selected = /** @type {string|null} */ (null);
  let editor = {
    name: /** @type {string|null} */ (null),
    text: '',
    dirty: false,
    conflict: false,
    filePath: /** @type {string|null} */ (null),
    external: false
  };
  let saveTimer = 0;
  let noticeTimer = 0;
  let elapsedTimer = 0;

  const previous = vscode.getState();
  if (previous && previous.selected) selected = previous.selected;

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

  const allPlans = () => [...state.plans, ...state.external];
  const planByName = (name) => allPlans().find((p) => p.name === name);
  const seriesForPlan = (plan) =>
    plan ? state.series.find((s) => samePath(s.filePath, plan.filePath)) : undefined;

  const repeatOf = (s) =>
    !s.recurrence ? 'once' : s.recurrence.daysOfWeek.length === 7 ? 'daily' : 'weekly';

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
    });

    costEl.textContent =
      state.costLast7Days > 0 ? `$${state.costLast7Days.toFixed(2)} over the last 7 days` : '';

    // A broken CLI outranks a dormant scheduler: it breaks every window, not
    // just this one.
    if (state.setupProblem) {
      setupEl.textContent = `Chronus cannot reach the Claude CLI. ${state.setupProblem}`;
      setupEl.hidden = false;
    } else if (state.schedulerElsewhere) {
      setupEl.textContent =
        'Another VS Code window is running the Chronus scheduler. ' +
        'Nothing will run from this window, and changes made here may not reach it.';
      setupEl.hidden = false;
    } else {
      setupEl.hidden = true;
    }

    startElapsedTicker();
    vscode.setState({ selected });
  }

  function renderList() {
    const term = searchEl.value.trim().toLowerCase();
    const match = (p) => !term || p.title.toLowerCase().includes(term);

    const library = state.plans.filter(match);
    const external = state.external.filter(match);

    if (!library.length && !external.length) {
      listEl.innerHTML = `<p class="empty">${
        term ? 'No plans match.' : 'No plans yet.<br />Create one to get started.'
      }</p>`;
      return;
    }

    let html = '';
    if (library.length) {
      html += `<p class="plan-group">Library</p>${library.map(planItem).join('')}`;
    }
    if (external.length) {
      html += `<p class="plan-group">External</p>${external.map(planItem).join('')}`;
    }
    listEl.innerHTML = html;
  }

  function planItem(plan) {
    const series = seriesForPlan(plan);
    const meta = series
      ? series.spent
        ? 'Ran once'
        : series.enabled
          ? formatWhen(series.nextRunAt)
          : 'Paused'
      : plan.modifiedMs
        ? `Edited ${formatAge(plan.modifiedMs)}`
        : 'Not scheduled';

    return `<button class="plan-item ${plan.name === selected ? 'is-selected' : ''}" type="button"
      data-action="select" data-name="${esc(plan.name)}" data-focus-key="plan-${esc(plan.name)}">
      <span class="plan-name">${esc(plan.title)}</span>
      <span class="plan-meta">${esc(meta)}</span>
    </button>`;
  }

  function renderDetail() {
    const plan = planByName(selected);
    if (!plan) {
      detailEl.innerHTML = allPlans().length
        ? '<p class="empty">Select a plan, or create one.</p>'
        : firstRunEmptyState();
      return;
    }

    const series = seriesForPlan(plan);
    detailEl.innerHTML = `
      <div class="detail-head">
        <h2 class="detail-title">${esc(plan.title)}</h2>
        ${plan.external ? '<span class="badge">External</span>' : ''}
      </div>
      <p class="detail-path">${esc(plan.filePath)}</p>
      ${planActions(plan)}
      ${series ? scheduleSection(series) : unscheduledSection(plan)}
      ${editorSection(plan)}
      ${series ? runsSection(series) : ''}
    `;

    mountEditor(plan);
  }

  function firstRunEmptyState() {
    return `<div class="empty-first-run">
      <h2 class="empty-title">Schedule Claude Code tasks from Markdown plans</h2>
      <p>Chronus runs a plan file with the Claude CLI on a schedule you choose —
        once, daily, or on set weekdays — and saves a transcript of every run.</p>
      <p>Two ways to add a plan:</p>
      <ul class="empty-ways">
        <li><strong>New plan</strong> — create one in your library and edit it here.</li>
        <li><strong>Drop a <code>.md</code> file</strong> anywhere on this window, or use
          <strong>Import</strong>, to schedule a plan you already have.</li>
      </ul>
    </div>`;
  }

  function planActions(plan) {
    return `<div class="actions">
      <button class="button is-quiet" type="button" data-action="open-editor">Open in editor</button>
      ${
        plan.external
          ? ''
          : `<button class="button is-quiet" type="button" data-action="rename">Rename</button>
             <button class="button is-quiet" type="button" data-action="duplicate">Duplicate</button>
             <button class="button is-quiet is-danger" type="button" data-action="delete">Delete</button>`
      }
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

    const status = s.spent ? 'Ran once' : s.enabled ? formatWhen(s.nextRunAt) : 'Paused';

    return `<div class="section">
      <h3 class="section-title">Schedule &middot; ${esc(status)}</h3>
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

        <label class="field">
          <span class="field-label">Permissions</span>
          <select class="field-input" data-field="permissionMode" data-focus-key="perm">
            ${PERMISSION_MODES.map(
              (m) => `<option value="${m}" ${m === s.permissionMode ? 'selected' : ''}>${m}${m === 'bypassPermissions' ? ' ⚠' : ''}</option>`
            ).join('')}
          </select>
        </label>

        <label class="field">
          <span class="field-label">Model</span>
          <select class="field-input" data-field="model" data-focus-key="model">
            ${MODELS.map(
              (m) => `<option value="${esc(m.value)}" ${m.value === (s.model ?? '') ? 'selected' : ''}>${esc(m.label)}</option>`
            ).join('')}
          </select>
        </label>
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

  function editorSection(plan) {
    return `<div class="section">
      <h3 class="section-title">Plan text</h3>
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
      ${runs.map((r) => runRow(r, s)).join('')}
    </div>`;
  }

  function runRow(run, series) {
    const badges = [];
    if (run.status === 'completed') badges.push('<span class="badge is-ok">completed</span>');
    if (run.status === 'failed') badges.push('<span class="badge is-bad">failed</span>');
    if (run.status === 'missed') badges.push('<span class="badge is-bad">missed</span>');
    if (run.status === 'cancelled') badges.push('<span class="badge">cancelled</span>');
    if (run.status === 'pending') badges.push('<span class="badge">queued</span>');
    if (run.authFailure) badges.push('<span class="badge is-bad">auth required</span>');
    if (run.attempt > 1) badges.push(`<span class="badge">retry ${run.attempt - 1}</span>`);
    if (run.denials) badges.push(`<span class="badge is-bad">⚠ ${run.denials} denied</span>`);
    if (run.costUsd) badges.push(`<span class="badge">$${run.costUsd.toFixed(2)}</span>`);

    const when =
      run.status === 'running' && run.startedAt
        ? `<span class="pulse"></span>running <span data-started="${run.startedAt}">0m 00s</span>`
        : formatWhen(run.scheduledAt);

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

    const missedNote =
      run.status === 'missed'
        ? `<p class="run-result">Missed${run.missedCount > 1 ? ` ${run.missedCount} occurrences` : ''}${
            run.missedReason === 'sleep' ? ' — machine asleep' : ' — VS Code closed'
          }</p>`
        : '';

    // The manager is where you sit down and read, so the summary is shown in
    // full rather than clamped the way the sidebar clamps it.
    const result = run.result ? `<p class="run-result">${esc(run.result)}</p>` : '';

    return `<div class="run">
      <div class="run-line">
        <span class="run-when">${when}</span>
        ${badges.join('')}
        ${actions.join('')}
      </div>
      ${missedNote}
      ${result}
    </div>`;
  }

  // ---------- editor ----------

  /** Written from our buffer, never from state, so a re-render cannot lose typing. */
  function mountEditor(plan) {
    const area = /** @type {HTMLTextAreaElement|null} */ (detailEl.querySelector('[data-field="editor"]'));
    if (!area) return;

    if (editor.name !== plan.name) {
      editor = {
        name: plan.name,
        text: '',
        dirty: false,
        conflict: false,
        filePath: plan.filePath,
        external: !!plan.external
      };
      send({ type: 'loadPlan', name: plan.name, filePath: plan.filePath, external: !!plan.external });
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
    send({
      type: 'savePlan',
      name: editor.name,
      text: editor.text,
      filePath: editor.filePath,
      external: editor.external
    });
    editor.dirty = false;
    editor.conflict = false;
    paintEditorStatus();
  }

  function startElapsedTicker() {
    clearInterval(elapsedTimer);
    if (!state.runs.some((r) => r.status === 'running')) return;
    const tick = () => {
      detailEl.querySelectorAll('[data-started]').forEach((el) => {
        el.textContent = formatDuration(Date.now() - new Date(el.dataset.started).getTime());
      });
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  }

  // ---------- events ----------

  listEl.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-action="select"]');
    if (!el) return;
    saveNow();
    selected = /** @type {HTMLElement} */ (el).dataset.name ?? null;
    render();
  });

  searchEl.addEventListener('input', renderList);

  detailEl.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
    if (!el) return;
    const action = /** @type {HTMLElement} */ (el).dataset.action;
    const runId = /** @type {HTMLElement} */ (el).dataset.run;

    const plan = planByName(selected);
    if (!plan) return;
    const series = seriesForPlan(plan);

    if (action === 'open-editor') return send({ type: 'openInEditor', filePath: plan.filePath });
    if (action === 'schedule') return send({ type: 'schedulePlan', filePath: plan.filePath });
    if (action === 'duplicate') return send({ type: 'duplicatePlan', name: plan.name });
    if (action === 'delete') return send({ type: 'deletePlan', name: plan.name });
    if (action === 'open-log') return send({ type: 'openLog', id: runId });
    if (action === 'open-result') return send({ type: 'openResult', id: runId });
    if (action === 'cancel-run') return send({ type: 'cancelRun', id: runId });
    if (action === 'dismiss-run') return send({ type: 'dismissRun', id: runId });

    if (action === 'rename') {
      saveNow();
      return send({ type: 'renamePlan', name: plan.name });
    }

    if (!series) return;

    // Passing dismissRunId is harmless when absent — the Run now in the schedule
    // section carries no run, a missed run's Run now clears itself as it fires.
    if (action === 'run-now') return send({ type: 'runNow', seriesId: series.id, dismissRunId: runId });

    if (action === 'reschedule') {
      const run = state.runs.find((r) => r.id === runId);
      send({ type: 'dismissRun', id: runId });
      // Prefill the missed run's own time of day on its next occurrence, and
      // clear `spent` so the one-shot is genuinely back on the schedule.
      return patch(series.id, {
        nextRunAt: nextAtTimeOf(run ? run.scheduledAt : series.nextRunAt),
        enabled: true,
        spent: false
      });
    }

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
    if (field === 'model') return patch(series.id, { model: el.value || undefined });
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
    // OS-level drop. File.path is unreliable in a sandboxed webview, hence the
    // Import/browse fallback.
    return Array.from(dt.files || [])
      .map((f) => f.path)
      .filter(Boolean);
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
    } else {
      showNotice('Could not read the dropped files — use Import instead.');
    }
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
        send({ type: 'loadPlan', name: message.name, filePath: editor.filePath, external: editor.external });
      }
      return;
    }

    if (message.type === 'select') {
      selected = message.name;
      render();
      return;
    }

    if (message.type === 'notice') showNotice(message.text);
  });

  send({ type: 'ready' });
})();

// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const listEl = /** @type {HTMLElement} */ (document.getElementById('task-list'));
  const emptyEl = /** @type {HTMLElement} */ (document.getElementById('empty'));
  const inputEl = /** @type {HTMLInputElement} */ (document.getElementById('task-input'));
  const addEl = /** @type {HTMLElement} */ (document.getElementById('add-task'));
  const barEl = /** @type {HTMLElement} */ (document.getElementById('generate-bar'));
  const generateEl = /** @type {HTMLButtonElement} */ (document.getElementById('generate-plan'));

  /** @type {{tasks: {name: string, label: string, generating: boolean}[]}} */
  let state = { tasks: [] };

  /** The row being edited and what has been typed into it. Held here, never read
   *  back off the DOM — a state message rebuilds the list, and that must never
   *  be able to lose what you typed. */
  let editing = /** @type {{name: string, text: string}|null} */ (null);

  /** The highlighted row's file name, or null. Held here for the same reason as
   *  `editing`, and not persisted: the list is short and reopening the panel
   *  costs nothing. */
  let selected = /** @type {string|null} */ (null);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const send = (message) => vscode.postMessage(message);
  const labelOf = (name) => (state.tasks.find((task) => task.name === name) || { label: '' }).label;

  // ---------- rendering ----------

  function render() {
    // Read before the rebuild throws the focused element away: focus only
    // returns to the list if it was already there, so a redraw never steals it
    // from the capture field.
    const hadFocus = listEl.contains(document.activeElement);

    listEl.innerHTML = state.tasks.map(taskRow).join('');
    emptyEl.hidden = state.tasks.length > 0;

    const edit = listEl.querySelector('.task-edit');
    if (edit instanceof HTMLInputElement) {
      edit.focus();
      edit.setSelectionRange(edit.value.length, edit.value.length);
    } else if (hadFocus) {
      // Focus follows the highlight — that is what makes arrowing past the fold
      // scroll, and it is why the rows carry a roving tabindex.
      const row = listEl.querySelector('.task-row.is-selected');
      if (row instanceof HTMLElement) {
        row.focus();
        row.scrollIntoView({ block: 'nearest' });
      }
    }

    const task = state.tasks.find((t) => t.name === selected);
    barEl.hidden = state.tasks.length === 0;
    generateEl.disabled = !task || task.generating;
    generateEl.title = !task
      ? 'Select a task first'
      : task.generating
        ? 'A planning session is already open for this task'
        : `Generate a plan from "${task.label}"`;
  }

  function taskRow(task) {
    // A task is addressed by file name alone — no path from here ever reaches
    // the filesystem, which is what lets the host guard every read and write.
    const dotTitle = task.generating ? 'A planning session is open for this task' : 'Captured';
    const dot = `<span class="task-dot${task.generating ? ' is-generating' : ''}" title="${dotTitle}"></span>`;

    const body =
      editing && editing.name === task.name
        ? `<input class="task-edit" type="text" value="${esc(editing.text)}" aria-label="Edit task" />`
        : `<span class="task-label">${esc(task.label)}</span>`;

    // Roving tabindex: only the selected row is in the tab order, so Tab crosses
    // the list once and the arrows move within it.
    const on = task.name === selected;

    return `<div class="task-row${on ? ' is-selected' : ''}" data-name="${esc(task.name)}"
      role="option" aria-selected="${on}" tabindex="${on ? 0 : -1}">
      ${dot}
      ${body}
      <span class="task-actions">
        <button class="task-action" type="button" data-action="edit"
          title="Edit task" aria-label="Edit ${esc(task.label)}">
          <i class="codicon codicon-pencil"></i>
        </button>
        <button class="task-action is-danger" type="button" data-action="delete"
          title="Archive task" aria-label="Archive ${esc(task.label)}">
          <i class="codicon codicon-archive"></i>
        </button>
      </span>
    </div>`;
  }

  // ---------- capture ----------

  function addTask() {
    const text = inputEl.value.trim();
    if (!text) {
      return;
    }
    send({ type: 'addTask', text });
    // Cleared straight away rather than on the state message coming back: the
    // field is where you keep typing, and the row lands a moment later.
    inputEl.value = '';
    inputEl.focus();
  }

  addEl.addEventListener('click', addTask);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      addTask();
    }
  });

  // ---------- rows ----------

  listEl.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const row = target && target.closest('.task-row');
    const name = row instanceof HTMLElement ? row.dataset.name : '';
    if (!name) {
      return;
    }

    // Selection first, so pressing Edit or Delete also moves the highlight to
    // the row you pressed it on — the bottom button then means that row too.
    const button = target && target.closest('.task-action');
    if (name !== selected) {
      selected = name;
      render();
    }
    if (!(button instanceof HTMLElement)) {
      return;
    }

    if (button.dataset.action === 'delete') {
      send({ type: 'deleteTask', name });
    } else if (button.dataset.action === 'edit') {
      editing = { name, text: labelOf(name) };
      render();
    }
  });

  listEl.addEventListener('input', (event) => {
    if (editing && event.target instanceof HTMLInputElement) {
      editing.text = event.target.value;
    }
  });

  listEl.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) {
      if (!editing) {
        return;
      }
      if (event.key === 'Enter') {
        const text = editing.text.trim();
        const name = editing.name;
        editing = null;
        if (text) {
          // The host's state message is what redraws the row.
          send({ type: 'editTask', name, text });
        } else {
          render();
        }
      } else if (event.key === 'Escape') {
        editing = null;
        render();
      }
      return;
    }

    // Tab reaches the row's own buttons, and Enter there must press the button
    // rather than mean the list's Enter.
    if (event.target instanceof HTMLElement && event.target.closest('.task-action')) {
      return;
    }

    // A row has focus. Every move is `selected = ...; render()` — render is what
    // moves focus and scrolls, so highlight, focus and scroll are one path.
    const index = state.tasks.findIndex((task) => task.name === selected);
    const task = index === -1 ? null : state.tasks[index];
    const moveTo = (i) => {
      // Clamped rather than wrapped: the ends of a to-do list are landmarks.
      const next = state.tasks[Math.max(0, Math.min(i, state.tasks.length - 1))];
      if (next) {
        selected = next.name;
        render();
      }
    };

    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(index + 1);
        break;
      case 'ArrowUp':
        moveTo(index - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(state.tasks.length - 1);
        break;
      case 'Enter':
        if (task && !task.generating) {
          send({ type: 'generatePlan', name: task.name });
        }
        break;
      case 'F2':
        if (task) {
          editing = { name: task.name, text: task.label };
          render();
        }
        break;
      case 'Delete':
        // The host asks before unlinking, so this needs no confirm of its own.
        if (task) {
          send({ type: 'deleteTask', name: task.name });
        }
        break;
      default:
        handled = false;
    }

    // Or the sidebar scrolls out from under the selection.
    if (handled) {
      event.preventDefault();
    }
  });

  // ---------- generate ----------

  generateEl.addEventListener('click', () => {
    if (selected) {
      send({ type: 'generatePlan', name: selected });
    }
  });

  // ---------- host ----------

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'state') {
      return;
    }
    const wasAt = state.tasks.findIndex((task) => task.name === selected);
    state = { tasks: Array.isArray(message.tasks) ? message.tasks : [] };

    // A task that has gone — planned, or deleted from another window — must not
    // leave an edit box behind for a row that no longer exists.
    const active = editing;
    if (active && !state.tasks.some((task) => task.name === active.name)) {
      editing = null;
    }

    // The highlight keeps its place rather than its name: a finished generate
    // deletes its own task, and the next one should land under the highlight.
    if (selected && !state.tasks.some((task) => task.name === selected)) {
      const next = state.tasks[Math.min(Math.max(wasAt, 0), state.tasks.length - 1)];
      selected = next ? next.name : null;
    }
    render();
  });

  send({ type: 'ready' });
})();

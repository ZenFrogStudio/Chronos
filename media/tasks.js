// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const listEl = /** @type {HTMLElement} */ (document.getElementById('task-list'));
  const emptyEl = /** @type {HTMLElement} */ (document.getElementById('empty'));
  const inputEl = /** @type {HTMLInputElement} */ (document.getElementById('task-input'));
  const addEl = /** @type {HTMLElement} */ (document.getElementById('add-task'));

  /** @type {{tasks: {name: string, label: string, generating: boolean}[]}} */
  let state = { tasks: [] };

  /** The row being edited and what has been typed into it. Held here, never read
   *  back off the DOM — a state message rebuilds the list, and that must never
   *  be able to lose what you typed. */
  let editing = /** @type {{name: string, text: string}|null} */ (null);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const send = (message) => vscode.postMessage(message);
  const labelOf = (name) => (state.tasks.find((task) => task.name === name) || { label: '' }).label;

  // ---------- rendering ----------

  function render() {
    listEl.innerHTML = state.tasks.map(taskRow).join('');
    emptyEl.hidden = state.tasks.length > 0;

    const edit = listEl.querySelector('.task-edit');
    if (edit instanceof HTMLInputElement) {
      edit.focus();
      edit.setSelectionRange(edit.value.length, edit.value.length);
    }
  }

  function taskRow(task) {
    // A task is addressed by file name alone — no path from here ever reaches
    // the filesystem, which is what lets the host guard every read and write.
    const dotTitle = task.generating ? 'A planning session is open for this task' : 'Captured';
    const dot = `<span class="task-dot${task.generating ? ' is-generating' : ''}" title="${dotTitle}"></span>`;

    const body =
      editing && editing.name === task.name
        ? `<input class="task-edit" type="text" value="${esc(editing.text)}" aria-label="Edit task" />`
        : `<span class="task-label" title="${esc(task.label)}">${esc(task.label)}</span>`;

    return `<div class="task-row" data-name="${esc(task.name)}">
      ${dot}
      ${body}
      <span class="task-actions">
        <button class="task-action" type="button" data-action="generate"
          title="Generate plan..." aria-label="Generate a plan from ${esc(task.label)}">
          <i class="codicon codicon-lightbulb"></i>
        </button>
        <button class="task-action" type="button" data-action="edit"
          title="Edit task" aria-label="Edit ${esc(task.label)}">
          <i class="codicon codicon-pencil"></i>
        </button>
        <button class="task-action is-danger" type="button" data-action="delete"
          title="Delete task" aria-label="Delete ${esc(task.label)}">
          <i class="codicon codicon-trash"></i>
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
    const button = target && target.closest('.task-action');
    const row = button instanceof HTMLElement ? button.closest('.task-row') : null;
    const name = row instanceof HTMLElement ? row.dataset.name : '';
    if (!(button instanceof HTMLElement) || !name) {
      return;
    }

    if (button.dataset.action === 'generate') {
      send({ type: 'generatePlan', name });
    } else if (button.dataset.action === 'delete') {
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
    if (!editing || !(event.target instanceof HTMLInputElement)) {
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
  });

  // ---------- host ----------

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'state') {
      return;
    }
    state = { tasks: Array.isArray(message.tasks) ? message.tasks : [] };

    // A task that has gone — planned, or deleted from another window — must not
    // leave an edit box behind for a row that no longer exists.
    const active = editing;
    if (active && !state.tasks.some((task) => task.name === active.name)) {
      editing = null;
    }
    render();
  });

  send({ type: 'ready' });
})();

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { jobState } from './history';
import { enabledPlanSteps, generateCommand, shellKind } from './launch';
import * as library from './library';
import { log } from './log';
import { createNonce, Manager } from './manager';
import { ChronosPaths } from './roots';
import { Scheduler } from './scheduler';
import { createSeries } from './series';
import { Store } from './store';

/**
 * The activity-bar view: a task inbox.
 *
 * It exists at all because VS Code only draws an activity-bar icon for a view
 * container, and a container must hold at least one view — there is no "icon
 * runs a command" API. So the clock icon costs us a panel either way, and the
 * only real question is what goes in it. Two rows duplicating the status bar and
 * the manager was the wrong answer; this is the front of the pipeline the
 * manager does not have — capture, before generate, schedule and run.
 *
 * A task is a `.md` file in the active folder's `.chronos/tasks/`. No new store
 * and no schema bump: `library.ts` is already parameterised by directory,
 * `listPlans` skips subdirectories so `tasks/` never shows up as a plan, and a
 * task survives a state reset because it is just a file. The inbox is therefore
 * per-folder for free — it is whatever `.chronos/tasks/` holds.
 *
 * It is a webview rather than a tree because a to-do list needs an always-there
 * text field, in-body buttons and coloured rows, none of which the TreeView API
 * can draw. The cost is that this view is no longer a native drop target — a
 * tree got real `Uri`s from the explorer and the OS shell, a webview cannot —
 * so drops go to the manager pane, and **Schedule with Chronos** and the file
 * picker are unchanged.
 *
 * Generating a plan from a task is an *authoring* session, deliberately outside
 * the scheduler: a real terminal you can talk to, with no concurrency slot, no
 * run record and no transcript. The plan is written to a per-session staging
 * folder under a name Claude chooses — it knows what the plan does, where a name
 * guessed from the task text only ever repeats the request — and is adopted into
 * the library from there. The plan landing in the library is still what marks
 * the task finished.
 *
 * **Run** is the opposite route, for the one-line chore that does not need a plan
 * written for it: the ordinary scheduled path, fired at once, with the task's own
 * text as the prompt and no plan in between. Unattended, in `auto` mode, with a
 * run record and a transcript like any other job — the task simply stays in the
 * inbox until it finishes, and only a completed run clears it.
 */

/** A row in the inbox. `name` is the file name, which is its identity. */
export interface InboxTask {
  name: string;
  filePath: string;
  label: string;
}

/** Messages the webview may send. Anything else is logged and ignored. */
type Inbound =
  | { type: 'ready' }
  | { type: 'addTask'; text: string }
  | { type: 'editTask'; name: string; text: string }
  | { type: 'deleteTask'; name: string }
  | { type: 'generatePlan'; name: string }
  | { type: 'runTask'; name: string };

/** A planning session in flight: its staging folder and the task that asked. */
interface PendingPlan {
  taskName: string;
  dir: string;
  watcher: vscode.FileSystemWatcher;
  /** The tab the session is being held in. Its closing is what ends the session. */
  terminal: vscode.Terminal;
}

export class TaskView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'chronos.tasks';

  private view: vscode.WebviewView | undefined;
  /**
   * Session id → the session. Held in memory only: if the window reloads
   * mid-session the plan simply stays in its staging folder and the task is not
   * cleared. Nothing is destroyed either way, and a persisted map would be a
   * second source of truth about work we cannot see.
   */
  private readonly awaitingPlan = new Map<string, PendingPlan>();

  /**
   * Task file name → the series a Run launched for it. Held in memory only, for
   * the same reason as `awaitingPlan`: a window reload loses the link, the run
   * carries on in the manager, and the task is simply left in the inbox rather
   * than cleared.
   */
  private readonly running = new Map<string, string>();

  /**
   * Closing the planning terminal is the only end-of-session signal VS Code
   * offers, and without it a session backed out of holds its row amber for the
   * life of the window.
   */
  private readonly terminals = vscode.window.onDidCloseTerminal((terminal) =>
    this.onTerminalClosed(terminal)
  );

  /**
   * How a finished job clears its task. Assigned in the constructor body rather
   * than here: `tsconfig.json` targets ES2022, so field initialisers run before
   * the parameter properties below are assigned, and `this.store` would be
   * `undefined` at this point.
   */
  private readonly runs: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** The active folder's layout. A thunk, so switching folders re-points the
     *  inbox without rebuilding the view. */
    private readonly paths: () => ChronosPaths,
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    private readonly manager: Manager
  ) {
    this.runs = this.store.onDidChange(() => this.settleRuns());
  }

  dispose(): void {
    this.terminals.dispose();
    this.runs.dispose();
    // Over a copy of the keys, because `discard` deletes from the map it is
    // iterating.
    for (const id of [...this.awaitingPlan.keys()]) {
      this.discard(id);
    }
  }

  ///////////////////////////*The view*////////////////////////////

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage((message: Inbound) => {
      this.handle(message).catch((err) => {
        log.error('task view message failed', err);
        void vscode.window.showWarningMessage(String(err instanceof Error ? err.message : err));
      });
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });

    // The closest thing VS Code offers to "the activity-bar icon was clicked":
    // this view resolving or becoming visible is the only signal that click
    // produces. Focus stays in the sidebar — the click aimed there, and the
    // manager is the bonus.
    this.manager.open(true);
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.manager.open(true);
      }
    });
  }

  /** Sends the whole list. Cheap, and the only shape the webview understands —
   *  the list is a few rows and rebuilding it is free. */
  private post(): void {
    if (!this.view) {
      return;
    }
    const pending = new Set([...this.awaitingPlan.values()].map((p) => p.taskName));

    this.view.webview.postMessage({
      type: 'state',
      tasks: this.list().map((task) => ({
        name: task.name,
        label: task.label,
        generating: pending.has(task.name),
        running: this.running.has(task.name)
      }))
    });
  }

  private list(): InboxTask[] {
    return library.listPlans(this.paths().tasks).map((file) => ({
      name: file.name,
      filePath: file.filePath,
      label: library.taskLabel(readOrEmpty(file.filePath))
    }));
  }

  private render(webview: vscode.Webview): string {
    const mediaUri = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'tasks.html').fsPath;

    return fs
      .readFileSync(htmlPath, 'utf8')
      .replaceAll('{{nonce}}', createNonce())
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{styleUri}}', mediaUri('tasks.css'))
      .replaceAll('{{codiconUri}}', mediaUri('codicon.css'))
      .replaceAll('{{scriptUri}}', mediaUri('tasks.js'));
  }

  ///////////////////////////*Messages*////////////////////////////

  private async handle(message: Inbound): Promise<void> {
    const dir = this.paths().tasks;

    switch (message.type) {
      case 'ready':
        this.post();
        return;

      case 'addTask': {
        // The untrusted side of the boundary, so the text is checked here rather
        // than trusting the field's own guard. The file name is derived from it
        // by `toPlanFileName`, which sanitises.
        const text = cleanText(message.text);
        if (!text) {
          return;
        }
        const task = library.createPlan(dir, text, `${text}\n`);
        log.info(`captured task ${task.name}`);
        this.post();
        return;
      }

      case 'editTask': {
        const text = cleanText(message.text);
        if (!text) {
          return;
        }
        // The file name is not shown anywhere, so it is left as first written
        // rather than renamed to chase the text — a rename would only risk
        // losing the file.
        library.writePlan(dir, message.name, `${text}\n`);
        this.post();
        return;
      }

      // Always asks: this sits on a hover-height button where a misclick costs
      // the row. The file itself survives, in the folder's archive.
      case 'deleteTask': {
        const task = this.list().find((t) => t.name === message.name);
        if (!task) {
          this.post();
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Archive "${firstLine(task.label)}"?`,
          { modal: true, detail: 'The file moves to .chronos/archive.' },
          'Archive'
        );
        if (!choice) {
          return;
        }
        library.archivePlan(dir, this.paths().archivedTasks, task.name);
        this.post();
        return;
      }

      case 'generatePlan': {
        const task = this.list().find((t) => t.name === message.name);
        if (task) {
          await this.generatePlan(task);
        }
        // After, not before: this is what lights the row's dot amber.
        this.post();
        return;
      }

      case 'runTask': {
        const task = this.list().find((t) => t.name === message.name);
        if (task) {
          await this.runTask(task);
        }
        this.post();
        return;
      }

      default:
        log.warn(`ignored an unknown task view message: ${JSON.stringify(message)}`);
    }
  }

  ///////////////////////////*Task editing*////////////////////////////

  /** The command-palette route in. The view's own field is the usual one. */
  async addTask(): Promise<void> {
    const text = await askForTask('What needs doing?', '');
    if (!text) {
      return;
    }
    const task = library.createPlan(this.paths().tasks, text, `${text}\n`);
    log.info(`captured task ${task.name}`);
    this.post();
  }

  ///////////////////////////*Plan generation*////////////////////////////

  /**
   * Opens an interactive plan-mode session that turns a task into a real plan in
   * the library. Backing out at any point — Esc, closing the terminal, never
   * approving — leaves the task exactly where it was and creates nothing.
   */
  private async generatePlan(task: InboxTask): Promise<void> {
    if (!fs.existsSync(task.filePath)) {
      void vscode.window.showWarningMessage('That task no longer exists.');
      return;
    }

    const config = vscode.workspace.getConfiguration('chronos');
    // Read, never asked: the answer was the same one as last time almost every
    // time, and a prompt on the fastest path in the product — capture, press the
    // lightbulb, start talking — is friction for a choice that rarely changes.
    // It is set on the manager's Settings page instead.
    const model = config.get<string>('planModel', '');

    const paths = this.paths();
    // The active folder, with nothing to ask about: a task now belongs to a
    // folder rather than to one machine-wide inbox, so the folder it was
    // captured in is the folder it is planned against.
    const cwd = paths.folder;

    // Created rather than reserved: Claude needs somewhere to write, and an
    // empty folder left behind by a cancelled session costs nothing and is
    // cleaned up on dispose. The plan is named by Claude inside this folder,
    // then adopted into the library under a sanitised name.
    const sessionId = randomBytes(6).toString('hex');
    const sessionDir = path.join(paths.pending, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const command = generateCommand({
      exe: config.get<string>('claudePath', 'claude'),
      sourcePath: task.filePath,
      destDir: sessionDir,
      // One grant covers task, staging folder and library, since all three are
      // inside the folder's `.chronos` root.
      allowDir: paths.root,
      model: model || undefined,
      shell: shellKind(vscode.env.shell, process.platform),
      // What the plan is asked to do once the work itself is done, so an
      // overnight run does not finish with an untracked working tree.
      steps: enabledPlanSteps((key, fallback) => config.get<boolean>(key, fallback))
    });

    // Scoped to this session's folder, so a landed file needs no guessing about
    // which session produced it. Non-recursive; disposed the moment it fires.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(sessionDir, '*.md'),
      false,
      true,
      true
    );
    watcher.onDidCreate((uri) => {
      this.onPlanLanded(sessionId, uri).catch((err) =>
        log.error('adopting a generated plan failed', err)
      );
    });
    // Before the map entry, so the entry can carry the terminal that ends the
    // session. Nothing is running until `sendText` below, so there is no window
    // here in which a plan could land ahead of the entry that would adopt it.
    const terminal = vscode.window.createTerminal({
      name: `Chronos: plan ${firstLine(task.label).slice(0, 40)}`,
      cwd,
      iconPath: new vscode.ThemeIcon('lightbulb')
    });
    this.awaitingPlan.set(sessionId, { taskName: task.name, dir: sessionDir, watcher, terminal });

    // Focus, unlike a scheduled run: you pressed a button and are about to type.
    terminal.show();
    terminal.sendText(command);
    log.info(`opened a planning session for task ${task.name} in ${cwd}`);
  }

  /**
   * The end of a planning session. The signal is the *tab* closing rather than
   * the CLI exiting: Chronos types `claude ...` into your own shell, so quitting
   * Claude only returns you to a prompt, and while that prompt is there the
   * session is genuinely resumable — the row staying amber until the tab goes is
   * the honest answer.
   *
   * A plan sitting in the staging folder means the session finished and the
   * watcher missed the event, so it is adopted exactly as it would have been.
   * Otherwise the session was backed out of: it is discarded, the task is left
   * untouched, and the whole of the notice is one log line, because closing a
   * terminal you meant to close is not news.
   */
  private onTerminalClosed(terminal: vscode.Terminal): void {
    const found = [...this.awaitingPlan.entries()].find(([, p]) => p.terminal === terminal);
    if (!found) {
      return; // Almost every terminal closed in a window is not one of ours.
    }
    const [sessionId, pending] = found;

    const [landed] = library.listPlans(pending.dir);
    if (landed) {
      this.onPlanLanded(sessionId, vscode.Uri.file(landed.filePath)).catch((err) =>
        log.error('adopting a generated plan failed', err)
      );
      return;
    }

    this.discard(sessionId);
    log.info(`planning session for task ${pending.taskName} was abandoned; the task is unchanged`);
    this.post();
  }

  /**
   * Forgets a session and takes its staging folder with it. Safe to call for an
   * id that is already gone, which is what makes the two ways a session can end
   * — a plan landing and the terminal closing — free of any race: `onPlanLanded`
   * deletes its entry before its first `await`, so whichever arrives second
   * finds nothing and returns.
   */
  private discard(sessionId: string): void {
    const pending = this.awaitingPlan.get(sessionId);
    if (!pending) {
      return;
    }
    this.awaitingPlan.delete(sessionId);
    pending.watcher.dispose();
    fs.rmSync(pending.dir, { recursive: true, force: true });
  }

  /**
   * A file appearing in the session's staging folder is the completion signal —
   * there is no other one. The CLI exits when *you* close it, long after the
   * plan is written, and its exit code says nothing about whether you approved
   * anything. The plan is then adopted into the library from there.
   */
  private async onPlanLanded(sessionId: string, uri: vscode.Uri): Promise<void> {
    const pending = this.awaitingPlan.get(sessionId);
    if (!pending) {
      return;
    }
    this.awaitingPlan.delete(sessionId);
    pending.watcher.dispose();

    await settled(uri.fsPath);

    const paths = this.paths();
    let plan: library.PlanFile;
    try {
      // The same door every outside file comes through: it slugs the name Claude
      // chose and de-duplicates it, so a colliding choice cannot overwrite a plan.
      plan = library.importFile(paths.plans, uri.fsPath);
    } catch (err) {
      // The plan exists in the staging folder, so leave both it and the task
      // alone rather than clearing a task whose plan never reached the library.
      log.error(`could not adopt the plan from ${pending.dir}`, err);
      void vscode.window.showWarningMessage(
        `Chronos could not move the generated plan into your library. It is still in ${pending.dir}.`
      );
      return;
    }
    fs.rmSync(pending.dir, { recursive: true, force: true });

    try {
      library.removePlan(paths.tasks, pending.taskName);
      log.info(`plan ${plan.name} landed; cleared task ${pending.taskName}`);
    } catch (err) {
      // The plan is written and that is the part that mattered; a task the user
      // already deleted by hand must not turn this into an error notice.
      log.warn(`could not clear task ${pending.taskName}: ${String(err)}`);
    }

    this.post();
    this.manager.open();
    this.manager.reveal(plan.name);
  }

  ///////////////////////////*Running a task*////////////////////////////

  /**
   * Runs a task's own text as the prompt, at once and unattended — no plan
   * written for it, because a one-line chore does not need one and an
   * interactive planning session for it is friction on the fastest path in the
   * product. Everything downstream is the ordinary scheduled path: a series, a
   * run record, a transcript, and the same concurrency budget.
   */
  private async runTask(task: InboxTask): Promise<void> {
    if (!fs.existsSync(task.filePath)) {
      void vscode.window.showWarningMessage('That task no longer exists.');
      return;
    }
    if (this.running.has(task.name)) {
      return; // Already in flight. The button is disabled; the keyboard is not.
    }
    // Checked here rather than left to `runNow`, which only logs: a button that
    // silently does nothing is worse than one that says why.
    if (!this.scheduler.leading) {
      void vscode.window.showWarningMessage(
        `Another window is open on this same folder (${path.basename(this.paths().folder)}) ` +
          'and is running its schedule. Run this from that window, or close it.'
      );
      return;
    }

    const paths = this.paths();
    // The same door every outside file comes through, and what keeps
    // `consolidate`'s invariant true: a series may only point into the library.
    const plan = library.importFile(paths.plans, task.filePath);

    const series = createSeries(plan.filePath, {
      // The folder the task was captured in is the folder it runs against — the
      // same rule the planning session uses.
      cwd: paths.folder,
      // Stated rather than left to the default, because this is the whole of what
      // "run it in auto mode" means and it should not move if the default does.
      permissionMode: 'auto',
      // `createSeries` dates a new series an hour out. Without this the job would
      // run now *and* again in an hour, from a plan the user never scheduled.
      spent: true,
      // You pressed Run and are watching. A retry an hour later, of a prompt that
      // was never reviewed as a plan, is not what that button promised.
      maxRetries: 0
    });
    await this.store.addSeries(series);

    // Before `runNow`, so the first store change it causes already finds the link.
    this.running.set(task.name, series.id);
    await this.scheduler.runNow(series.id);
    log.info(`running task ${task.name} directly as ${plan.name} in ${paths.folder}`);

    // Focus stays in the sidebar — you pressed a button here, and the manager is
    // where the run and its transcript will appear.
    this.manager.open(true);
    this.manager.reveal(plan.name);
  }

  /**
   * Clears the tasks whose jobs have finished. A completed run means the task is
   * done, so its file goes; anything else leaves the task where it was, because a
   * failed run has not done the work and the row is the only thing that would
   * remind you.
   */
  private settleRuns(): void {
    if (!this.running.size) {
      return;
    }
    let changed = false;

    for (const [taskName, seriesId] of [...this.running]) {
      const state = jobState(this.store.getRunsForSeries(seriesId));
      if (state === 'in-flight') {
        continue;
      }
      this.running.delete(taskName);
      changed = true;

      if (state === 'completed') {
        try {
          library.removePlan(this.paths().tasks, taskName);
          log.info(`run for task ${taskName} completed; cleared the task`);
        } catch (err) {
          // A task already deleted by hand must not turn this into an error notice.
          log.warn(`could not clear task ${taskName}: ${String(err)}`);
        }
      } else {
        log.info(`run for task ${taskName} did not complete; the task stays in the inbox`);
      }
    }

    if (changed) {
      this.post();
    }
  }
}

///////////////////////////*Prompts*////////////////////////////

/** A task is one line. Anything blank is a stray Enter, not an instruction. */
function cleanText(text: unknown): string {
  return typeof text === 'string' ? text.trim() : '';
}

function askForTask(prompt: string, value: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    placeHolder: 'e.g. Add an interval repeat option to the scheduler',
    validateInput: (input) => (input.trim() ? undefined : 'Describe the task in a line.')
  });
}

/** The label as a title: the sidebar row is several lines, a terminal name and
 *  a modal's question are one. */
function firstLine(label: string): string {
  return label.split('\n')[0];
}

function readOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    // A task deleted between listing and reading is not worth failing the view for.
    return '';
  }
}

/**
 * Waits for a just-created file to stop growing. The create event can arrive
 * before the CLI has finished writing, and copying a half-written plan into the
 * library would be worse than waiting two seconds. Gives up rather than hanging:
 * whatever is on disk by then is what gets adopted.
 */
async function settled(filePath: string): Promise<void> {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt++) {
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    if (size > 0 && size === previous) {
      return;
    }
    previous = size;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateCommand, shellKind } from './launch';
import * as library from './library';
import { log } from './log';
import { Manager, toFsPath } from './manager';
import { CLAUDE_MODELS } from './agents';
import { defaultCwd } from './series';

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
 * A task is a `.md` file in `<library>/tasks/`. No new store and no schema bump:
 * `library.ts` is already parameterised by directory, `listPlans` skips
 * subdirectories so `tasks/` never shows up as a plan, and a task survives a
 * state reset because it is just a file.
 *
 * Generating a plan from a task is an *authoring* session, deliberately outside
 * the scheduler: a real terminal you can talk to, with no concurrency slot, no
 * run record and no transcript. The plan landing in the library is what marks it
 * finished.
 */

/** A row in the inbox. `name` is the file name, which is its identity. */
export interface InboxTask {
  name: string;
  filePath: string;
  label: string;
}

/** Where tasks live, relative to the plan library that contains them. */
export function tasksDirIn(libraryDir: string): string {
  return path.join(libraryDir, 'tasks');
}

export class TaskListView implements vscode.TreeDataProvider<InboxTask>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private readonly libraryWatcher: vscode.FileSystemWatcher;
  /**
   * Destination file name → the task that asked for it, for sessions still open.
   * Held in memory only: if the window reloads mid-session the plan still lands,
   * the task simply is not auto-deleted. Nothing is destroyed either way, and a
   * persisted map would be a second source of truth about work we cannot see.
   */
  private readonly awaitingPlan = new Map<string, string>();

  constructor(
    private readonly libraryPath: () => string,
    private readonly manager: Manager
  ) {
    // Non-recursive by design: `*.md` matches the library root only, so writes
    // inside `tasks/` never look like a finished plan.
    this.libraryWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.libraryPath(), '*.md'),
      false,
      true,
      true
    );
    this.libraryWatcher.onDidCreate((uri) => this.onPlanLanded(uri));
  }

  dispose(): void {
    this.libraryWatcher.dispose();
    this.changed.dispose();
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(task: InboxTask): vscode.TreeItem {
    const node = new vscode.TreeItem(task.label);
    node.iconPath = new vscode.ThemeIcon('circle-outline');
    node.tooltip = task.label;
    // Bound by `viewItem == task` in package.json, which is what puts the
    // inline lightbulb/pencil/trash on the row.
    node.contextValue = 'task';
    node.command = { command: 'chronos.editTask', title: 'Edit Task', arguments: [task] };
    return node;
  }

  getChildren(): InboxTask[] {
    const dir = tasksDirIn(this.libraryPath());
    return library.listPlans(dir).map((file) => ({
      name: file.name,
      filePath: file.filePath,
      label: library.taskLabel(readOrEmpty(file.filePath))
    }));
  }

  ///////////////////////////*Task editing*////////////////////////////

  async addTask(): Promise<void> {
    const text = await askForTask('What needs doing?', '');
    if (!text) {
      return;
    }
    const dir = tasksDirIn(this.libraryPath());
    const task = library.createPlan(dir, text, `${text}\n`);
    log.info(`captured task ${task.name}`);
    this.refresh();
  }

  async editTask(task: InboxTask): Promise<void> {
    const current = readOrEmpty(task.filePath);
    const text = await askForTask('Edit this task', library.taskLabel(current));
    if (!text) {
      return;
    }
    // The file name is not shown anywhere, so it is left as first written rather
    // than renamed to chase the text — a rename would only risk losing the file.
    library.writePlan(tasksDirIn(this.libraryPath()), task.name, `${text}\n`);
    this.refresh();
  }

  /** Always asks: `removePlan` unlinks rather than recycling, and this sits on a
   *  hover-height X where a misclick costs the file. */
  async deleteTask(task: InboxTask): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Delete "${task.label}"?`,
      { modal: true, detail: 'The file is deleted, not moved to the recycle bin.' },
      'Delete'
    );
    if (!choice) {
      return;
    }
    library.removePlan(tasksDirIn(this.libraryPath()), task.name);
    this.refresh();
  }

  ///////////////////////////*Plan generation*////////////////////////////

  /**
   * Opens an interactive plan-mode session that turns a task into a real plan in
   * the library. Backing out at any point — Esc, closing the terminal, never
   * approving — leaves the task exactly where it was and creates nothing.
   */
  async generatePlan(task: InboxTask): Promise<void> {
    if (!fs.existsSync(task.filePath)) {
      void vscode.window.showWarningMessage('That task no longer exists.');
      this.refresh();
      return;
    }

    const config = vscode.workspace.getConfiguration('chronos');
    const model = await pickModel(config.get<string>('planModel', ''));
    if (model === undefined) {
      return;
    }
    await config.update('planModel', model, vscode.ConfigurationTarget.Global);

    const cwd = await pickWorkingDirectory(task.filePath);
    if (!cwd) {
      return;
    }

    const libraryDir = this.libraryPath();
    // Reserved, not created: nothing is written unless you approve a plan, and a
    // zero-byte file left behind by a cancelled session would be worse than none.
    const destName = library.uniqueName(
      library.listPlans(libraryDir).map((p) => p.name),
      library.toPlanFileName(task.label)
    );
    const destPath = path.join(libraryDir, destName);

    const command = generateCommand({
      exe: config.get<string>('claudePath', 'claude'),
      sourcePath: task.filePath,
      destPath,
      // One grant covers both files, since `tasks/` is inside the library.
      allowDir: libraryDir,
      model: model || undefined,
      shell: shellKind(vscode.env.shell, process.platform)
    });

    this.awaitingPlan.set(destName.toLowerCase(), task.name);

    const terminal = vscode.window.createTerminal({
      name: `Chronos: plan ${library.titleOf(destName)}`,
      cwd,
      iconPath: new vscode.ThemeIcon('lightbulb')
    });
    // Focus, unlike a scheduled run: you pressed a button and are about to type.
    terminal.show();
    terminal.sendText(command);
    log.info(`opened a planning session for task ${task.name} → ${destName} in ${cwd}`);
  }

  /**
   * The destination file appearing is the completion signal — there is no other
   * one. The CLI exits when *you* close it, long after the plan is written, and
   * its exit code says nothing about whether you approved anything.
   */
  private onPlanLanded(uri: vscode.Uri): void {
    const key = path.basename(uri.fsPath).toLowerCase();
    const taskName = this.awaitingPlan.get(key);
    if (!taskName) {
      return;
    }
    this.awaitingPlan.delete(key);

    try {
      library.removePlan(tasksDirIn(this.libraryPath()), taskName);
      log.info(`plan ${key} landed; cleared task ${taskName}`);
    } catch (err) {
      // The plan is written and that is the part that mattered; a task the user
      // already deleted by hand must not turn this into an error notice.
      log.warn(`could not clear task ${taskName}: ${String(err)}`);
    }

    this.refresh();
    this.manager.open();
    this.manager.reveal(path.basename(uri.fsPath));
  }
}

///////////////////////////*Prompts*////////////////////////////

function askForTask(prompt: string, value: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    placeHolder: 'e.g. Add an interval repeat option to the scheduler',
    validateInput: (input) => (input.trim() ? undefined : 'Describe the task in a line.')
  });
}

/**
 * `showQuickPick` cannot preselect, and the remembered model is the answer most
 * of the time — so this uses the builder form purely to set `activeItems`.
 * Resolves to undefined when dismissed, which is distinct from '' meaning the
 * account default.
 */
function pickModel(remembered: string): Promise<string | undefined> {
  type ModelItem = vscode.QuickPickItem & { value: string };
  const items: ModelItem[] = CLAUDE_MODELS.map((m) => ({ label: m.label, value: m.value }));

  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<ModelItem>();
    picker.title = 'Generate plan';
    picker.placeholder = 'Which model should plan this task?';
    picker.items = items;
    picker.activeItems = items.filter((item) => item.value === remembered);
    picker.onDidAccept(() => {
      resolve(picker.selectedItems[0]?.value);
      picker.hide();
    });
    picker.onDidHide(() => {
      resolve(undefined);
      picker.dispose();
    });
    picker.show();
  });
}

/**
 * Where Claude runs while planning. A task file lives in the library, outside
 * every workspace folder, so `defaultCwd` would silently pick `folders[0]` on a
 * multi-root workspace — asking is the only honest option there.
 */
async function pickWorkingDirectory(taskPath: string): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Which folder should Claude plan against?'
    });
    return picked?.uri.fsPath;
  }
  return defaultCwd(taskPath);
}

function readOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    // A task deleted between listing and reading is not worth failing the view for.
    return '';
  }
}

///////////////////////////*Drop target*////////////////////////////

/**
 * Schedules `.md` files dropped onto this view, in place.
 *
 * This must live extension-side. VS Code disables mouse interaction over a
 * webview mid-drag (microsoft/vscode#182449), so a drag from the explorer never
 * reaches the manager unless you hold Shift, and a sandboxed webview can no
 * longer learn a dropped file's path either — Electron 32 removed `File.path`.
 * A tree's drop handler receives real `Uri`s from both the explorer and the OS
 * shell, which is why this view contributes no `viewsWelcome`: welcome content
 * cannot accept a drop, and the empty body has to stay a drop target.
 */
export class PlanDropController implements vscode.TreeDragAndDropController<InboxTask> {
  // 'files' covers the OS shell, 'text/uri-list' the VS Code explorer.
  readonly dropMimeTypes = ['text/uri-list', 'files'];
  readonly dragMimeTypes: string[] = [];

  constructor(private readonly manager: Manager) {}

  async handleDrop(
    _target: InboxTask | undefined,
    data: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    const paths = await this.readPaths(data);
    if (token.isCancellationRequested || !paths.length) {
      return;
    }
    // Open first, so the manager's inline notice about rejected files lands
    // somewhere the user can see it.
    this.manager.open();
    await this.manager.addPaths(paths);
  }

  private async readPaths(data: vscode.DataTransfer): Promise<string[]> {
    const list = await data.get('text/uri-list')?.asString();
    if (list) {
      return library.parseUriList(list).map(toFsPath);
    }

    // OS shell drops arrive as transfer items instead; `DataTransferFile.uri`
    // is populated on desktop, which is the only place Chronos runs a shell.
    const paths: string[] = [];
    data.forEach((item) => {
      const uri = item.asFile()?.uri;
      if (uri) {
        paths.push(uri.fsPath);
      }
    });

    if (!paths.length) {
      log.warn('a drop on the task view carried no file paths');
    }
    return paths;
  }
}

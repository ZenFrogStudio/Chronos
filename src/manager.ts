import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildActivity } from './activity';
import { AGENTS, agentFor, DEFAULT_AGENT } from './agents';
import { consolidate } from './consolidate';
import { seriesEdit } from './edit';
import * as library from './library';
import { log, logConsolidation } from './log';
import { generateCommand, shellKind } from './launch';
import { ChronosPaths } from './roots';
import { Scheduler } from './scheduler';
import { createSeries, defaultCwd } from './series';
import { Store } from './store';
import { AgentId, TaskSeries } from './types';

/** Messages the webview may send. Anything else is logged and ignored. */
type Inbound =
  | { type: 'ready' }
  | { type: 'drop'; items: string[] }
  | { type: 'dropText'; files: { name: string; text: string }[] }
  | { type: 'createPlan' }
  | { type: 'renamePlan'; name: string }
  | { type: 'deletePlan'; name: string }
  | { type: 'loadPlan'; name: string }
  | { type: 'savePlan'; name: string; text: string }
  | { type: 'openInEditor'; name: string }
  | { type: 'importPlan' }
  | { type: 'revealLibrary' }
  | { type: 'schedulePlan'; name: string }
  | { type: 'updateSeries'; id: string; patch: Partial<TaskSeries> }
  | { type: 'removeSeries'; id: string }
  | { type: 'browseCwd'; id: string }
  | { type: 'generatePlan'; name: string; seriesId?: string }
  | { type: 'runNow'; seriesId: string; dismissRunId?: string }
  | { type: 'cancelRun'; id: string }
  | { type: 'dismissRun'; id: string }
  | { type: 'openResult'; id: string }
  | { type: 'revealResults' }
  | { type: 'openLog'; id: string }
  | { type: 'switchFolder'; folder: string };

/**
 * The plan manager: a single editor-tab webview. Deliberately one panel reused
 * rather than one per invocation — every extra surface is another renderer to
 * keep in memory and in sync.
 *
 * `retainContextWhenHidden` is *not* set. It is the easy option and it holds the
 * whole view in memory for the session; the serializer below restores the tab
 * across reloads instead, and re-rendering a list this size is free.
 */
export class Manager implements vscode.Disposable {
  static readonly viewType = 'chronos.manager';

  private panel: vscode.WebviewPanel | undefined;
  private watcher: fs.FSWatcher | undefined;
  private watchDebounce: NodeJS.Timeout | undefined;
  private readonly storeListener: vscode.Disposable;
  private readonly leadershipListener: vscode.Disposable;
  /** Sticky, unlike a notice: a broken `claudePath` stays broken until fixed. */
  private setupProblem: string | undefined;
  /** Engines that answered `--version`. Optimistic until the probes land, so
   *  the dropdown is never briefly empty. */
  private availableAgents: AgentId[] = [DEFAULT_AGENT];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    /** The active folder's layout. A thunk, so a folder switch needs no rebuild. */
    private readonly paths: () => ChronosPaths,
    /** Owned by `activate`, which is the only place that can move the store, the
     *  scheduler's lock and this panel together. */
    private readonly switchFolder: (folder: string) => Promise<void>
  ) {
    this.storeListener = store.onDidChange(() => this.post());
    // A non-leading window's store never changes, so the banner below would
    // otherwise never appear or clear.
    this.leadershipListener = scheduler.onDidChangeLeadership(() => this.post());
  }

  dispose(): void {
    this.storeListener.dispose();
    this.leadershipListener.dispose();
    this.stopWatching();
    this.panel?.dispose();
  }

  /**
   * Opens the manager, or reveals the tab that is already open. `preserveFocus`
   * is for callers the user did not aim at the manager — the activity-bar icon,
   * which reveals the Tasks view and this tab from one click.
   */
  open(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, preserveFocus);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      Manager.viewType,
      'Chronos',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] }
    );
    this.adopt(panel);
  }

  /**
   * Selects a plan in the library list. Public because the task view calls it
   * once a generated plan lands, so the pipeline ends where scheduling starts
   * rather than leaving you to find the new file yourself.
   */
  reveal(name: string): void {
    this.select(name);
  }

  /** Survives the panel not being open yet — `post()` replays it on reveal. */
  setSetupProblem(text: string): void {
    this.setupProblem = text;
    this.post();
  }

  /** What the Engine dropdown may offer. Set once the probes in `activate` land. */
  setAvailableAgents(ids: AgentId[]): void {
    this.availableAgents = ids;
    this.post();
  }

  /**
   * Copies Markdown files from any source into the library and schedules the
   * copies. Every route in — right-click, a drop on the activity-bar view, the
   * file picker — lands here, so no schedule can point outside the library and
   * the user's own file is never edited or moved by Chronos.
   */
  async addPaths(filePaths: string[]): Promise<void> {
    const dir = this.paths().plans;
    const markdown = filePaths.filter((p) => path.extname(p).toLowerCase() === '.md');
    const rejected = filePaths.length - markdown.length;
    const scheduled: string[] = [];

    for (const filePath of markdown) {
      const plan = library.importFile(dir, filePath);
      // `defaultCwd` reads the *original* path on purpose: it picks the workspace
      // folder containing the file, which is not necessarily the folder whose
      // library the copy lands in. A plan dropped in from another project keeps
      // running against that project.
      const series = createSeries(plan.filePath, { cwd: defaultCwd(filePath) });
      await this.store.addSeries(series);
      log.info(`copied ${filePath} into the library as ${plan.name} and scheduled it (cwd ${series.cwd})`);
      scheduled.push(plan.title);
    }

    this.post();

    if (scheduled.length) {
      this.notify(
        `Copied ${scheduled.join(', ')} into your library and scheduled the copy — ` +
          'your original file is untouched, and editing it will not change what runs.'
      );
    }
    if (rejected > 0) {
      this.notify(`Ignored ${rejected} non-Markdown file${rejected > 1 ? 's' : ''}.`);
    }
  }

  /** Re-attaches to a panel VS Code restored after a window reload. */
  restore(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    this.adopt(panel);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    // The tab icon is drawn as-is rather than masked, so the full-colour mark
    // survives here — unlike the activity bar, which flattens to a silhouette.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.render(panel.webview);

    panel.webview.onDidReceiveMessage((message: Inbound) => {
      this.handle(message).catch((err) => {
        log.error('manager message failed', err);
        this.notify(String(err instanceof Error ? err.message : err));
      });
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.stopWatching();
    });

    this.restartWatching();
  }

  // ---------- library watching ----------

  /**
   * Plans edited outside Chronos must not go stale in the manager. The webview
   * owns dirty state, so it decides whether to reload — this only reports that
   * something changed. One watcher covers every plan, because every plan lives
   * in this one folder.
   */
  restartWatching(): void {
    this.stopWatching();
    const dir = this.paths().plans;
    try {
      library.ensureLibrary(dir);
      this.watcher = fs.watch(dir, (_event, filename) => {
        clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          // Deleting a plan file in a file manager mid-session leaves a schedule
          // pointing at nothing, which would fire and fail on time forever. One
          // `existsSync` per series on a debounced event is cheap enough to just
          // check every time rather than work out which file went.
          void this.dropSchedulesWithNoFile(dir).then(() => {
            this.post();
            if (filename && library.isPlanFile(String(filename))) {
              this.panel?.webview.postMessage({ type: 'planChanged', name: String(filename) });
            }
          });
        }, 150);
      });
    } catch (err) {
      log.warn(`could not watch plan library: ${String(err)}`);
    }
  }

  private async dropSchedulesWithNoFile(dir: string): Promise<void> {
    logConsolidation(await consolidate(this.store, dir));
  }

  private stopWatching(): void {
    clearTimeout(this.watchDebounce);
    this.watcher?.close();
    this.watcher = undefined;
  }

  // ---------- messages ----------

  private async handle(message: Inbound): Promise<void> {
    const dir = this.paths().plans;

    switch (message.type) {
      case 'ready':
        this.post();
        return;

      case 'drop':
        await this.addPaths(message.items.map(toFsPath));
        return;

      // A drop from the OS shell, which carries contents but no path — see the
      // drop handler in manager.js. The file is copied into the library and the
      // copy is what gets scheduled, so the notice says so rather than letting
      // the user assume their original is now on a schedule.
      case 'dropText': {
        const scheduled: string[] = [];
        // The webview already caps this, but it is the untrusted side of the
        // boundary — so the size and shape are checked again here, where it
        // counts. `createPlan` sanitises the name itself.
        const dropped = (Array.isArray(message.files) ? message.files : []).filter(
          (f) => f && typeof f.name === 'string' && typeof f.text === 'string' && f.text.length <= 1_000_000
        );
        for (const file of dropped) {
          const plan = library.createPlan(dir, path.basename(file.name, '.md'), file.text);
          await this.store.addSeries(createSeries(plan.filePath));
          log.info(`copied a dropped file into the library and scheduled ${plan.name}`);
          scheduled.push(plan.title);
        }
        this.post();
        if (scheduled.length) {
          this.notify(
            `Copied ${scheduled.join(', ')} into your library and scheduled the copy — ` +
              'a dropped file does not carry its location, so the original is untouched.'
          );
        }
        return;
      }

      // Electron does not implement window.prompt(), so naming happens here.
      case 'createPlan': {
        const title = await askForTitle('Name for the new plan', 'New plan');
        if (!title) {
          return;
        }
        const plan = library.createPlan(dir, title);
        this.post();
        this.select(plan.name);
        return;
      }

      case 'renamePlan': {
        const title = await askForTitle('New name for this plan', library.titleOf(message.name));
        if (!title) {
          return;
        }
        const before = path.join(dir, message.name);
        const plan = library.renamePlan(dir, message.name, title);
        await this.repointSeries(before, plan.filePath, plan.name);
        this.post();
        this.select(plan.name);
        return;
      }

      case 'deletePlan':
        return this.deletePlan(dir, message.name);

      case 'loadPlan':
        this.sendText(dir, message.name);
        return;

      case 'savePlan':
        library.writePlan(dir, message.name, message.text);
        return;

      case 'openInEditor': {
        // `planPath` rather than a path from the webview: a name is the only way
        // in, and it is checked here the same as on every read and write.
        const filePath = library.planPath(dir, message.name);
        if (!fs.existsSync(filePath)) {
          this.notify('That file no longer exists.');
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
          viewColumn: vscode.ViewColumn.Beside
        });
        return;
      }

      case 'importPlan': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Copy into library',
          filters: { Markdown: ['md'] }
        });
        for (const uri of picked ?? []) {
          library.importFile(dir, uri.fsPath);
        }
        this.post();
        return;
      }

      case 'revealLibrary':
        fs.mkdirSync(dir, { recursive: true });
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        return;

      case 'switchFolder':
        return this.switchFolder(message.folder);

      case 'schedulePlan': {
        const series = createSeries(library.planPath(dir, message.name));
        await this.store.addSeries(series);
        log.info(`scheduled ${series.fileName} for ${series.nextRunAt}`);
        return;
      }

      case 'updateSeries': {
        const { patch, rejected } = seriesEdit(message.patch);
        if (rejected.length) {
          log.warn(`updateSeries: ignored ${rejected.join(', ')}`);
        }
        if (!Object.keys(patch).length) {
          return;
        }
        return this.store.updateSeries(message.id, patch);
      }

      case 'removeSeries':
        return this.store.removeSeries(message.id);

      case 'browseCwd': {
        const series = this.store.getSeriesById(message.id);
        if (!series) {
          return;
        }
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use as working directory',
          defaultUri: vscode.Uri.file(series.cwd)
        });
        if (picked?.length) {
          await this.store.updateSeries(message.id, { cwd: picked[0].fsPath });
        }
        return;
      }

      case 'generatePlan':
        return this.generatePlan(library.planPath(dir, message.name), message.seriesId);

      case 'runNow':
        if (!this.scheduler.leading) {
          this.notify(
            'Another VS Code window is running the Chronos scheduler. Use that window, or close it.'
          );
          return;
        }
        if (message.dismissRunId) {
          await this.store.removeRun(message.dismissRunId);
        }
        return this.scheduler.runNow(message.seriesId);

      case 'cancelRun':
        this.scheduler.cancelRun(message.id);
        return;

      case 'dismissRun':
        return this.store.removeRun(message.id);

      case 'openResult': {
        const run = this.store.getRunById(message.id);
        if (!run?.resultPath || !fs.existsSync(run.resultPath)) {
          this.notify('No transcript was recorded for that run.');
          return;
        }
        // Preview rather than source: the transcript is written to be read.
        await vscode.commands.executeCommand(
          'markdown.showPreview',
          vscode.Uri.file(run.resultPath)
        );
        return;
      }

      case 'revealResults': {
        const results = this.paths().results;
        fs.mkdirSync(results, { recursive: true });
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(results));
        return;
      }

      case 'openLog': {
        const run = this.store.getRunById(message.id);
        if (!run?.logPath || !fs.existsSync(run.logPath)) {
          this.notify('No log recorded for that run.');
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(run.logPath), {
          viewColumn: vscode.ViewColumn.Beside
        });
        return;
      }

      default:
        log.warn(`unhandled manager message: ${JSON.stringify(message)}`);
    }
  }

  /**
   * Opens an interactive plan-mode session on a plan file. A real terminal, not
   * the runner's read-only pty — the point is to talk to Claude — so this is
   * outside the scheduler entirely: no concurrency slot, no run record, no
   * transcript.
   */
  private async generatePlan(filePath: string, seriesId?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      return this.notify('That file no longer exists.');
    }
    if (!fs.readFileSync(filePath, 'utf8').trim()) {
      return this.notify('This plan is empty. Write what you want Claude to plan from first.');
    }

    const series = seriesId ? this.store.getSeriesById(seriesId) : undefined;
    const cwd = series && fs.existsSync(series.cwd) ? series.cwd : defaultCwd(filePath);

    const command = generateCommand({
      exe: vscode.workspace
        .getConfiguration('chronos')
        .get<string>('claudePath', 'claude'),
      sourcePath: filePath,
      allowDir: path.dirname(filePath),
      // Planning is always a Claude session, so a series pinned to another
      // engine contributes no model — its id would mean nothing to `claude`.
      model: agentFor(series?.agent).id === 'claude' ? series?.model : undefined,
      shell: shellKind(vscode.env.shell, process.platform)
    });

    const terminal = vscode.window.createTerminal({
      name: `Chronos: plan ${path.basename(filePath, '.md')}`,
      cwd,
      iconPath: new vscode.ThemeIcon('lightbulb')
    });
    // Focus, unlike a scheduled run: you pressed a button and are about to type.
    terminal.show();
    terminal.sendText(command);
    log.info(`opened a planning session for ${path.basename(filePath)} in ${cwd}`);
  }

  /**
   * Always asks, and says plainly that the file goes for good — `removePlan`
   * unlinks rather than recycling, and this is reachable from a hover-height X
   * on a list row, where a misclick costs the file. A scheduled plan asks a
   * second question on top: its schedule is destroyed too, and that is not
   * something the file list shows.
   */
  private async deletePlan(dir: string, name: string): Promise<void> {
    const filePath = path.join(dir, name);
    const scheduled = this.store
      .getSeries()
      .filter((s) => library.samePath(s.filePath, filePath));

    if (scheduled.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `"${name}" is scheduled. Delete the plan and its schedule?`,
        { modal: true, detail: 'The file is deleted, not moved to the recycle bin.' },
        'Delete both',
        'Delete plan only'
      );
      if (!choice) {
        return;
      }
      if (choice === 'Delete both') {
        for (const series of scheduled) {
          await this.store.removeSeries(series.id);
        }
      }
    } else {
      const choice = await vscode.window.showWarningMessage(
        `Delete "${name}"?`,
        { modal: true, detail: 'The file is deleted, not moved to the recycle bin.' },
        'Delete'
      );
      if (!choice) {
        return;
      }
    }

    library.removePlan(dir, name);
    this.post();
  }

  /** A renamed plan must not strand the series pointing at its old path. */
  private async repointSeries(before: string, after: string, fileName: string): Promise<void> {
    for (const series of this.store.getSeries()) {
      if (library.samePath(series.filePath, before)) {
        await this.store.updateSeries(series.id, { filePath: after, fileName });
      }
    }
  }

  // ---------- outbound ----------

  private select(name: string): void {
    this.panel?.webview.postMessage({ type: 'select', name });
  }

  private notify(text: string): void {
    this.panel?.webview.postMessage({ type: 'notice', text });
  }

  private sendText(dir: string, name: string): void {
    try {
      const text = library.readPlan(dir, name);
      this.panel?.webview.postMessage({ type: 'planText', name, text });
    } catch (err) {
      this.notify(`Could not read ${name}: ${String(err)}`);
    }
  }

  /** Public because `activate` re-posts after a folder switch, which changes
   *  every list on the panel at once. */
  post(): void {
    if (!this.panel) {
      return;
    }

    const paths = this.paths();
    const dir = paths.plans;

    this.panel.webview.postMessage({
      type: 'state',
      libraryPath: dir,
      resultsPath: paths.results,
      // Which folder's plans, tasks and schedule these are, and what else could
      // be shown instead. One folder is active at a time — the dropdown only
      // appears when there is more than one to choose from.
      activeFolder: paths.folder,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({
        path: f.uri.fsPath,
        name: f.name
      })),
      // One list, because there is one kind of plan: `consolidate` guarantees
      // every series points at a file in this folder.
      plans: library.listPlans(dir),
      series: this.store.getSeries(),
      runs: this.store.getRuns(),
      activity: buildActivity(this.store.getSeries(), this.store.getRuns(), Date.now()),
      // Sent rather than hard-coded in the webview: the task view's model picker
      // reads the same table, and two copies would drift the next time a model
      // ships. Only engines this machine answered on are included, so the
      // dropdown cannot offer something that would fail at fire time.
      agents: AGENTS.filter((agent) => this.availableAgents.includes(agent.id)),
      costLast7Days: this.store.costLast7Days(),
      setupProblem: this.setupProblem,
      schedulerElsewhere: !this.scheduler.leading
    });
  }

  private render(webview: vscode.Webview): string {
    const mediaUri = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'manager.html').fsPath;

    return fs
      .readFileSync(htmlPath, 'utf8')
      .replaceAll('{{nonce}}', createNonce())
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{styleUri}}', mediaUri('manager.css'))
      .replaceAll('{{codiconUri}}', mediaUri('codicon.css'))
      .replaceAll('{{scriptUri}}', mediaUri('manager.js'));
  }
}

/**
 * Drops arrive as file:// URIs from the VS Code explorer and as plain paths
 * from the OS shell. Parsing the URI form handles percent-encoding correctly.
 */
export function toFsPath(item: string): string {
  return item.startsWith('file:') ? vscode.Uri.parse(item).fsPath : item;
}

function askForTitle(prompt: string, value: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (input) =>
      input.trim() ? undefined : 'Give the plan a name.'
  });
}

/** Cryptographic, not `Math.random`: a nonce is the CSP's only guarantee that a
 *  `<script>` in this document came from us. Shared with the task view, which
 *  renders its own webview the same way. */
export function createNonce(): string {
  return randomBytes(24).toString('base64');
}

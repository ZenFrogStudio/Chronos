import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as library from './library';
import { log } from './log';
import { Scheduler } from './scheduler';
import { createSeries } from './series';
import { Store } from './store';
import { TaskSeries } from './types';

/** Messages the webview may send. Anything else is logged and ignored. */
type Inbound =
  | { type: 'ready' }
  | { type: 'drop'; items: string[] }
  | { type: 'createPlan' }
  | { type: 'renamePlan'; name: string }
  | { type: 'duplicatePlan'; name: string }
  | { type: 'deletePlan'; name: string }
  | { type: 'loadPlan'; name: string; filePath?: string; external?: boolean }
  | { type: 'savePlan'; name: string; text: string; filePath?: string; external?: boolean }
  | { type: 'openInEditor'; filePath: string }
  | { type: 'importPlan' }
  | { type: 'revealLibrary' }
  | { type: 'schedulePlan'; filePath: string }
  | { type: 'updateSeries'; id: string; patch: Partial<TaskSeries> }
  | { type: 'removeSeries'; id: string }
  | { type: 'browseCwd'; id: string }
  | { type: 'runNow'; seriesId: string; dismissRunId?: string }
  | { type: 'cancelRun'; id: string }
  | { type: 'dismissRun'; id: string }
  | { type: 'openResult'; id: string }
  | { type: 'revealResults' }
  | { type: 'openLog'; id: string };

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
  static readonly viewType = 'chronus.manager';

  private panel: vscode.WebviewPanel | undefined;
  private watcher: fs.FSWatcher | undefined;
  private watchDebounce: NodeJS.Timeout | undefined;
  private externalWatcher: fs.FSWatcher | undefined;
  private externalDebounce: NodeJS.Timeout | undefined;
  private externalWatched: string | undefined;
  private readonly storeListener: vscode.Disposable;
  /** Sticky, unlike a notice: a broken `claudePath` stays broken until fixed. */
  private setupProblem: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly scheduler: Scheduler,
    private readonly libraryPath: () => string,
    private readonly resultsPath: () => string
  ) {
    this.storeListener = store.onDidChange(() => this.post());
  }

  dispose(): void {
    this.storeListener.dispose();
    this.stopWatching();
    this.panel?.dispose();
  }

  /** Opens the manager, or reveals the tab that is already open. */
  open(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      Manager.viewType,
      'Chronus',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] }
    );
    this.adopt(panel);
  }

  /** Survives the panel not being open yet — `post()` replays it on reveal. */
  setSetupProblem(text: string): void {
    this.setupProblem = text;
    this.post();
  }

  /**
   * Schedules files from any source in place, filtering out non-Markdown. A
   * dropped file is scheduled where it lies — not copied into the library, which
   * is what Import does.
   */
  async addPaths(filePaths: string[]): Promise<void> {
    const markdown = filePaths.filter((p) => path.extname(p).toLowerCase() === '.md');
    const rejected = filePaths.length - markdown.length;

    for (const filePath of markdown) {
      const series = createSeries(filePath);
      await this.store.addSeries(series);
      log.info(`scheduled ${series.fileName} for ${series.nextRunAt} (cwd ${series.cwd})`);
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

    this.startWatching();
  }

  // ---------- library watching ----------

  /**
   * Plans edited outside Chronus must not go stale in the manager. The webview
   * owns dirty state, so it decides whether to reload — this only reports that
   * something changed.
   */
  private startWatching(): void {
    this.stopWatching();
    const dir = this.libraryPath();
    try {
      library.ensureLibrary(dir);
      this.watcher = fs.watch(dir, (_event, filename) => {
        clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          this.post();
          if (filename && library.isPlanFile(String(filename))) {
            this.panel?.webview.postMessage({ type: 'planChanged', name: String(filename) });
          }
        }, 150);
      });
    } catch (err) {
      log.warn(`could not watch plan library: ${String(err)}`);
    }
  }

  private stopWatching(): void {
    clearTimeout(this.watchDebounce);
    this.watcher?.close();
    this.watcher = undefined;
    this.stopWatchingExternal();
  }

  /**
   * An external plan lives outside the library, so the library watcher never
   * sees it change. Watching its own directory keeps the two-editor conflict
   * logic working outside the library. Only the open plan is reported.
   */
  private watchExternalPlan(filePath: string): void {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    // Keyed by the file, not just its directory: two external plans can share a
    // directory, and each needs its own basename captured in the watch callback.
    if (this.externalWatched === filePath && this.externalWatcher) {
      return;
    }
    this.stopWatchingExternal();
    this.externalWatched = filePath;
    try {
      this.externalWatcher = fs.watch(dir, (_event, filename) => {
        if (!filename || String(filename).toLowerCase() !== base.toLowerCase()) {
          return;
        }
        clearTimeout(this.externalDebounce);
        this.externalDebounce = setTimeout(() => {
          this.panel?.webview.postMessage({ type: 'planChanged', name: base });
        }, 150);
      });
    } catch (err) {
      log.warn(`could not watch external plan directory: ${String(err)}`);
    }
  }

  private stopWatchingExternal(): void {
    clearTimeout(this.externalDebounce);
    this.externalWatcher?.close();
    this.externalWatcher = undefined;
    this.externalWatched = undefined;
  }

  // ---------- messages ----------

  private async handle(message: Inbound): Promise<void> {
    const dir = this.libraryPath();

    switch (message.type) {
      case 'ready':
        this.post();
        return;

      case 'drop':
        await this.addPaths(message.items.map(toFsPath));
        return;

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

      case 'duplicatePlan': {
        const copy = library.duplicatePlan(dir, message.name);
        this.post();
        this.select(copy.name);
        return;
      }

      case 'deletePlan':
        return this.deletePlan(dir, message.name);

      case 'loadPlan':
        if (message.external && message.filePath) {
          this.watchExternalPlan(message.filePath);
          this.sendText(dir, message.name, message.filePath);
        } else {
          this.sendText(dir, message.name);
        }
        return;

      case 'savePlan':
        if (message.external && message.filePath) {
          library.writePlanAt(message.filePath, message.text);
        } else {
          library.writePlan(dir, message.name, message.text);
        }
        return;

      case 'openInEditor': {
        if (!fs.existsSync(message.filePath)) {
          this.notify('That file no longer exists.');
          return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(message.filePath), {
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
          const title = path.basename(uri.fsPath, path.extname(uri.fsPath));
          library.createPlan(dir, title, fs.readFileSync(uri.fsPath, 'utf8'));
        }
        this.post();
        return;
      }

      case 'revealLibrary':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        return;

      case 'schedulePlan': {
        const series = createSeries(message.filePath);
        await this.store.addSeries(series);
        log.info(`scheduled ${series.fileName} for ${series.nextRunAt}`);
        return;
      }

      case 'updateSeries':
        return this.store.updateSeries(message.id, message.patch);

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

      case 'runNow':
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
        const results = this.resultsPath();
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
   * Deleting a plan that something is scheduled to run is destructive in a way
   * the user cannot see from the file list, so it asks first.
   */
  private async deletePlan(dir: string, name: string): Promise<void> {
    const filePath = path.join(dir, name);
    const scheduled = this.store.getSeries().filter((s) => samePath(s.filePath, filePath));

    if (scheduled.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `"${name}" is scheduled. Delete the plan and its schedule?`,
        { modal: true },
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
    }

    library.removePlan(dir, name);
    this.post();
  }

  /** A renamed plan must not strand the series pointing at its old path. */
  private async repointSeries(before: string, after: string, fileName: string): Promise<void> {
    for (const series of this.store.getSeries()) {
      if (samePath(series.filePath, before)) {
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

  private sendText(dir: string, name: string, externalPath?: string): void {
    try {
      const text = externalPath ? library.readPlanAt(externalPath) : library.readPlan(dir, name);
      this.panel?.webview.postMessage({ type: 'planText', name, text });
    } catch (err) {
      this.notify(`Could not read ${name}: ${String(err)}`);
    }
  }

  private post(): void {
    if (!this.panel) {
      return;
    }

    const dir = this.libraryPath();
    const plans = library.listPlans(dir);
    const inLibrary = new Set(plans.map((p) => p.filePath.toLowerCase()));

    // Series pointing at files outside the library still belong in the list —
    // they are scheduled work, and hiding them would make them unmanageable.
    const external = this.store
      .getSeries()
      .filter((s) => !inLibrary.has(s.filePath.toLowerCase()))
      .map((s) => ({
        name: s.fileName,
        filePath: s.filePath,
        title: s.fileName.replace(/\.md$/i, ''),
        external: true
      }));

    this.panel.webview.postMessage({
      type: 'state',
      libraryPath: dir,
      resultsPath: this.resultsPath(),
      plans,
      external: dedupeByPath(external),
      series: this.store.getSeries(),
      runs: this.store.getRuns(),
      costLast7Days: this.store.costLast7Days(),
      setupProblem: this.setupProblem
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
      .replaceAll('{{scriptUri}}', mediaUri('manager.js'));
  }
}

/**
 * Drops arrive as file:// URIs from the VS Code explorer and as plain paths
 * from the OS shell. Parsing the URI form handles percent-encoding correctly.
 */
function toFsPath(item: string): string {
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

/** Windows paths differ in case and separator without differing in meaning. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function dedupeByPath<T extends { filePath: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.filePath.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

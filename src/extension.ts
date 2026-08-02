import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LauncherView, PlanDropController } from './launcher';
import { ensureLibrary, seedLibrary } from './library';
import { initLog, log, pruneLogs } from './log';
import { Manager } from './manager';
import { probeClaude, Runner } from './runner';
import { Scheduler } from './scheduler';
import { StatusItem } from './status';
import { Store } from './store';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  log.info(`Chronus ${context.extension.packageJSON.version} activating`);

  const store = await Store.create(context.globalState);
  const logDir = path.join(context.globalStorageUri.fsPath, 'logs');
  pruneLogs(logDir, vscode.workspace.getConfiguration('chronus').get<number>('logRetentionDays', 30));

  const libraryPath = () => resolveLibraryPath(context);
  const resultsPath = () => resolveResultsPath(libraryPath());

  const runner = new Runner(store, logDir, resultsPath);
  // Beside the state it guards, so every window for this install agrees on it.
  const lockFile = path.join(context.globalStorageUri.fsPath, 'scheduler.lock');
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  const scheduler = new Scheduler(store, runner, lockFile);

  if (ensureLibrary(libraryPath())) {
    seedLibrary(libraryPath());
    log.info('created plan library with a starter plan');
  }

  const manager = new Manager(context.extensionUri, store, scheduler, libraryPath, resultsPath);
  const status = new StatusItem(store);

  // A tree rather than a registered provider, because only `createTreeView`
  // takes a drag-and-drop controller — and this view is the one drop target
  // that works from both the VS Code explorer and the OS shell.
  const launcher = vscode.window.createTreeView('chronus.launcher', {
    treeDataProvider: new LauncherView(),
    dragAndDropController: new PlanDropController(manager)
  });
  launcher.message = 'Drop .md files here to schedule them.';

  context.subscriptions.push(
    store,
    runner,
    scheduler,
    manager,
    status,
    launcher,
    vscode.window.registerWebviewPanelSerializer(Manager.viewType, {
      // Restores the tab after a window reload instead of holding it in memory.
      async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
        manager.restore(restored);
      }
    }),
    vscode.commands.registerCommand('chronus.openManager', () => manager.open()),
    vscode.commands.registerCommand('chronus.addFiles', () => addFiles(manager)),
    vscode.commands.registerCommand(
      'chronus.scheduleFile',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        // `explorer/context` passes (clicked, whole selection), but
        // `editor/title/context` passes a menu group reference as the second
        // argument — so filter it rather than trusting its shape.
        const picked = (Array.isArray(uris) ? uris : []).filter((u) => u instanceof vscode.Uri);
        const paths = (picked.length ? picked : uri ? [uri] : []).map((u) => u.fsPath);
        if (!paths.length) {
          return addFiles(manager);
        }
        manager.open();
        await manager.addPaths(paths);
      }
    ),
    vscode.commands.registerCommand('chronus.showLogs', () => log.show())
  );

  await scheduler.start();

  // Not awaited: activation must not wait on a child process. A bad path should
  // surface here rather than at fire time.
  const claudePath = vscode.workspace.getConfiguration('chronus').get<string>('claudePath', 'claude');
  void probeClaude(claudePath).then((problem) => {
    if (problem) {
      log.error(`claude pre-flight failed — ${problem}`);
      manager.setSetupProblem(problem);
    }
  });

  log.info('Chronus activated');
}

export function deactivate(): void {
  log.info('Chronus deactivating');
}

/**
 * Where the plan library lives. Global rather than per-workspace on purpose —
 * the point of a library is reusing a plan across projects.
 */
function resolveLibraryPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration('chronus')
    .get<string>('libraryPath', '')
    .trim();

  return configured || path.join(context.globalStorageUri.fsPath, 'plans');
}

/**
 * Where run transcripts land. Defaults to a `results` folder beside the plan
 * library rather than to extension storage: these are written to be read, often
 * the next morning and often from a file manager, so they belong somewhere the
 * user can actually find. Point `chronus.resultsPath` elsewhere to move them.
 */
function resolveResultsPath(libraryPath: string): string {
  const configured = vscode.workspace
    .getConfiguration('chronus')
    .get<string>('resultsPath', '')
    .trim();

  return configured || path.join(libraryPath, 'results');
}

/** Guaranteed path to adding files, independent of drag-and-drop. */
async function addFiles(manager: Manager): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Schedule',
    filters: { Markdown: ['md'] }
  });

  if (picked?.length) {
    await manager.addPaths(picked.map((u) => u.fsPath));
    manager.open();
  }
}

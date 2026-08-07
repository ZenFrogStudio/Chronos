import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENTS } from './agents';
import { consolidate } from './consolidate';
import { ensureLibrary, seedLibrary } from './library';
import { initLog, log, logConsolidation, pruneLogs } from './log';
import { Manager } from './manager';
import { probeAgent, Runner } from './runner';
import { Scheduler } from './scheduler';
import { StatusItem } from './status';
import { Store } from './store';
import { InboxTask, PlanDropController, TaskListView } from './tasks';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  log.info(`Chronos ${context.extension.packageJSON.version} activating`);

  const store = await Store.create(context.globalState);
  const logDir = path.join(context.globalStorageUri.fsPath, 'logs');
  pruneLogs(logDir, vscode.workspace.getConfiguration('chronos').get<number>('logRetentionDays', 30));

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

  // Plans scheduled in place by an older version are copied in here, so the rest
  // of the session can assume every scheduled plan is a library plan.
  logConsolidation(await consolidate(store, libraryPath()));

  const manager = new Manager(context.extensionUri, store, scheduler, libraryPath, resultsPath);
  const status = new StatusItem(store);

  // A tree rather than a registered provider, because only `createTreeView`
  // takes a drag-and-drop controller — and this view is the one drop target
  // that works from both the VS Code explorer and the OS shell.
  const taskList = new TaskListView(libraryPath, manager);
  const taskView = vscode.window.createTreeView('chronos.tasks', {
    treeDataProvider: taskList,
    dragAndDropController: new PlanDropController(manager)
  });
  // A message rather than `viewsWelcome`: welcome content cannot accept a drop,
  // and the empty body has to stay a drop target.
  taskView.message = 'Add a task, or drop .md files here to schedule them.';

  context.subscriptions.push(
    store,
    runner,
    scheduler,
    manager,
    status,
    taskList,
    taskView,
    vscode.window.registerWebviewPanelSerializer(Manager.viewType, {
      // Restores the tab after a window reload instead of holding it in memory.
      async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
        manager.restore(restored);
      }
    }),
    vscode.commands.registerCommand('chronos.openManager', () => manager.open()),
    vscode.commands.registerCommand('chronos.addFiles', () => addFiles(manager)),
    vscode.commands.registerCommand(
      'chronos.scheduleFile',
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
    vscode.commands.registerCommand('chronos.showLogs', () => log.show()),
    vscode.commands.registerCommand('chronos.addTask', () => taskList.addTask()),
    vscode.commands.registerCommand('chronos.generatePlan', (task: InboxTask) =>
      taskList.generatePlan(task)
    ),
    vscode.commands.registerCommand('chronos.editTask', (task: InboxTask) =>
      taskList.editTask(task)
    ),
    vscode.commands.registerCommand('chronos.deleteTask', (task: InboxTask) =>
      taskList.deleteTask(task)
    )
  );

  await scheduler.start();

  // Not awaited: activation must not wait on a child process. A bad path should
  // surface here rather than at fire time.
  //
  // The same probe decides what the manager's Engine dropdown offers, so it
  // only ever lists engines this machine actually answered on. Claude is the
  // exception: it stays listed even when broken, because it is the default and
  // a missing one is a setup problem to fix rather than a choice to withdraw.
  void Promise.all(
    AGENTS.map((agent) => probeAgent(agent).then((problem) => ({ agent, problem })))
  ).then((probes) => {
    for (const { agent, problem } of probes) {
      if (!problem) {
        continue;
      }
      if (agent.id === 'claude') {
        log.error(`claude pre-flight failed — ${problem}`);
        manager.setSetupProblem(problem);
      } else {
        log.info(`${agent.id} is not available, so it is not offered — ${problem}`);
      }
    }

    manager.setAvailableAgents(
      probes.filter((p) => !p.problem || p.agent.id === 'claude').map((p) => p.agent.id)
    );
  });

  log.info('Chronos activated');
}

export function deactivate(): void {
  log.info('Chronos deactivating');
}

/**
 * Where the plan library lives. Global rather than per-workspace on purpose —
 * the point of a library is reusing a plan across projects.
 */
function resolveLibraryPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration('chronos')
    .get<string>('libraryPath', '')
    .trim();

  return configured || path.join(context.globalStorageUri.fsPath, 'plans');
}

/**
 * Where run transcripts land. Defaults to a `results` folder beside the plan
 * library rather than to extension storage: these are written to be read, often
 * the next morning and often from a file manager, so they belong somewhere the
 * user can actually find. Point `chronos.resultsPath` elsewhere to move them.
 */
function resolveResultsPath(libraryPath: string): string {
  const configured = vscode.workspace
    .getConfiguration('chronos')
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

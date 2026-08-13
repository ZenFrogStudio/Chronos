import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { adoptGlobal, claimAdoption } from './adopt';
import { AGENTS } from './agents';
import { consolidate } from './consolidate';
import { seedLibrary } from './library';
import { initLog, log, logConsolidation, logRetirement, pruneLogs } from './log';
import { Manager } from './manager';
import { migrate } from './migrate';
import { retireCompletedPlans } from './retire';
import { ChronosPaths, ensureRoot, pathsFor, sweepPending } from './roots';
import { probeAgent, Runner } from './runner';
import { Scheduler } from './scheduler';
import { writeState } from './state-file';
import { StatusItem } from './status';
import { Store } from './store';
import { TaskView } from './tasks';
import { STORE_KEY } from './types';

/** Which folder this window is showing. See `activeFolder` below. */
const ACTIVE_FOLDER_KEY = 'chronos.activeFolder';
/** Set once the old machine-wide dataset has been moved into a folder. */
const ADOPTED_KEY = 'chronos.adoptedInto';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog(context);
  log.info(`Chronos ${context.extension.packageJSON.version} activating`);

  let active = activeFolder(context);
  const paths = (): ChronosPaths =>
    resolvePaths(active ?? context.globalStorageUri.fsPath);

  const fresh = ensureRoot(paths());
  if (fresh) {
    log.info(`created ${paths().root}`);
  }
  // Only into a real folder. With no folder open there is nothing folder-
  // specific to adopt into, and claiming the data for the fallback root would
  // strand it somewhere the user's actual projects never look.
  if (active) {
    adoptOnce(context, paths());
  }
  seedIfNew(paths(), fresh);

  const store = await Store.create(paths().state);
  const runner = new Runner(store, () => paths().logs, () => paths().results);

  /** A one-shot that has run has no future, so its file leaves the library. */
  const retire = async (): Promise<void> =>
    logRetirement(await retireCompletedPlans(store, paths().plans, paths().archivedPlans));

  const scheduler = new Scheduler(store, runner, () => paths().lock, retire);

  /**
   * Staging folders left by planning sessions that ended with the window rather
   * than with their terminal. `roots.ts` cannot reach the log channel, so it
   * reports rather than logs and the writing happens here.
   *
   * A kept folder is a `warn`: it holds a generated plan that never reached the
   * library, and its path is the only thing that will lead the user back to it.
   */
  const sweep = (): void => {
    const report = sweepPending(paths().pending);
    if (report.removed > 0) {
      log.info(`removed ${report.removed} abandoned plan staging folder(s)`);
    }
    for (const dir of report.kept) {
      log.warn(`kept ${dir} — it still holds a generated plan that never reached the library`);
    }
  };

  pruneLogs(paths().logs, config().get<number>('logRetentionDays', 30));
  sweep();

  // Plans scheduled in place by an older version are copied in here, so the rest
  // of the session can assume every scheduled plan is a library plan. The sweep
  // that follows is what tidies plans already run by a build that kept them.
  logConsolidation(await consolidate(store, paths().plans, paths().archivedPlans));
  await retire();

  /**
   * Moves this window to another folder in the workspace. Everything downstream
   * reads a path thunk or the store, so the move is: release the old folder's
   * lock, remember the choice, and re-point the store.
   */
  const switchFolder = async (folder: string): Promise<void> => {
    if (folder === active) {
      return;
    }
    if (!(vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === folder)) {
      log.warn(`refused to switch to ${folder} — not a folder in this workspace`);
      return;
    }
    // A run holds a child process, a pseudoterminal and a half-written
    // transcript, all belonging to the folder being left. Cancelling somebody's
    // overnight job to change a dropdown is not a trade worth making silently.
    if (runner.activeCount > 0) {
      void vscode.window.showWarningMessage(
        `Chronos is running ${runner.activeCount} task${runner.activeCount > 1 ? 's' : ''}. ` +
          'Wait for it to finish, or cancel it, before switching folder.'
      );
      manager.post();
      return;
    }

    scheduler.releaseNow();
    active = folder;
    await context.workspaceState.update(ACTIVE_FOLDER_KEY, folder);

    seedIfNew(paths(), ensureRoot(paths()));
    await store.retarget(paths().state);
    pruneLogs(paths().logs, config().get<number>('logRetentionDays', 30));
    // Switching folder changes which `.pending` is in play.
    sweep();
    logConsolidation(await consolidate(store, paths().plans, paths().archivedPlans));
    await retire();

    manager.restartWatching();
    manager.post();
    await scheduler.reclaim();
    log.info(`switched to ${folder}`);
  };

  // The manifest's own configuration schema, which is what the manager's
  // Settings page is generated from — one source of truth for every setting's
  // type, default, range and help text.
  const manager = new Manager(
    context.extensionUri,
    store,
    scheduler,
    paths,
    switchFolder,
    context.extension.packageJSON.contributes.configuration.properties
  );
  const status = new StatusItem(store);

  // A webview rather than a tree: a to-do list needs an always-there text field,
  // in-body buttons and coloured rows, none of which the TreeView API can draw.
  // The view opens the manager itself, since resolving is the only signal an
  // activity-bar click produces.
  const taskView = new TaskView(context.extensionUri, paths, store, scheduler, manager);

  context.subscriptions.push(
    store,
    runner,
    scheduler,
    manager,
    status,
    taskView,
    vscode.window.registerWebviewViewProvider(TaskView.viewType, taskView),
    vscode.window.registerWebviewPanelSerializer(Manager.viewType, {
      // Restores the tab after a window reload instead of holding it in memory.
      async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
        manager.restore(restored);
      }
    }),
    // A folder removed from the workspace must not go on receiving writes.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const resolved = activeFolder(context);
      if (resolved && resolved !== active) {
        void switchFolder(resolved);
      }
    }),
    vscode.commands.registerCommand('chronos.openManager', () => manager.open()),
    vscode.commands.registerCommand('chronos.selectFolder', () => selectFolder(switchFolder)),
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
    vscode.commands.registerCommand('chronos.addTask', () => taskView.addTask())
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

  log.info(`Chronos activated on ${paths().folder}`);
}

export function deactivate(): void {
  log.info('Chronos deactivating');
}

/**
 * The folder this window operates in. Chronos data is per-folder, so this is
 * the single decision every path below hangs off.
 *
 * One folder is active at a time rather than all of them at once: a second
 * active folder means a second scheduler, a second concurrency budget and a
 * merged list that has to say which folder every row came from — a lot of
 * machinery for a case that is rare, when a dropdown covers it.
 *
 * A remembered choice is only honoured while that folder is still in the
 * workspace; otherwise the first folder wins.
 */
function activeFolder(context: vscode.ExtensionContext): string | undefined {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const remembered = context.workspaceState.get<string>(ACTIVE_FOLDER_KEY);

  if (remembered && folders.includes(remembered)) {
    return remembered;
  }
  return folders[0];
}

/**
 * Where this window's data lives. With no folder open there is nothing to be
 * specific to, so Chronos falls back to a `.chronos` root inside its own
 * extension storage and goes on working.
 *
 * `chronos.libraryPath` and `chronos.resultsPath` still override their part of
 * the layout, which is what makes the change safe for anyone already using
 * them. Set in *workspace* settings they keep a folder's data folder-specific;
 * set in user settings they deliberately put every folder back in one place.
 */
function resolvePaths(folder: string): ChronosPaths {
  const paths = pathsFor(folder);
  const library = config().get<string>('libraryPath', '').trim();
  const results = config().get<string>('resultsPath', '').trim();

  return {
    ...paths,
    plans: library || paths.plans,
    results: results || paths.results
  };
}

/**
 * The old machine-wide dataset, moved wholesale into the first folder opened
 * after the upgrade.
 *
 * Splitting it by folder automatically would be guesswork — a plan file says
 * nothing about which repository it belongs to — so it all lands in one place
 * and the user moves plans on from there. Runs once ever, and copies rather than
 * moves: the old storage is left intact.
 *
 * Two gates, because there are two ways to run twice. The flag in global state
 * covers the ordinary case of this window activating again, and answers without
 * touching the disk. The marker file covers the case the flag cannot see: a
 * second window activating on the new build at the same moment, before the flag
 * it writes has reached anyone else.
 */
function adoptOnce(context: vscode.ExtensionContext, next: ChronosPaths): void {
  if (context.globalState.get<string>(ADOPTED_KEY) || fs.existsSync(next.state)) {
    return;
  }

  const legacyLibrary =
    config().get<string>('libraryPath', '').trim() ||
    path.join(context.globalStorageUri.fsPath, 'plans');

  const legacy = {
    plans: legacyLibrary,
    tasks: path.join(legacyLibrary, 'tasks'),
    results:
      config().get<string>('resultsPath', '').trim() || path.join(legacyLibrary, 'results')
  };

  // Through the ladder first: the old key may hold a v1 or v2 shape, and an
  // unrecognisable one is better left where it is than copied into a folder.
  const previous = migrate(context.globalState.get<unknown>(STORE_KEY));
  if (!fs.existsSync(legacy.plans) && !previous) {
    // Nothing to adopt — a fresh install. Flag it anyway, so a plan later
    // dropped into the old location is never hoovered up by surprise.
    void context.globalState.update(ADOPTED_KEY, next.folder);
    return;
  }

  // Staked before a single file is copied. Claiming it afterwards would leave
  // the whole copy inside the race it is meant to close.
  if (!claimAdoption(context.globalStorageUri.fsPath)) {
    log.info(
      'another window is adopting the previous machine-wide Chronos data — ' +
        'leaving it to that one, so it is not copied into two projects at once'
    );
    return;
  }

  const { state, report } = adoptGlobal(legacy, next, previous);
  writeState(next.state, state);
  void context.globalState.update(ADOPTED_KEY, next.folder);

  log.info(
    `adopted the previous machine-wide Chronos data into ${next.root}: ` +
      `${report.plans} plan(s), ${report.tasks} task(s), ${report.repointed} schedule(s), ` +
      `${report.runs} run(s)${report.results ? ', plus past transcripts' : ''}. ` +
      `The originals are untouched in ${legacyLibrary}.`
  );
}

/**
 * A first-run plan, so a folder new to Chronos opens with something to look at
 * and a safe thing to try.
 *
 * Only when the root was just created, never merely because the library is
 * empty: deleting the starter plan must not bring it back on the next reload.
 * The emptiness check on top of that is for the folder that just adopted the
 * old machine-wide library — it has plans already, and does not need a
 * thirteenth one explaining what a plan is.
 */
function seedIfNew(paths: ChronosPaths, rootWasCreated: boolean): void {
  if (!rootWasCreated) {
    return;
  }
  try {
    if (fs.readdirSync(paths.plans).length === 0) {
      seedLibrary(paths.plans);
      log.info(`seeded ${paths.plans} with a starter plan`);
    }
  } catch (err) {
    log.warn(`could not seed the plan library: ${String(err)}`);
  }
}

/** The command-palette route to the manager's folder dropdown. */
async function selectFolder(switchFolder: (folder: string) => Promise<void>): Promise<void> {
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Which folder should Chronos show?'
  });
  if (picked) {
    await switchFolder(picked.uri.fsPath);
  }
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

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('chronos');
}

import * as fs from 'fs';
import * as path from 'path';

/**
 * Where one folder's Chronos data lives.
 *
 * Everything Chronos writes for a folder goes under a single `.chronos`
 * directory inside it: the schedule, the plan library, the task inbox, the run
 * transcripts and the raw logs. One root rather than a scattering of
 * configurable locations, so "what does Chronos know about this project?" is
 * answered by one `ls`, and moving a project moves its schedule with it.
 *
 * Pure path arithmetic plus one mkdir, like `results.ts` and `lock.ts` — no
 * `vscode` import, so the layout is testable against a temp directory.
 */

export const ROOT_DIR = '.chronos';

export interface ChronosPaths {
  /** The project folder Chronos is operating in. */
  folder: string;
  /** `<folder>/.chronos` — everything below is inside it. */
  root: string;
  /** Series and runs. Was `globalState` before the layout became per-folder. */
  state: string;
  /** Arbitrates which window schedules *this folder*. See `lock.ts`. */
  lock: string;
  plans: string;
  tasks: string;
  /** Staging for in-flight plan generation. Dot-prefixed so it is never listed. */
  pending: string;
  results: string;
  logs: string;
  /** Plans and tasks removed from the library. Kept, never pruned. */
  archive: string;
  archivedPlans: string;
  archivedTasks: string;
}

export function pathsFor(folder: string): ChronosPaths {
  const root = path.join(folder, ROOT_DIR);
  return {
    folder,
    root,
    state: path.join(root, 'state.json'),
    lock: path.join(root, 'scheduler.lock'),
    plans: path.join(root, 'plans'),
    tasks: path.join(root, 'tasks'),
    pending: path.join(root, '.pending'),
    results: path.join(root, 'results'),
    logs: path.join(root, 'logs'),
    archive: path.join(root, 'archive'),
    archivedPlans: path.join(root, 'archive', 'plans'),
    archivedTasks: path.join(root, 'archive', 'tasks')
  };
}

/**
 * Creates the tree, and ignores the whole of it from git.
 *
 * The `.gitignore` goes *inside* the root rather than appending to the
 * project's own: editing a file the user owns to make our own feature work is
 * not ours to do, and a self-contained ignore file is removed by deleting the
 * folder. It is written only when absent, so a user who decides to track their
 * plans can simply edit it and keep that decision.
 *
 * Returns true when the root did not exist beforehand — the caller uses that to
 * decide whether a folder is new enough to want a starter plan.
 */
export function ensureRoot(paths: ChronosPaths): boolean {
  const created = fs.mkdirSync(paths.root, { recursive: true }) !== undefined;

  for (const dir of [paths.plans, paths.tasks, paths.results, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ignore = path.join(paths.root, '.gitignore');
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, '*\n', 'utf8');
  }

  return created;
}

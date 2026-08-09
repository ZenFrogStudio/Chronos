import * as fs from 'fs';
import * as path from 'path';
import * as library from './library';
import { ChronosPaths } from './roots';
import { emptyState } from './state-file';
import { ChronosState } from './types';

/**
 * The one-time move from the old machine-wide storage into a folder.
 *
 * Chronos used to keep a single library, task inbox and schedule in extension
 * storage, shared by every project. Making that data folder-specific after the
 * fact is guesswork — a plan named `nightly-audit.md` says nothing about which
 * repository it belongs to — so rather than split it up on a hunch, the whole
 * dataset moves into the first folder opened after the upgrade, and the user
 * moves individual plans on from there.
 *
 * Everything is *copied*. The old storage is left exactly as it was, which is
 * the same rule `library.importFile` follows for a user's own file: an upgrade
 * that deletes the only copy of a year of run history is not recoverable, and
 * disk is cheap.
 *
 * No `vscode` import, so the whole migration is testable against temp
 * directories.
 */

export interface LegacyPaths {
  plans: string;
  tasks: string;
  results: string;
}

export interface AdoptionReport {
  plans: number;
  tasks: number;
  /** Series whose plan file was found and repointed at the new copy. */
  repointed: number;
  runs: number;
  results: boolean;
}

export function adoptGlobal(
  legacy: LegacyPaths,
  next: ChronosPaths,
  state: ChronosState | undefined
): { state: ChronosState; report: AdoptionReport } {
  const report: AdoptionReport = {
    plans: 0,
    tasks: 0,
    repointed: 0,
    runs: state?.runs.length ?? 0,
    results: false
  };

  // Old path (resolved, case-folded) -> the copy now in this folder's library.
  // Same shape as the map in `consolidate.ts`: two series scheduled against one
  // file must end up sharing one copy, or editing either stops reaching the
  // other run.
  const copies = new Map<string, library.PlanFile>();

  // A `chronos.libraryPath` pointing at the folder we are adopting into makes
  // source and destination the same directory, and copying a directory into
  // itself would duplicate every plan under a `-2` name. There is nothing to
  // move in that case: the files are already where they belong.
  if (!sameDir(legacy.plans, next.plans)) {
    for (const plan of library.listPlans(legacy.plans)) {
      // The single door every outside file comes through — it slugs the name and
      // de-duplicates it, so a plan the target folder already has is not
      // overwritten.
      const copy = library.importFile(next.plans, plan.filePath);
      copies.set(key(plan.filePath), copy);
      report.plans++;
    }
  }

  if (!sameDir(legacy.tasks, next.tasks)) {
    for (const task of library.listPlans(legacy.tasks)) {
      library.importFile(next.tasks, task.filePath);
      report.tasks++;
    }
  }

  report.results = !sameDir(legacy.results, next.results) && copyTree(legacy.results, next.results);

  const adopted: ChronosState = state ? { ...state, series: [...state.series] } : emptyState();

  adopted.series = adopted.series.map((series) => {
    const copy = copies.get(key(series.filePath));
    if (!copy) {
      // Its plan was not in the old library. `consolidate()` runs straight
      // after this and will either import the file or drop the schedule, so
      // there is nothing useful to decide here.
      return series;
    }
    report.repointed++;
    // `cwd` is deliberately untouched, for the reason `consolidate.ts` gives:
    // the plan has moved, but the work it does still belongs to whichever
    // project it ran against.
    return { ...series, filePath: copy.filePath, fileName: copy.name };
  });

  return { state: adopted, report };
}

/** Best-effort recursive copy. Returns whether there was anything to copy. */
function copyTree(from: string, to: string): boolean {
  if (!fs.existsSync(from)) {
    return false;
  }
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  return true;
}

const key = (filePath: string): string => path.resolve(filePath).toLowerCase();

/** `samePath` folds case only where the filesystem does, which is what matters
 *  when the two sides came from a setting and from our own layout. */
const sameDir = (a: string, b: string): boolean => library.samePath(a, b);

import { MAX_MISSED_RUNS, MAX_RECENT_RUNS, TaskRun, isFinished } from './types';

/**
 * How much run history is kept. Pure — no `vscode`, no store — because this is
 * the one place Chronus deletes something the user might still want, and that
 * rule should be a test rather than a hope.
 *
 * The store lives in `globalState`, so it cannot grow forever: a daily series
 * left running for a year is 365 finished runs, and a catch-up decision the user
 * never answers is a missed run that nothing else will ever clear.
 */

/** When a run last mattered. A missed run has no `finishedAt`, only a `missedAt`. */
const recency = (run: TaskRun): string => run.finishedAt ?? run.missedAt ?? run.scheduledAt;

/**
 * Caps history, newest first.
 *
 * Finished and missed runs are capped separately and on different limits: a
 * missed run is still waiting for a decision, so it outlives a completed one.
 * Pending and running runs are never dropped — they are still in flight, and
 * discarding one would cancel scheduled work without saying so.
 */
export function pruneRuns(runs: readonly TaskRun[]): TaskRun[] {
  const capped = keepNewest([...runs], (run) => isFinished(run.status), MAX_RECENT_RUNS);
  return keepNewest(capped, (run) => run.status === 'missed', MAX_MISSED_RUNS);
}

/** Keeps the newest `max` of the runs `matches` selects, leaving the rest alone. */
function keepNewest(
  runs: TaskRun[],
  matches: (run: TaskRun) => boolean,
  max: number
): TaskRun[] {
  const selected = runs.filter(matches);
  if (selected.length <= max) {
    return runs;
  }

  const keep = new Set(
    selected
      .sort((a, b) => recency(b).localeCompare(recency(a)))
      .slice(0, max)
      .map((run) => run.id)
  );

  return runs.filter((run) => !matches(run) || keep.has(run.id));
}

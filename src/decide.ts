import { advancePast, computeNextRun } from './recurrence';
import { MissedReason, TaskRun, TaskSeries } from './types';

/**
 * The scheduler's tick decision, as a pure function. No `vscode`, no store, no
 * clock, no I/O — inputs in, actions out — so every rule below is directly
 * testable by the plain Node runner.
 *
 * `Scheduler` supplies the clock and applies the actions. This is the
 * functional core; the scheduler is the imperative shell.
 */

export type Action =
  | { kind: 'addRun'; run: TaskRun }
  | { kind: 'updateSeries'; id: string; patch: Partial<TaskSeries> }
  | { kind: 'updateRun'; id: string; patch: Partial<TaskRun> }
  | { kind: 'removeRun'; id: string }
  | { kind: 'start'; series: TaskSeries; run: TaskRun }
  | { kind: 'announceMissed'; count: number; reason: MissedReason };

export interface DecideInput {
  series: readonly TaskSeries[];
  runs: readonly TaskRun[];
  /** Epoch ms. */
  now: number;
  graceMs: number;
  /** Only ever shapes the wording of the missed notification. */
  reason: MissedReason;
  isSeriesRunning: (seriesId: string) => boolean;
  freeSlots: number;
  /** Injected so decisions stay deterministic under test. */
  newId: () => string;
}

export function newRun(
  series: TaskSeries,
  scheduledAt: string,
  attempt: number,
  id: string
): TaskRun {
  return { id, seriesId: series.id, scheduledAt, status: 'pending', attempt };
}

export function decide(input: DecideInput): Action[] {
  const { now, graceMs, reason } = input;
  const nowIso = new Date(now).toISOString();
  const actions: Action[] = [];
  const seriesById = new Map(input.series.map((s) => [s.id, s]));

  let missedCount = 0;

  // Runs materialised below join this list, so an occurrence that comes due can
  // still start within the same tick rather than waiting for the next one.
  const candidates = input.runs.filter((r) => r.status === 'pending').slice();

  // ---- 1. Turn due occurrences into runs ----

  for (const series of input.series) {
    // `spent` retires a fired one-shot; `enabled` is the user's pause. Both
    // stop new occurrences, and only the second stops queued ones (below).
    if (!series.enabled || series.spent) {
      continue;
    }

    const overdue = now - Date.parse(series.nextRunAt);
    if (overdue < 0) {
      continue;
    }

    if (overdue <= graceMs) {
      const run = newRun(series, series.nextRunAt, 1, input.newId());
      actions.push({ kind: 'addRun', run });
      candidates.push(run);
      actions.push({ kind: 'updateSeries', id: series.id, patch: advanceOf(series, now) });
    } else {
      actions.push({ kind: 'addRun', run: missedRun(series, reason, now, nowIso, input.newId()) });
      actions.push({ kind: 'updateSeries', id: series.id, patch: advanceOf(series, now) });
      missedCount++;
    }
  }

  // ---- 2. Start what is due, retries included ----

  let slots = input.freeSlots;
  const starting = new Set<string>();

  for (const run of [...candidates].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const overdue = now - Date.parse(run.scheduledAt);
    if (overdue < 0) {
      continue;
    }

    const series = seriesById.get(run.seriesId);
    if (!series) {
      actions.push({ kind: 'removeRun', id: run.id });
      continue;
    }

    if (overdue > graceMs) {
      actions.push({
        kind: 'updateRun',
        id: run.id,
        patch: { status: 'missed', missedAt: nowIso, missedReason: reason }
      });
      missedCount++;
      continue;
    }

    // Pausing a series stops its queued retries too. "Run now" is the deliberate
    // exception: it exists precisely to fire a series that is not scheduled.
    if (!series.enabled && !run.manual) {
      continue;
    }

    // Overlap guard: never stack a second run on one series.
    if (input.isSeriesRunning(series.id) || starting.has(series.id)) {
      continue;
    }
    if (slots <= 0) {
      break;
    }

    actions.push({ kind: 'start', series, run });
    starting.add(series.id);
    slots--;
  }

  if (missedCount > 0) {
    actions.push({ kind: 'announceMissed', count: missedCount, reason });
  }

  return actions;
}

/** Where a series goes after its current occurrence is consumed. */
function advanceOf(series: TaskSeries, now: number): Partial<TaskSeries> {
  if (!series.recurrence) {
    return { spent: true };
  }
  return { nextRunAt: computeNextRun(series.recurrence, new Date(now)).toISOString() };
}

/**
 * One missed record per series per catch-up. A week-long outage should produce
 * a single decision, not seven notifications.
 */
function missedRun(
  series: TaskSeries,
  reason: MissedReason,
  now: number,
  nowIso: string,
  id: string
): TaskRun {
  const base: TaskRun = {
    ...newRun(series, series.nextRunAt, 1, id),
    status: 'missed',
    missedAt: nowIso,
    missedReason: reason
  };

  if (!series.recurrence) {
    return base;
  }

  const { skipped } = advancePast(series.recurrence, new Date(series.nextRunAt), new Date(now));
  return { ...base, missedCount: skipped + 1 };
}

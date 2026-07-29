import { Recurrence } from './types';

/**
 * Recurrence math. Pure — no `vscode` import — so it is directly testable.
 *
 * Occurrences are built with the local-time Date constructor rather than by
 * adding 24h to a previous instant. That is what keeps "every day at 09:00"
 * reading 09:00 on both sides of a DST boundary: the day either side of a
 * transition is 23 or 25 real hours long, but the wall clock is unchanged.
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The next occurrence strictly after `after`. */
export function computeNextRun(recurrence: Recurrence, after: Date): Date {
  if (!recurrence.daysOfWeek.length) {
    throw new Error('Recurrence has no days of week.');
  }

  const match = TIME_PATTERN.exec(recurrence.timeLocal);
  if (!match) {
    throw new Error(`Invalid recurrence time: ${recurrence.timeLocal}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  // Today plus a full week is always enough to hit any day-of-week rule.
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + offset,
      hours,
      minutes,
      0,
      0
    );
    if (
      candidate.getTime() > after.getTime() &&
      recurrence.daysOfWeek.includes(candidate.getDay())
    ) {
      return candidate;
    }
  }

  throw new Error('Could not find a next occurrence within one week.');
}

/**
 * Advances past every occurrence already in the past, reporting how many were
 * skipped. A machine that was off for a week produces one catch-up decision
 * rather than seven.
 */
export function advancePast(
  recurrence: Recurrence,
  from: Date,
  now: Date
): { next: Date; skipped: number } {
  let next = computeNextRun(recurrence, from);
  let skipped = 0;

  while (next.getTime() <= now.getTime()) {
    next = computeNextRun(recurrence, next);
    skipped++;
  }

  return { next, skipped };
}

import { seriesEdit } from './edit';
import { computeNextRun } from './recurrence';
import { DAILY, Recurrence, TaskSeries } from './types';

/**
 * What an MCP client is allowed to ask Chronos to do.
 *
 * This module *is* the security boundary for the agent channel, the way
 * `command.ts` is for the phone — but drawn in a different place, because the
 * two callers are trusted with different things. A phone may only change *when*
 * a task runs. An agent may write the plan too, because authoring is the whole
 * point of connecting one; what it may not do is set `permissionMode`.
 *
 * That single refusal is the load-bearing rule. Chronos runs coding agents
 * unattended, on a schedule, in a real repository. An agent that could set its
 * own task to `bypassPermissions` would be granting itself recurring,
 * unrestricted tool access on this machine without a human ever seeing the
 * decision — so raising a task above the `auto` default stays a click in the
 * manager, made by a person looking at the plan.
 *
 * Pure — no `vscode`, no `fs`, no process — so every rejection below is a unit
 * test rather than something we hope is right. `mcp-server.ts` does the reading
 * and writing and applies the verdicts; this decides.
 */

///////////////////////////*What comes off the wire*////////////////////////////

/** Repeat rules an agent may ask for, matching `setRepeat` in `command.ts`. */
export type RepeatKind = 'once' | 'daily' | 'weekly' | 'monthly';

/** `schedule_plan`'s timing arguments. Every field is untrusted. */
export interface ScheduleWhen {
  /** An ISO 8601 instant. Used alone for a one-shot, or with `repeat`. */
  at?: unknown;
  /** "HH:MM" local wall-clock time, for a repeating rule. */
  timeLocal?: unknown;
  repeat?: unknown;
  /** 0 = Sunday .. 6 = Saturday. Only read by a weekly rule. */
  daysOfWeek?: unknown;
  /** 1–31. Only read by a monthly rule; defaults to the day `at` falls on. */
  dayOfMonth?: unknown;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

/** When a series should first run, and whether it comes back. */
export interface Timing {
  /** ISO 8601 UTC. */
  nextRunAt: string;
  /** null = one-shot. */
  recurrence: Recurrence | null;
}

/**
 * A schedule target this far in the past is a mistake rather than an
 * instruction — the same tolerance, and the same reasoning, as `command.ts`.
 * Anything nearer is let through to fire on the next tick.
 */
const PAST_TOLERANCE_MS = 5 * 60_000;

/**
 * The refusal an agent reads when it tries to set its own permissions. Worded
 * as a fact about where the setting lives, not as an error, because the agent
 * will show it to the user and the next step is a human opening the manager.
 */
export const PERMISSION_REFUSAL =
  'permissionMode cannot be set over MCP. A new task runs in `auto` mode; ' +
  'raising it is a decision a person makes in the Chronos manager, on a plan ' +
  'they have read.';

///////////////////////////*Timing*////////////////////////////

/**
 * Turns the friendly `when` arguments into a concrete first run plus a rule.
 *
 * `computeNextRun` derives the instant from the rule rather than the caller
 * supplying both, so a recurring series' first occurrence is the same instant
 * its second one will be — an agent that sent a `timeLocal` of 02:00 and an
 * `at` of 02:07 would otherwise get a series that fires at 02:07 once and 02:00
 * forever after.
 */
export function planTiming(when: ScheduleWhen, now: Date = new Date()): Verdict<Timing> {
  const repeat = when.repeat ?? 'once';
  if (!isRepeatKind(repeat)) {
    return refuse('repeat must be once, daily, weekly or monthly.');
  }

  if (repeat === 'once') {
    const at = parseInstant(when.at);
    if (at === undefined) {
      return refuse('A one-off schedule needs `at` as an ISO 8601 date and time.');
    }
    if (now.getTime() - at > PAST_TOLERANCE_MS) {
      return refuse('That time has already passed.');
    }
    return { ok: true, value: { nextRunAt: new Date(at).toISOString(), recurrence: null } };
  }

  const timeLocal = repeatTime(when);
  if (!timeLocal) {
    return refuse('A repeating schedule needs `timeLocal` as "HH:MM", or an `at` to take it from.');
  }

  const recurrence = repeatRule(repeat, timeLocal, when, now);
  if (!recurrence.ok) {
    return recurrence;
  }

  // Through `seriesEdit`'s own recurrence check before it is used, so a rule
  // that would make the scheduler tick throw cannot be written by this path
  // either — one validator, not two spellings of one.
  const checked = seriesEdit({ recurrence: recurrence.value });
  if (checked.rejected.length || !checked.patch.recurrence) {
    return refuse('That repeat rule is not a valid recurrence.');
  }

  return {
    ok: true,
    value: {
      nextRunAt: computeNextRun(checked.patch.recurrence, now).toISOString(),
      recurrence: checked.patch.recurrence
    }
  };
}

/** An explicit `timeLocal` wins; otherwise the wall clock of `at`, if given. */
function repeatTime(when: ScheduleWhen): string | undefined {
  if (typeof when.timeLocal === 'string') {
    return TIME_PATTERN.test(when.timeLocal) ? when.timeLocal : undefined;
  }
  const at = parseInstant(when.at);
  // No `at` either is not an error to report from here — `planTiming` says what
  // is missing. A past `at` is fine for a repeating rule: only its clock is read.
  return at === undefined ? undefined : localTimeOf(at);
}

function repeatRule(
  repeat: Exclude<RepeatKind, 'once'>,
  timeLocal: string,
  when: ScheduleWhen,
  now: Date
): Verdict<Recurrence> {
  if (repeat === 'daily') {
    return { ok: true, value: { daysOfWeek: DAILY, timeLocal } };
  }

  if (repeat === 'weekly') {
    const days = parseDays(when.daysOfWeek);
    if (!days) {
      return refuse('A weekly rule needs `daysOfWeek`: whole numbers 0 (Sunday) to 6 (Saturday).');
    }
    return { ok: true, value: { daysOfWeek: days, timeLocal } };
  }

  // Monthly. An unstated day is the one the start date falls on, which is what
  // "monthly from this date" means and saves the agent a second argument.
  const dayOfMonth =
    when.dayOfMonth === undefined
      ? new Date(parseInstant(when.at) ?? now.getTime()).getDate()
      : when.dayOfMonth;

  if (!Number.isInteger(dayOfMonth) || (dayOfMonth as number) < 1 || (dayOfMonth as number) > 31) {
    return refuse('`dayOfMonth` must be a whole number from 1 to 31.');
  }
  return { ok: true, value: { daysOfWeek: [], timeLocal, dayOfMonth: dayOfMonth as number } };
}

///////////////////////////*Editing an existing series*////////////////////////////

/**
 * Validates an `update_schedule` patch against a series that exists.
 *
 * Every field is checked by `seriesEdit` — the manager's own validator, which
 * already closes `agent` to a known list, shape-checks `model` against what a
 * Windows shell would read as syntax, normalises `nextRunAt` and refuses
 * identity fields outright. The MCP rules are the two things it does not know:
 * `permissionMode` is refused rather than accepted, and a `nextRunAt` in the
 * past is refused rather than written.
 *
 * A rejected field fails the whole call instead of being quietly dropped. The
 * manager can drop one, because a human is looking at the control that did not
 * move; an agent is told, so it can say what it could not do.
 */
export function planSeriesUpdate(
  raw: unknown,
  series: TaskSeries | undefined,
  now: Date = new Date()
): Verdict<Partial<TaskSeries>> {
  if (!series) {
    return refuse('No scheduled task has that id. Call list_schedule for the current ids.');
  }
  if (raw && typeof raw === 'object' && 'permissionMode' in (raw as object)) {
    return refuse(PERMISSION_REFUSAL);
  }

  const { patch, rejected } = seriesEdit(raw);
  if (rejected.length) {
    return refuse(`Cannot set: ${rejected.join(', ')}.`);
  }
  if (!Object.keys(patch).length) {
    return refuse('Nothing to change.');
  }

  if (patch.nextRunAt !== undefined) {
    const target = Date.parse(patch.nextRunAt);
    if (now.getTime() - target > PAST_TOLERANCE_MS) {
      return refuse('That time has already passed.');
    }
  }

  return { ok: true, value: patch };
}

/**
 * The half of `schedule_plan` that is not timing: the overrides a new series is
 * born with. Run through `seriesEdit` for the same reason as above — `agent`,
 * `model`, `cwd` and `maxRetries` all leave the process when the run fires.
 */
export function planSeriesOverrides(raw: unknown): Verdict<Partial<TaskSeries>> {
  if (raw && typeof raw === 'object' && 'permissionMode' in (raw as object)) {
    return refuse(PERMISSION_REFUSAL);
  }

  const { patch, rejected } = seriesEdit(raw ?? {});
  if (rejected.length) {
    return refuse(`Cannot set: ${rejected.join(', ')}.`);
  }
  return { ok: true, value: patch };
}

///////////////////////////*Helpers*////////////////////////////

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const REPEAT_KINDS: readonly RepeatKind[] = ['once', 'daily', 'weekly', 'monthly'];

function isRepeatKind(value: unknown): value is RepeatKind {
  return REPEAT_KINDS.includes(value as RepeatKind);
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Sorted and deduplicated, or undefined if anything in the list is not a day. */
function parseDays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const days = new Set<number>();
  for (const entry of value) {
    if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) > 6) {
      return undefined;
    }
    days.add(entry as number);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * The wall clock of an instant, in the timezone of the machine that will run the
 * job — which is this one, since the agent spawns the server on the machine its
 * project lives on. A recurrence stores wall-clock time, not an instant, so this
 * is the conversion that makes "every night at 2am" survive a DST boundary.
 */
function localTimeOf(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

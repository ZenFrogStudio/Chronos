import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Action, decide, DecideInput } from '../src/decide';
import { DAILY, TaskRun, TaskSeries } from '../src/types';

/**
 * The scheduler's decisions, tested without a clock, a store or an editor.
 * Every case here was owed by PLAN.md Amendments 1 and 2 and went unwritten in
 * 0.4.0 because the logic was tangled with `vscode` imports.
 */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const MINUTE = 60_000;
const GRACE = 15 * MINUTE;

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath: 'D:\\plans\\refactor.md',
    fileName: 'refactor.md',
    cwd: 'D:\\repo',
    permissionMode: 'acceptEdits',
    recurrence: null,
    nextRunAt: new Date(NOW).toISOString(),
    enabled: true,
    maxRetries: 3,
    createdAt: new Date(NOW).toISOString(),
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    scheduledAt: new Date(NOW).toISOString(),
    status: 'pending',
    attempt: 1,
    ...overrides
  };
}

/** Deterministic ids, so assertions do not depend on randomUUID. */
function ids(): () => string {
  let n = 0;
  return () => `generated-${++n}`;
}

function act(overrides: Partial<DecideInput> = {}): Action[] {
  return decide({
    series: [],
    runs: [],
    now: NOW,
    graceMs: GRACE,
    reason: 'not-running',
    isSeriesRunning: () => false,
    freeSlots: 1,
    newId: ids(),
    ...overrides
  });
}

const starts = (actions: Action[]) => actions.filter((a) => a.kind === 'start');
const added = (actions: Action[]) =>
  actions.flatMap((a) => (a.kind === 'addRun' ? [a.run] : []));
const seriesPatch = (actions: Action[], id: string) =>
  actions.flatMap((a) => (a.kind === 'updateSeries' && a.id === id ? [a.patch] : []));

describe('decide — due occurrences', () => {
  it('should_materialise_and_start_a_due_occurrence_in_the_same_tick', () => {
    const s = series();

    const actions = act({ series: [s] });

    const created = added(actions);
    assert.equal(created.length, 1);
    assert.equal(created[0].scheduledAt, s.nextRunAt);
    assert.equal(starts(actions).length, 1);
  });

  it('should_not_fire_an_occurrence_that_is_not_yet_due', () => {
    const s = series({ nextRunAt: new Date(NOW + 5 * MINUTE).toISOString() });

    const actions = act({ series: [s] });

    assert.deepEqual(actions, []);
  });

  it('should_handle_a_task_scheduled_forty_days_out', () => {
    // The tick loop exists because setTimeout overflows past ~24.8 days and
    // fires immediately. Nothing had ever asserted it.
    const s = series({ nextRunAt: new Date(NOW + 40 * 24 * 60 * MINUTE).toISOString() });

    const actions = act({ series: [s] });

    assert.deepEqual(actions, []);
  });

  it('should_retire_a_one_shot_as_spent_rather_than_disabled', () => {
    const s = series();

    const actions = act({ series: [s] });

    assert.deepEqual(seriesPatch(actions, s.id), [{ spent: true }]);
  });

  it('should_advance_a_recurring_series_instead_of_retiring_it', () => {
    const s = series({ recurrence: { daysOfWeek: DAILY, timeLocal: '09:00' } });

    const actions = act({ series: [s] });

    const patches = seriesPatch(actions, s.id);
    assert.equal(patches.length, 1);
    assert.ok(patches[0].nextRunAt);
    assert.equal(patches[0].spent, undefined);
    assert.ok(Date.parse(patches[0].nextRunAt as string) > NOW);
  });
});

describe('decide — the enabled and spent flags', () => {
  it('should_never_fire_a_series_that_is_disabled', () => {
    const s = series({ enabled: false });

    const actions = act({ series: [s] });

    assert.deepEqual(actions, []);
  });

  it('should_not_fire_a_queued_retry_when_the_series_is_paused', () => {
    // D1: pausing a broken task must stop the retry already in flight.
    const s = series({ enabled: false });
    const retry = run({ attempt: 2 });

    const actions = act({ series: [s], runs: [retry] });

    assert.deepEqual(starts(actions), []);
  });

  it('should_still_fire_a_manual_run_on_a_paused_series', () => {
    // "Run now" exists precisely to fire something that is not scheduled.
    const s = series({ enabled: false });
    const manual = run({ manual: true });

    const actions = act({ series: [s], runs: [manual] });

    assert.equal(starts(actions).length, 1);
  });

  it('should_start_a_materialised_run_stranded_by_a_full_concurrency_gate', () => {
    // The regression that forced `spent` to exist: a one-shot fires, is
    // retired, finds no slot, and must still run on a later tick.
    const s = series({ spent: true });
    const stranded = run();

    const actions = act({ series: [s], runs: [stranded] });

    assert.equal(starts(actions).length, 1);
  });

  it('should_not_materialise_a_new_occurrence_for_a_spent_one_shot', () => {
    const s = series({ spent: true });

    const actions = act({ series: [s] });

    assert.deepEqual(added(actions), []);
  });
});

describe('decide — concurrency and overlap', () => {
  it('should_start_both_tasks_due_in_the_same_tick_when_slots_allow', () => {
    const a = series({ id: 'a', nextRunAt: new Date(NOW - MINUTE).toISOString() });
    const b = series({ id: 'b' });

    const actions = act({ series: [a, b], freeSlots: 2 });

    assert.equal(starts(actions).length, 2);
  });

  it('should_queue_rather_than_start_when_the_concurrency_gate_is_full', () => {
    const a = series({ id: 'a' });
    const b = series({ id: 'b' });

    const actions = act({ series: [a, b], freeSlots: 1 });

    assert.equal(starts(actions).length, 1);
    assert.equal(added(actions).length, 2); // both still materialised
  });

  it('should_start_nothing_when_no_slots_are_free', () => {
    const actions = act({ series: [series()], freeSlots: 0 });

    assert.deepEqual(starts(actions), []);
  });

  it('should_not_stack_a_second_run_on_a_series_already_running', () => {
    const s = series();
    const queued = run({ id: 'queued' });

    const actions = act({
      series: [s],
      runs: [queued],
      isSeriesRunning: (id) => id === s.id
    });

    assert.deepEqual(starts(actions), []);
  });

  it('should_start_the_earliest_due_run_first', () => {
    const a = series({ id: 'a' });
    const b = series({ id: 'b' });
    const late = run({ id: 'late', seriesId: 'a', scheduledAt: new Date(NOW - MINUTE).toISOString() });
    const early = run({ id: 'early', seriesId: 'b', scheduledAt: new Date(NOW - 5 * MINUTE).toISOString() });

    const actions = act({ series: [a, b], runs: [late, early], freeSlots: 1 });

    const started = starts(actions);
    assert.equal(started.length, 1);
    assert.equal(started[0].kind === 'start' && started[0].run.id, 'early');
  });
});

describe('decide — the grace window', () => {
  it('should_still_run_a_task_overdue_by_less_than_the_grace_window', () => {
    const s = series({ nextRunAt: new Date(NOW - 10 * MINUTE).toISOString() });

    const actions = act({ series: [s] });

    assert.equal(starts(actions).length, 1);
    assert.deepEqual(
      actions.filter((a) => a.kind === 'announceMissed'),
      []
    );
  });

  it('should_mark_a_task_missed_when_its_window_passed_during_suspend', () => {
    const s = series({ nextRunAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() });

    const actions = act({ series: [s], reason: 'sleep' });

    const created = added(actions);
    assert.equal(created.length, 1);
    assert.equal(created[0].status, 'missed');
    assert.equal(created[0].missedReason, 'sleep');
    assert.deepEqual(starts(actions), []);
  });

  it('should_miss_a_pending_run_whose_own_window_passed', () => {
    // A retry queued before a long sleep must not fire hours late either.
    const s = series({ spent: true });
    const stale = run({ scheduledAt: new Date(NOW - 3 * 60 * MINUTE).toISOString(), attempt: 2 });

    const actions = act({ series: [s], runs: [stale] });

    const patch = actions.find((a) => a.kind === 'updateRun');
    assert.ok(patch && patch.kind === 'updateRun');
    assert.equal(patch.patch.status, 'missed');
    assert.deepEqual(starts(actions), []);
  });

  it('should_announce_missed_occurrences_once_per_tick', () => {
    const a = series({ id: 'a', nextRunAt: new Date(NOW - 3 * 60 * MINUTE).toISOString() });
    const b = series({ id: 'b', nextRunAt: new Date(NOW - 4 * 60 * MINUTE).toISOString() });

    const actions = act({ series: [a, b], reason: 'sleep' });

    const announcements = actions.filter((a) => a.kind === 'announceMissed');
    assert.equal(announcements.length, 1);
    assert.equal(announcements[0].kind === 'announceMissed' && announcements[0].count, 2);
  });
});

describe('decide — catch-up after an outage', () => {
  it('should_collapse_a_week_long_outage_into_one_missed_run_then_advance', () => {
    const weekAgo = new Date(NOW - 7 * 24 * 60 * MINUTE).toISOString();
    const s = series({
      recurrence: { daysOfWeek: DAILY, timeLocal: '02:00' },
      nextRunAt: weekAgo
    });

    const actions = act({ series: [s], reason: 'sleep' });

    const created = added(actions);
    assert.equal(created.length, 1, 'one decision, not seven');
    assert.equal(created[0].status, 'missed');
    assert.ok((created[0].missedCount ?? 0) > 1);

    const patches = seriesPatch(actions, s.id);
    assert.equal(patches.length, 1);
    assert.ok(Date.parse(patches[0].nextRunAt as string) > NOW, 'advances to a future occurrence');
  });

  it('should_leave_next_run_at_untouched_when_a_retry_is_pending', () => {
    // Retries create runs; they never disturb the series' schedule.
    const s = series({
      recurrence: { daysOfWeek: DAILY, timeLocal: '09:00' },
      nextRunAt: new Date(NOW + 6 * 60 * MINUTE).toISOString()
    });
    const retry = run({ attempt: 3 });

    const actions = act({ series: [s], runs: [retry] });

    assert.deepEqual(seriesPatch(actions, s.id), []);
    assert.equal(starts(actions).length, 1);
  });
});

describe('decide — orphans', () => {
  it('should_drop_a_pending_run_whose_series_was_deleted', () => {
    const orphan = run({ seriesId: 'gone' });

    const actions = act({ runs: [orphan] });

    assert.deepEqual(actions, [{ kind: 'removeRun', id: orphan.id }]);
  });

  it('should_ignore_runs_that_are_not_pending', () => {
    const finished = run({ status: 'completed' });
    const missed = run({ id: 'run-2', status: 'missed' });

    const actions = act({ series: [series({ spent: true })], runs: [finished, missed] });

    assert.deepEqual(actions, []);
  });
});

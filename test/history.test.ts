import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pruneRuns } from '../src/history';
import { MAX_MISSED_RUNS, MAX_RECENT_RUNS, RunStatus, TaskRun } from '../src/types';

/**
 * The only place Chronos deletes something the user might still want, so the
 * rules are asserted rather than assumed.
 */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const MINUTE = 60_000;

/** `n` runs of one status, oldest first, so index order is age order. */
function many(status: RunStatus, count: number, prefix: string): TaskRun[] {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(NOW - (count - i) * MINUTE).toISOString();
    const run: TaskRun = {
      id: `${prefix}-${i}`,
      seriesId: 'series-1',
      scheduledAt: at,
      status,
      attempt: 1
    };
    if (status === 'missed') {
      return { ...run, missedAt: at };
    }
    return { ...run, finishedAt: at };
  });
}

const idsOf = (runs: TaskRun[]) => runs.map((r) => r.id);
const countOf = (runs: TaskRun[], status: RunStatus) =>
  runs.filter((r) => r.status === status).length;

describe('history — finished runs', () => {
  it('should_keep_everything_while_under_the_cap', () => {
    const runs = many('completed', 5, 'done');

    assert.deepEqual(idsOf(pruneRuns(runs)), idsOf(runs));
  });

  it('should_cap_finished_runs_at_the_limit', () => {
    const runs = many('completed', MAX_RECENT_RUNS + 20, 'done');

    assert.equal(countOf(pruneRuns(runs), 'completed'), MAX_RECENT_RUNS);
  });

  it('should_discard_the_oldest_finished_runs_not_the_newest', () => {
    const runs = many('completed', MAX_RECENT_RUNS + 1, 'done');

    const kept = idsOf(pruneRuns(runs));

    assert.ok(!kept.includes('done-0'), 'the oldest goes');
    assert.ok(kept.includes(`done-${MAX_RECENT_RUNS}`), 'the newest stays');
  });

  it('should_count_cancelled_and_failed_runs_against_the_same_cap', () => {
    const runs = [
      ...many('completed', 30, 'done'),
      ...many('failed', 30, 'bad'),
      ...many('cancelled', 30, 'stopped')
    ];

    assert.equal(pruneRuns(runs).length, MAX_RECENT_RUNS);
  });
});

describe('history — missed runs', () => {
  it('should_cap_missed_runs_on_their_own_more_generous_limit', () => {
    // The unbounded case: a catch-up decision nobody ever answers.
    const runs = many('missed', MAX_MISSED_RUNS + 20, 'missed');

    assert.equal(countOf(pruneRuns(runs), 'missed'), MAX_MISSED_RUNS);
  });

  it('should_not_let_finished_runs_push_out_a_missed_one', () => {
    // A missed run is still waiting for a decision; a completed one is history.
    const runs = [...many('completed', MAX_RECENT_RUNS + 50, 'done'), ...many('missed', 3, 'missed')];

    const kept = pruneRuns(runs);

    assert.equal(countOf(kept, 'missed'), 3);
    assert.equal(countOf(kept, 'completed'), MAX_RECENT_RUNS);
  });

  it('should_order_missed_runs_by_when_they_were_missed', () => {
    const runs = many('missed', MAX_MISSED_RUNS + 1, 'missed');

    const kept = idsOf(pruneRuns(runs));

    assert.ok(!kept.includes('missed-0'));
    assert.ok(kept.includes(`missed-${MAX_MISSED_RUNS}`));
  });
});

describe('history — runs still in flight', () => {
  it('should_never_drop_a_pending_run_however_much_history_there_is', () => {
    // Dropping one would cancel scheduled work with no trace.
    const pending = many('pending', 200, 'queued').map((r) => ({ ...r, finishedAt: undefined }));
    const runs = [...many('completed', MAX_RECENT_RUNS + 100, 'done'), ...pending];

    assert.equal(countOf(pruneRuns(runs), 'pending'), 200);
  });

  it('should_never_drop_a_running_run', () => {
    const running = many('running', 10, 'live').map((r) => ({ ...r, finishedAt: undefined }));
    const runs = [...many('completed', MAX_RECENT_RUNS + 100, 'done'), ...running];

    assert.equal(countOf(pruneRuns(runs), 'running'), 10);
  });
});

describe('history — leaving the input alone', () => {
  it('should_not_mutate_the_array_it_was_given', () => {
    const runs = many('completed', MAX_RECENT_RUNS + 5, 'done');
    const before = idsOf(runs);

    pruneRuns(runs);

    assert.deepEqual(idsOf(runs), before, 'sorting must not reorder the caller’s array');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildActivity } from '../src/activity';
import { DAILY, TaskRun, TaskSeries } from '../src/types';

/**
 * The Runs panel's only real logic: what counts as upcoming, what counts as
 * already happened, and what order each is in. Tested here rather than in the
 * webview, where nothing can reach it.
 */

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 'series-1',
    filePath: 'D:\\plans\\refactor.md',
    fileName: 'refactor.md',
    cwd: 'D:\\repo',
    permissionMode: 'acceptEdits',
    recurrence: null,
    nextRunAt: at(60 * MINUTE),
    enabled: true,
    maxRetries: 3,
    createdAt: at(-24 * 60 * MINUTE),
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    scheduledAt: at(-30 * MINUTE),
    status: 'completed',
    attempt: 1,
    finishedAt: at(-25 * MINUTE),
    ...overrides
  };
}

const build = (s: TaskSeries[], r: TaskRun[] = []) => buildActivity(s, r, NOW);
const idsOf = (entries: { runId?: string; seriesId: string }[]) =>
  entries.map((e) => e.runId ?? e.seriesId);

describe('activity — what is upcoming', () => {
  it('should_list_an_active_series_next_occurrence', () => {
    const s = series();

    const { upcoming } = build([s]);

    assert.equal(upcoming.length, 1);
    assert.equal(upcoming[0].seriesId, s.id);
    assert.equal(upcoming[0].at, s.nextRunAt);
    assert.equal(upcoming[0].runId, undefined, 'no run record exists yet');
  });

  it('should_order_upcoming_entries_soonest_first', () => {
    const later = series({ id: 'later', nextRunAt: at(6 * 60 * MINUTE) });
    const sooner = series({ id: 'sooner', nextRunAt: at(30 * MINUTE) });

    const { upcoming } = build([later, sooner]);

    assert.deepEqual(idsOf(upcoming), ['sooner', 'later']);
  });

  it('should_not_list_a_paused_series', () => {
    const s = series({ enabled: false });

    assert.deepEqual(build([s]).upcoming, []);
  });

  it('should_not_list_a_spent_one_shot', () => {
    const s = series({ spent: true });

    assert.deepEqual(build([s]).upcoming, []);
  });

  it('should_list_a_retry_queued_for_a_future_time', () => {
    // The scheduler queues a retry an hour out; it is real, and it is upcoming.
    const s = series();
    const retry = run({ id: 'retry', status: 'pending', attempt: 2, scheduledAt: at(60 * MINUTE), finishedAt: undefined });

    const { upcoming, recent } = build([s], [retry]);

    assert.ok(idsOf(upcoming).includes('retry'));
    assert.deepEqual(recent, []);
  });

  it('should_treat_a_pending_run_that_is_already_due_as_recent_not_upcoming', () => {
    // A due `pending` run is waiting for a slot, not waiting for the clock.
    const s = series({ spent: true });
    const due = run({ id: 'due', status: 'pending', scheduledAt: at(-MINUTE), finishedAt: undefined });

    const { upcoming, recent } = build([s], [due]);

    assert.deepEqual(upcoming, []);
    assert.deepEqual(idsOf(recent), ['due']);
  });
});

describe('activity — what has already happened', () => {
  it('should_order_recent_entries_newest_first', () => {
    const s = series({ spent: true });
    const older = run({ id: 'older', finishedAt: at(-3 * 60 * MINUTE) });
    const newer = run({ id: 'newer', finishedAt: at(-10 * MINUTE) });

    const { recent } = build([s], [older, newer]);

    assert.deepEqual(idsOf(recent), ['newer', 'older']);
  });

  it('should_order_a_missed_run_by_when_it_was_missed', () => {
    // Its `scheduledAt` is days old; what matters is when the decision landed.
    const s = series({ spent: true });
    const missed = run({
      id: 'missed',
      status: 'missed',
      scheduledAt: at(-5 * 24 * 60 * MINUTE),
      finishedAt: undefined,
      missedAt: at(-MINUTE)
    });
    const finished = run({ id: 'finished', finishedAt: at(-30 * MINUTE) });

    const { recent } = build([s], [finished, missed]);

    assert.deepEqual(idsOf(recent), ['missed', 'finished']);
  });

  it('should_include_a_run_in_flight', () => {
    const s = series({ spent: true });
    const live = run({ id: 'live', status: 'running', startedAt: at(-4 * MINUTE), finishedAt: undefined });

    const { recent } = build([s], [live]);

    assert.deepEqual(idsOf(recent), ['live']);
  });

  it('should_keep_a_run_whose_series_was_removed_and_label_it', () => {
    // Unscheduling a plan does not un-happen last night's run.
    const orphan = run({ id: 'orphan', seriesId: 'gone' });

    const { recent } = build([], [orphan]);

    assert.deepEqual(idsOf(recent), ['orphan']);
    assert.equal(recent[0].planTitle, 'Removed plan');
  });
});

describe('activity — plan titles', () => {
  it('should_drop_the_markdown_extension_from_the_plan_title', () => {
    const s = series({ fileName: 'Daily standup.md' });

    const { upcoming } = build([s]);

    assert.equal(upcoming[0].planTitle, 'Daily standup');
  });

  it('should_label_every_entry_with_its_own_plan', () => {
    const standup = series({ id: 'a', fileName: 'standup.md', recurrence: { daysOfWeek: DAILY, timeLocal: '09:00' } });
    const audit = series({ id: 'b', fileName: 'audit.md', nextRunAt: at(2 * 60 * MINUTE) });
    const auditRun = run({ id: 'audit-run', seriesId: 'b' });

    const { upcoming, recent } = build([standup, audit], [auditRun]);

    assert.deepEqual(upcoming.map((e) => e.planTitle), ['standup', 'audit']);
    assert.deepEqual(recent.map((e) => e.planTitle), ['audit']);
  });
});

describe('activity — nothing to show', () => {
  it('should_return_two_empty_lists_for_empty_inputs', () => {
    assert.deepEqual(buildActivity([], [], NOW), { upcoming: [], recent: [] });
  });
});

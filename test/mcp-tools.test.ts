import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PERMISSION_REFUSAL,
  planSeriesOverrides,
  planSeriesUpdate,
  planTiming,
  ScheduleWhen,
  Timing,
  Verdict
} from '../src/mcp-tools';
import { TaskSeries } from '../src/types';

/**
 * The MCP boundary as assertions, in the style of `command.test.ts`.
 *
 * The `permissionMode` cases are the ones that matter most: they are the whole
 * of what stops a connected agent granting itself unattended, recurring,
 * unrestricted tool access on this machine. Everything else here is the ordinary
 * argument checking that keeps a malformed call out of the scheduler tick.
 */

const NOW = new Date('2026-08-13T12:00:00.000Z');
const HOUR = 60 * 60_000;

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 's1',
    filePath: 'D:\\repo\\.chronos\\plans\\nightly.md',
    fileName: 'nightly.md',
    cwd: 'D:\\repo',
    permissionMode: 'auto',
    recurrence: null,
    nextRunAt: new Date(NOW.getTime() + HOUR).toISOString(),
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-08-01T09:00:00.000Z',
    ...overrides
  };
}

/** The accepted value, or fails the test with the refusal that came back. */
function valueOf<T>(verdict: Verdict<T>): T {
  assert.ok(verdict.ok, `expected acceptance, got: ${verdict.ok ? '' : verdict.reason}`);
  return verdict.value;
}

/** The refusal reason, or fails the test because the call was accepted. */
function reasonOf(verdict: Verdict<unknown>): string {
  assert.ok(!verdict.ok, 'expected a refusal, got acceptance');
  return verdict.reason;
}

const schedule = (when: ScheduleWhen): Verdict<Timing> => planTiming(when, NOW);

describe('mcp permission mode', () => {
  it('should_refuse_to_set_permission_mode_when_scheduling', () => {
    const verdict = planSeriesOverrides({ permissionMode: 'bypassPermissions' });

    assert.equal(reasonOf(verdict), PERMISSION_REFUSAL);
  });

  it('should_refuse_to_set_permission_mode_when_updating', () => {
    const verdict = planSeriesUpdate({ permissionMode: 'bypassPermissions' }, series(), NOW);

    assert.equal(reasonOf(verdict), PERMISSION_REFUSAL);
  });

  it('should_refuse_even_the_mode_a_new_task_already_has', () => {
    // Not a value check — the field itself is off limits. Accepting `auto`
    // would make this a list of allowed modes, which is one edit away from
    // being the wrong list.
    assert.equal(reasonOf(planSeriesOverrides({ permissionMode: 'auto' })), PERMISSION_REFUSAL);
  });

  it('should_refuse_it_alongside_fields_that_are_perfectly_valid', () => {
    // The whole call fails rather than the one field being dropped: an agent
    // that got a partial success would report the whole thing as done.
    const verdict = planSeriesUpdate(
      { enabled: false, permissionMode: 'bypassPermissions' },
      series(),
      NOW
    );

    assert.equal(reasonOf(verdict), PERMISSION_REFUSAL);
  });
});

describe('mcp schedule timing', () => {
  it('should_accept_a_one_off_at_a_future_instant', () => {
    const timing = valueOf(schedule({ at: '2026-08-13T14:30:00.000Z' }));

    assert.equal(timing.nextRunAt, '2026-08-13T14:30:00.000Z');
    assert.equal(timing.recurrence, null);
  });

  it('should_refuse_a_one_off_in_the_past', () => {
    const verdict = schedule({ at: '2026-08-13T09:00:00.000Z' });

    assert.match(reasonOf(verdict), /already passed/);
  });

  it('should_let_a_time_a_few_minutes_past_through_to_fire', () => {
    // Same tolerance as `command.ts`: a moment ago is a request to run now, not
    // a mistake, and the grace window downstream already handles it.
    const timing = valueOf(schedule({ at: new Date(NOW.getTime() - 60_000).toISOString() }));

    assert.equal(timing.recurrence, null);
  });

  it('should_refuse_a_one_off_with_no_time_at_all', () => {
    assert.match(reasonOf(schedule({})), /needs `at`/);
  });

  it('should_refuse_a_nonsense_repeat_rule', () => {
    assert.match(reasonOf(schedule({ at: '2026-08-14T02:00:00.000Z', repeat: 'hourly' })), /once, daily/);
  });

  it('should_turn_daily_into_all_seven_days', () => {
    const timing = valueOf(schedule({ repeat: 'daily', timeLocal: '02:00' }));

    assert.deepEqual(timing.recurrence?.daysOfWeek, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(timing.recurrence?.timeLocal, '02:00');
  });

  it('should_turn_weekly_into_the_days_it_was_given_sorted_and_deduplicated', () => {
    const timing = valueOf(
      schedule({ repeat: 'weekly', timeLocal: '02:00', daysOfWeek: [5, 1, 3, 1] })
    );

    assert.deepEqual(timing.recurrence?.daysOfWeek, [1, 3, 5]);
  });

  it('should_refuse_a_weekly_rule_with_no_days', () => {
    assert.match(reasonOf(schedule({ repeat: 'weekly', timeLocal: '02:00' })), /daysOfWeek/);
  });

  it('should_refuse_a_weekly_rule_naming_a_day_that_does_not_exist', () => {
    const verdict = schedule({ repeat: 'weekly', timeLocal: '02:00', daysOfWeek: [1, 9] });

    assert.match(reasonOf(verdict), /daysOfWeek/);
  });

  it('should_turn_monthly_into_a_day_of_month_rule_with_no_weekdays', () => {
    const timing = valueOf(schedule({ repeat: 'monthly', timeLocal: '02:00', dayOfMonth: 15 }));

    assert.equal(timing.recurrence?.dayOfMonth, 15);
    assert.deepEqual(timing.recurrence?.daysOfWeek, []);
  });

  it('should_refuse_a_day_of_month_outside_the_calendar', () => {
    const verdict = schedule({ repeat: 'monthly', timeLocal: '02:00', dayOfMonth: 32 });

    assert.match(reasonOf(verdict), /dayOfMonth/);
  });

  it('should_refuse_a_repeating_rule_with_no_time_to_run_at', () => {
    assert.match(reasonOf(schedule({ repeat: 'daily' })), /timeLocal/);
  });

  it('should_refuse_a_time_that_is_not_a_wall_clock', () => {
    assert.match(reasonOf(schedule({ repeat: 'daily', timeLocal: '25:00' })), /timeLocal/);
  });

  it('should_derive_the_first_run_from_the_rule_rather_than_from_at', () => {
    // A first occurrence at a different minute from every one after it is the
    // bug this prevents: the rule is the source of truth, `at` only seeds it.
    const timing = valueOf(schedule({ repeat: 'daily', timeLocal: '02:00' }));
    const first = new Date(timing.nextRunAt);

    assert.equal(first.getHours(), 2);
    assert.equal(first.getMinutes(), 0);
    assert.ok(first.getTime() > NOW.getTime(), 'the first run must be in the future');
  });

  it('should_allow_a_repeating_rule_to_take_its_clock_from_a_past_at', () => {
    // Only the wall clock of `at` is read for a repeating rule, so a date in
    // the past is a legitimate "every day at this time, starting from then".
    const timing = valueOf(schedule({ repeat: 'daily', at: '2026-08-01T02:30:00.000Z' }));

    assert.ok(timing.recurrence, 'expected a recurrence');
    assert.ok(Date.parse(timing.nextRunAt) > NOW.getTime(), 'the first run must be in the future');
  });
});

describe('mcp schedule overrides', () => {
  it('should_pass_a_valid_patch_through_series_edit_intact', () => {
    const patch = valueOf(
      planSeriesOverrides({ agent: 'opencode', model: 'opencode/big-pickle', maxRetries: 0 })
    );

    assert.deepEqual(patch, { agent: 'opencode', model: 'opencode/big-pickle', maxRetries: 0 });
  });

  it('should_refuse_an_engine_this_build_does_not_know_about', () => {
    assert.match(reasonOf(planSeriesOverrides({ agent: 'rm -rf' })), /agent/);
  });

  it('should_refuse_a_model_id_a_shell_would_read_as_syntax', () => {
    // `runner.ts` spawns through a shell on Windows, where Node does not quote
    // arguments — so this is the same guarantee `edit.ts` makes for the manager.
    assert.match(reasonOf(planSeriesOverrides({ model: 'opus && calc.exe' })), /model/);
  });

  it('should_refuse_the_fields_that_decide_which_file_runs', () => {
    const verdict = planSeriesOverrides({ filePath: 'D:\\somewhere\\else.md' });

    assert.match(reasonOf(verdict), /filePath/);
  });

  it('should_refuse_a_field_it_has_never_heard_of', () => {
    assert.match(reasonOf(planSeriesOverrides({ sudo: true })), /sudo/);
  });

  it('should_accept_an_empty_override_set', () => {
    assert.deepEqual(valueOf(planSeriesOverrides({})), {});
  });
});

describe('mcp schedule updates', () => {
  it('should_refuse_an_id_that_names_no_series', () => {
    assert.match(reasonOf(planSeriesUpdate({ enabled: false }, undefined, NOW)), /list_schedule/);
  });

  it('should_pause_a_series', () => {
    assert.deepEqual(valueOf(planSeriesUpdate({ enabled: false }, series(), NOW)), {
      enabled: false
    });
  });

  it('should_refuse_a_new_time_that_has_already_passed', () => {
    const verdict = planSeriesUpdate({ nextRunAt: '2026-08-13T09:00:00.000Z' }, series(), NOW);

    assert.match(reasonOf(verdict), /already passed/);
  });

  it('should_normalise_an_accepted_time_to_utc', () => {
    const patch = valueOf(planSeriesUpdate({ nextRunAt: '2026-08-13T14:30:00Z' }, series(), NOW));

    assert.equal(patch.nextRunAt, '2026-08-13T14:30:00.000Z');
  });

  it('should_refuse_a_call_that_changes_nothing', () => {
    // Otherwise an agent gets a success for a call that did not happen.
    assert.match(reasonOf(planSeriesUpdate({}, series(), NOW)), /Nothing to change/);
  });

  it('should_refuse_to_repoint_a_series_at_another_file', () => {
    const verdict = planSeriesUpdate({ filePath: 'D:\\repo\\evil.md' }, series(), NOW);

    assert.match(reasonOf(verdict), /filePath/);
  });

  it('should_clear_a_recurrence_when_asked_for_a_one_shot', () => {
    const patch = valueOf(
      planSeriesUpdate({ recurrence: null }, series({ recurrence: { daysOfWeek: [1], timeLocal: '02:00' } }), NOW)
    );

    assert.equal(patch.recurrence, null);
  });

  it('should_refuse_a_recurrence_the_scheduler_tick_would_throw_on', () => {
    // An empty `daysOfWeek` makes `computeNextRun` throw inside the tick, which
    // would stop every task in the folder from running — not just this one.
    const verdict = planSeriesUpdate(
      { recurrence: { daysOfWeek: [], timeLocal: '02:00' } },
      series(),
      NOW
    );

    assert.match(reasonOf(verdict), /recurrence/);
  });
});

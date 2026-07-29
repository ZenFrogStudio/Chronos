// Must be set before any Date is constructed. npm on Windows runs scripts
// through cmd.exe, where an inline `TZ=... node` prefix is not valid.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advancePast, computeNextRun } from '../src/recurrence';
import { DAILY, Recurrence } from '../src/types';

/**
 * These tests assume TZ=America/New_York, set by the npm test script, because
 * the DST cases need a zone that actually observes it.
 */

const daily = (timeLocal: string): Recurrence => ({ daysOfWeek: DAILY, timeLocal });
const weekly = (daysOfWeek: number[], timeLocal: string): Recurrence => ({
  daysOfWeek,
  timeLocal
});

/** Local-time assertion helper — the whole point is what the wall clock reads. */
function assertLocal(actual: Date, expected: string): void {
  const pad = (n: number) => String(n).padStart(2, '0');
  const got =
    `${actual.getFullYear()}-${pad(actual.getMonth() + 1)}-${pad(actual.getDate())} ` +
    `${pad(actual.getHours())}:${pad(actual.getMinutes())}`;
  assert.equal(got, expected);
}

describe('computeNextRun', () => {
  it('should_return_today_when_the_time_has_not_yet_passed', () => {
    const after = new Date(2026, 6, 26, 8, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-07-26 09:00');
  });

  it('should_roll_to_tomorrow_when_todays_time_has_already_passed', () => {
    const after = new Date(2026, 6, 26, 9, 30);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-07-27 09:00');
  });

  it('should_roll_to_tomorrow_when_the_time_is_exactly_now', () => {
    const after = new Date(2026, 6, 26, 9, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-07-27 09:00');
  });

  it('should_wrap_from_sunday_to_the_next_matching_weekday', () => {
    // Sunday 2026-07-26. Rule fires Mon/Wed/Fri.
    const after = new Date(2026, 6, 26, 12, 0);
    const next = computeNextRun(weekly([1, 3, 5], '09:00'), after);
    assertLocal(next, '2026-07-27 09:00');
  });

  it('should_wrap_from_friday_forward_to_monday', () => {
    // Friday 2026-07-31 after the fire time; next Mon/Wed/Fri is Monday.
    const after = new Date(2026, 6, 31, 10, 0);
    const next = computeNextRun(weekly([1, 3, 5], '09:00'), after);
    assertLocal(next, '2026-08-03 09:00');
  });

  it('should_return_the_same_weekday_next_week_for_a_single_day_rule', () => {
    const after = new Date(2026, 6, 27, 10, 0); // Monday, past the time
    const next = computeNextRun(weekly([1], '09:00'), after);
    assertLocal(next, '2026-08-03 09:00');
  });

  it('should_hold_local_wall_clock_time_across_the_spring_dst_transition', () => {
    // US DST starts Sunday 2026-03-08. 09:00 must stay 09:00, not become 10:00.
    const after = new Date(2026, 2, 7, 12, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-03-08 09:00');
  });

  it('should_hold_local_wall_clock_time_across_the_autumn_dst_transition', () => {
    // US DST ends Sunday 2026-11-01.
    const after = new Date(2026, 9, 31, 12, 0);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-11-01 09:00');
  });

  it('should_advance_by_exactly_one_calendar_day_across_spring_forward', () => {
    // The gap is 23 real hours, but the rule is a wall-clock rule.
    const after = new Date(2026, 2, 8, 9, 30);
    const next = computeNextRun(daily('09:00'), after);
    assertLocal(next, '2026-03-09 09:00');
  });

  it('should_throw_when_the_rule_has_no_days', () => {
    assert.throws(() => computeNextRun(weekly([], '09:00'), new Date(2026, 6, 26)));
  });

  it('should_throw_when_the_time_is_malformed', () => {
    assert.throws(() => computeNextRun(daily('not-a-time'), new Date(2026, 6, 26)));
  });
});

describe('advancePast — catch-up after an outage', () => {
  it('should_not_skip_anything_when_the_next_occurrence_is_still_ahead', () => {
    // Arrange: due at 09:00, currently 08:30 on the same day.
    const from = new Date(2026, 6, 26, 8, 0);
    const now = new Date(2026, 6, 26, 8, 30);

    // Act
    const { next, skipped } = advancePast(daily('09:00'), from, now);

    // Assert
    assert.equal(skipped, 0);
    assertLocal(next, '2026-07-26 09:00');
  });

  it('should_collapse_a_week_long_outage_into_a_single_catch_up', () => {
    // Arrange: missed 2026-07-20 09:00, machine back on 2026-07-26 12:00.
    // Occurrences 20th–26th inclusive is seven; six lie beyond the first.
    const from = new Date(2026, 6, 20, 9, 0);
    const now = new Date(2026, 6, 26, 12, 0);

    // Act
    const { next, skipped } = advancePast(daily('09:00'), from, now);

    // Assert
    assert.equal(skipped, 6);
    assertLocal(next, '2026-07-27 09:00');
  });

  it('should_land_on_a_strictly_future_occurrence', () => {
    const from = new Date(2026, 6, 20, 9, 0);
    const now = new Date(2026, 6, 26, 12, 0);

    const { next } = advancePast(daily('09:00'), from, now);

    assert.ok(next.getTime() > now.getTime());
  });

  it('should_respect_weekday_rules_while_catching_up', () => {
    // Arrange: Mon/Wed/Fri rule, missed Mon 2026-07-20, back Sun 2026-07-26.
    const from = new Date(2026, 6, 20, 9, 0);
    const now = new Date(2026, 6, 26, 12, 0);

    // Act: skipped should be Wed 22nd and Fri 24th only.
    const { next, skipped } = advancePast(weekly([1, 3, 5], '09:00'), from, now);

    // Assert
    assert.equal(skipped, 2);
    assertLocal(next, '2026-07-27 09:00');
  });
});

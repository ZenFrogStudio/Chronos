import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseResultEnvelope, resolveOutcome, watchdogVerdict } from '../src/outcome';
import { truncateError } from '../src/time';
import { ERROR_MAX_CHARS } from '../src/types';

/** A well-formed final result event, as emitted by --output-format stream-json. */
function resultEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'sess-1',
    total_cost_usd: 0.17,
    num_turns: 3,
    permission_denials: [],
    ...overrides
  });
}

const INIT_EVENT = '{"type":"system","subtype":"init","session_id":"sess-1"}';

describe('resolveOutcome — happy path', () => {
  it('should_report_success_and_carry_session_cost_and_turns', () => {
    // Arrange
    const stdout = `${INIT_EVENT}\n${resultEvent()}`;

    // Act
    const outcome = resolveOutcome({ exitCode: 0, stdout });

    // Assert
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionId, 'sess-1');
    assert.equal(outcome.costUsd, 0.17);
    assert.equal(outcome.numTurns, 3);
    assert.equal(outcome.denials, 0);
  });

  it('should_succeed_but_record_denials_when_tools_were_blocked', () => {
    // A run can exit 0 with tools gated. Reporting plain success would hide
    // that the plan only partly executed.
    const stdout = resultEvent({ permission_denials: [{ tool: 'Bash' }, { tool: 'Write' }] });

    const outcome = resolveOutcome({ exitCode: 0, stdout });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.denials, 2);
  });

  it('should_not_retry_a_run_that_succeeded_with_denials', () => {
    // Retrying hits the same permission gate, so it can never clear.
    const stdout = resultEvent({ permission_denials: [{ tool: 'Bash' }] });

    const outcome = resolveOutcome({ exitCode: 0, stdout });

    assert.equal(outcome.retryable, false);
  });
});

describe('resolveOutcome — failure modes', () => {
  it('should_fail_and_allow_retry_when_the_exit_code_is_nonzero', () => {
    const outcome = resolveOutcome({ exitCode: 1, stdout: resultEvent() });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, true);
  });

  it('should_preserve_the_session_id_from_a_failed_run', () => {
    // Needed if the run is ever resumed rather than restarted.
    const outcome = resolveOutcome({ exitCode: 1, stdout: resultEvent() });

    assert.equal(outcome.sessionId, 'sess-1');
  });

  it('should_fail_when_the_result_event_reports_is_error', () => {
    const stdout = resultEvent({ is_error: true, result: 'rate limit exceeded' });

    const outcome = resolveOutcome({ exitCode: 0, stdout });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'rate limit exceeded');
    assert.equal(outcome.retryable, true);
  });

  it('should_fail_when_exit_is_zero_but_no_result_event_was_emitted', () => {
    // Treating this as success would mark an unfinished plan complete.
    const outcome = resolveOutcome({ exitCode: 0, stdout: INIT_EVENT });

    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /No result event/);
  });

  it('should_fail_when_stdout_is_empty', () => {
    const outcome = resolveOutcome({ exitCode: 0, stdout: '' });

    assert.equal(outcome.ok, false);
  });

  it('should_fail_when_stdout_is_not_json_at_all', () => {
    const outcome = resolveOutcome({ exitCode: 0, stdout: 'command not found' });

    assert.equal(outcome.ok, false);
  });

  it('should_fail_when_the_process_died_without_an_exit_code', () => {
    const outcome = resolveOutcome({ exitCode: null, stdout: resultEvent() });

    assert.equal(outcome.ok, false);
  });
});

describe('resolveOutcome — kills', () => {
  it('should_fail_and_allow_retry_when_killed_for_idling', () => {
    const outcome = resolveOutcome({ exitCode: null, stdout: '', killReason: 'idle' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, true);
    assert.match(outcome.error ?? '', /idle/i);
  });

  it('should_fail_and_allow_retry_when_killed_for_exceeding_max_runtime', () => {
    const outcome = resolveOutcome({ exitCode: null, stdout: '', killReason: 'runtime' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, true);
  });

  it('should_not_retry_a_run_the_user_cancelled', () => {
    const outcome = resolveOutcome({ exitCode: null, stdout: '', killReason: 'cancelled' });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
  });

  it('should_retry_a_run_interrupted_by_shutdown', () => {
    const outcome = resolveOutcome({ exitCode: null, stdout: '', killReason: 'shutdown' });

    assert.equal(outcome.retryable, true);
  });

  it('should_treat_a_kill_as_authoritative_over_a_successful_result_event', () => {
    // The process was killed after emitting a result; the kill wins.
    const outcome = resolveOutcome({
      exitCode: 0,
      stdout: resultEvent(),
      killReason: 'runtime'
    });

    assert.equal(outcome.ok, false);
  });
});

describe('parseResultEnvelope — malformed streams', () => {
  it('should_ignore_a_truncated_progress_line_and_use_the_later_result', () => {
    // Stream chunks can split mid-line.
    const stdout = `{"type":"assistant","message":{"content":[{"type":"tex\n${resultEvent()}`;

    assert.equal(resolveOutcome({ exitCode: 0, stdout }).ok, true);
  });

  it('should_use_the_last_result_event_when_several_are_present', () => {
    const stdout = `${resultEvent({ is_error: true, result: 'stale' })}\n${resultEvent()}`;

    assert.equal(resolveOutcome({ exitCode: 0, stdout }).ok, true);
  });

  it('should_ignore_blank_and_non_object_lines', () => {
    const stdout = `\n\nnull\n[]\n${resultEvent()}\n\n`;

    assert.equal(parseResultEnvelope(stdout)?.session_id, 'sess-1');
  });

  it('should_return_undefined_when_no_result_event_exists', () => {
    assert.equal(parseResultEnvelope(INIT_EVENT), undefined);
  });
});

describe('resolveOutcome — authentication', () => {
  it('should_not_retry_a_run_that_failed_authentication', () => {
    // An expired token fails every task identically; three retries an hour
    // apart only delay the discovery by three hours.
    const stdout = resultEvent({ is_error: true, result: 'Invalid API key · Please run /login' });

    const outcome = resolveOutcome({ exitCode: 1, stdout });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.authFailure, true);
  });

  it('should_detect_an_auth_failure_from_the_api_error_status', () => {
    const stdout = resultEvent({ is_error: true, api_error_status: 401, result: 'request failed' });

    const outcome = resolveOutcome({ exitCode: 1, stdout });

    assert.equal(outcome.authFailure, true);
    assert.equal(outcome.retryable, false);
  });

  it('should_still_retry_an_ordinary_failure', () => {
    const stdout = resultEvent({ is_error: true, result: 'The plan referenced a missing file.' });

    const outcome = resolveOutcome({ exitCode: 1, stdout });

    assert.equal(outcome.retryable, true);
    assert.equal(outcome.authFailure, undefined);
  });

  it('should_not_misread_a_successful_run_that_merely_mentions_a_401', () => {
    // The agent writing *about* an auth error is not an auth error.
    const stdout = resultEvent({ result: 'Added handling for unauthorized 401 responses.' });

    const outcome = resolveOutcome({ exitCode: 0, stdout });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.authFailure, undefined);
  });

  it('should_preserve_session_and_cost_from_an_auth_failure', () => {
    const stdout = resultEvent({ is_error: true, result: 'Unauthorized' });

    const outcome = resolveOutcome({ exitCode: 1, stdout });

    assert.equal(outcome.sessionId, 'sess-1');
    assert.equal(outcome.costUsd, 0.17);
  });
});

describe('watchdogVerdict', () => {
  const MINUTE = 60_000;
  const IDLE = 15 * MINUTE;
  const MAX = 60 * MINUTE;
  const NOW = Date.parse('2026-07-26T12:00:00.000Z');

  const active = (overrides: Partial<Parameters<typeof watchdogVerdict>[0]> = {}) => ({
    startedAtMs: NOW - MINUTE,
    lastOutputAtMs: NOW - MINUTE,
    ...overrides
  });

  it('should_leave_a_healthy_run_alone', () => {
    assert.equal(watchdogVerdict(active(), NOW, IDLE, MAX), undefined);
  });

  it('should_kill_a_run_that_exceeded_the_idle_timeout', () => {
    const stalled = active({ lastOutputAtMs: NOW - 20 * MINUTE });

    assert.equal(watchdogVerdict(stalled, NOW, IDLE, MAX), 'idle');
  });

  it('should_kill_a_run_that_exceeded_the_maximum_runtime', () => {
    const overrunning = active({ startedAtMs: NOW - 90 * MINUTE, lastOutputAtMs: NOW });

    assert.equal(watchdogVerdict(overrunning, NOW, IDLE, MAX), 'runtime');
  });

  it('should_report_runtime_rather_than_idle_when_both_apply', () => {
    const both = active({ startedAtMs: NOW - 90 * MINUTE, lastOutputAtMs: NOW - 20 * MINUTE });

    assert.equal(watchdogVerdict(both, NOW, IDLE, MAX), 'runtime');
  });

  it('should_not_kill_a_run_that_only_just_resumed_after_a_long_suspend', () => {
    // Windows fires suspended timers on resume. A timer-based watchdog would
    // kill a task that had just woken and produced output.
    const justWoken = active({ startedAtMs: NOW - 8 * 60 * MINUTE, lastOutputAtMs: NOW });

    assert.equal(watchdogVerdict(justWoken, NOW, IDLE, 12 * 60 * MINUTE), undefined);
  });

  it('should_not_stack_a_second_kill_reason_on_a_dying_run', () => {
    const dying = active({ lastOutputAtMs: NOW - 20 * MINUTE, killReason: 'cancelled' as const });

    assert.equal(watchdogVerdict(dying, NOW, IDLE, MAX), undefined);
  });
});

describe('truncateError', () => {
  it('should_leave_a_short_message_unchanged', () => {
    assert.equal(truncateError('  boom  '), 'boom');
  });

  it('should_cap_an_oversized_message', () => {
    const outcome = truncateError('x'.repeat(ERROR_MAX_CHARS + 500));

    assert.equal(outcome.length, ERROR_MAX_CHARS + 3);
    assert.match(outcome, /\.\.\.$/);
  });
});

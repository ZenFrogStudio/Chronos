import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toRemoteRun, toRemoteSeries } from '../src/remote';
import { TaskRun, TaskSeries } from '../src/types';

/** Distinctive enough that finding it anywhere in the payload is unambiguous. */
const SECRET_PATH = 'D:\\clients\\acme-confidential\\repo';

/** What actually reaches the wire, regardless of the declared type. */
const keys = (value: object): string[] => Object.keys(value);

function series(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: 's1',
    filePath: `${SECRET_PATH}\\plans\\nightly.md`,
    fileName: 'nightly.md',
    cwd: SECRET_PATH,
    permissionMode: 'bypassPermissions',
    recurrence: null,
    nextRunAt: '2026-07-30T18:30:00.000Z',
    enabled: true,
    maxRetries: 3,
    createdAt: '2026-07-01T09:00:00.000Z',
    ...overrides
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'r1',
    seriesId: 's1',
    scheduledAt: '2026-07-30T18:30:00.000Z',
    status: 'completed',
    attempt: 1,
    logPath: `${SECRET_PATH}\\logs\\r1.log`,
    resultPath: `${SECRET_PATH}\\results\\nightly\\r1.md`,
    sessionId: 'sess-abc-123',
    exitCode: 0,
    costUsd: 0.23,
    result: 'Updated the changelog and pushed.',
    ...overrides
  };
}

describe('toRemoteSeries — the privacy boundary', () => {
  it('should_never_include_a_local_filesystem_path_anywhere_in_the_payload', () => {
    // The guarantee stated in REMOTE-PLAN.md §3, asserted rather than trusted.
    const payload = JSON.stringify(toRemoteSeries(series()));

    assert.ok(!payload.includes('acme-confidential'), payload);
  });

  it('should_drop_file_path_and_cwd_entirely', () => {
    const present = keys(toRemoteSeries(series()));

    assert.ok(!present.includes('filePath'), present.join());
    assert.ok(!present.includes('cwd'), present.join());
  });

  it('should_keep_the_file_name_since_that_is_what_the_phone_displays', () => {
    assert.equal(toRemoteSeries(series()).fileName, 'nightly.md');
  });

  it('should_carry_the_scheduling_fields_the_phone_needs', () => {
    const remote = toRemoteSeries(series({ enabled: false, spent: true, model: 'opus' }));

    assert.equal(remote.nextRunAt, '2026-07-30T18:30:00.000Z');
    assert.equal(remote.enabled, false);
    assert.equal(remote.spent, true);
    assert.equal(remote.model, 'opus');
    assert.equal(remote.maxRetries, 3);
  });

  it('should_show_the_permission_mode_so_the_phone_can_warn_about_full_auto', () => {
    assert.equal(toRemoteSeries(series()).permissionMode, 'bypassPermissions');
  });
});

describe('toRemoteRun — the privacy boundary', () => {
  it('should_never_include_a_local_filesystem_path_anywhere_in_the_payload', () => {
    const payload = JSON.stringify(toRemoteRun(run()));

    assert.ok(!payload.includes('acme-confidential'), payload);
  });

  it('should_drop_the_log_and_transcript_paths', () => {
    const present = keys(toRemoteRun(run()));

    assert.ok(!present.includes('logPath'), present.join());
    assert.ok(!present.includes('resultPath'), present.join());
  });

  it('should_drop_the_session_id_so_the_database_cannot_resume_the_conversation', () => {
    assert.ok(!keys(toRemoteRun(run())).includes('sessionId'));
  });

  it('should_keep_the_summary_the_phone_lists_runs_by', () => {
    const remote = toRemoteRun(run());

    assert.equal(remote.result, 'Updated the changelog and pushed.');
    assert.equal(remote.costUsd, 0.23);
    assert.equal(remote.status, 'completed');
  });

  it('should_carry_the_missed_and_auth_flags_that_need_a_decision', () => {
    const remote = toRemoteRun(
      run({ status: 'missed', missedReason: 'sleep', missedCount: 3, authFailure: true })
    );

    assert.equal(remote.missedReason, 'sleep');
    assert.equal(remote.missedCount, 3);
    assert.equal(remote.authFailure, true);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildArgs, preflightError } from '../src/launch';
import { PermissionMode } from '../src/types';

const PLAN = 'D:\\plans\\refactor.md';
const CWD = 'D:\\repo';

const launchable = (permissionMode: PermissionMode = 'acceptEdits', model?: string) => ({
  filePath: PLAN,
  cwd: CWD,
  permissionMode,
  model
});

/** Everything present and readable, unless a test says otherwise. */
const allExist = () => true;
const readsPlan = () => '# Do the thing\n';

describe('buildArgs', () => {
  it('should_always_run_headless_with_a_streamed_result', () => {
    const args = buildArgs(launchable());

    assert.ok(args.includes('-p'), 'without -p the CLI blocks on interactive approval');
    assert.deepEqual(args.slice(1, 4), ['--output-format', 'stream-json', '--verbose']);
  });

  it('should_pass_the_selected_permission_mode_through', () => {
    const args = buildArgs(launchable('plan'));

    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  });

  it('should_pass_the_bypass_flag_only_for_bypass_permissions', () => {
    // The flag enables the capability rather than applying it, so the two must
    // travel together. Shipped unverified in 0.4.0.
    const bypass = buildArgs(launchable('bypassPermissions'));
    const normal = buildArgs(launchable('acceptEdits'));

    assert.ok(bypass.includes('--allow-dangerously-skip-permissions'));
    assert.ok(!normal.includes('--allow-dangerously-skip-permissions'));
  });

  it('should_omit_the_model_flag_when_no_model_is_pinned', () => {
    assert.ok(!buildArgs(launchable()).includes('--model'));
  });

  it('should_pin_the_model_when_one_is_chosen', () => {
    const args = buildArgs(launchable('acceptEdits', 'opus'));

    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  });

  it('should_never_place_the_prompt_on_the_command_line', () => {
    // The plan travels on stdin: no argv length limit, no shell escaping.
    const args = buildArgs(launchable('acceptEdits', 'opus'));

    assert.ok(!args.some((arg) => arg.includes(PLAN)));
  });
});

describe('preflightError', () => {
  it('should_pass_when_the_plan_and_directory_are_both_present', () => {
    assert.equal(preflightError(launchable(), allExist, readsPlan), undefined);
  });

  it('should_fail_preflight_when_the_plan_file_was_deleted', () => {
    const error = preflightError(launchable(), (p) => p !== PLAN, readsPlan);

    assert.match(String(error), /no longer exists/);
  });

  it('should_fail_preflight_when_the_working_directory_is_gone', () => {
    const error = preflightError(launchable(), (p) => p !== CWD, readsPlan);

    assert.match(String(error), /Working directory/);
  });

  it('should_fail_preflight_when_the_plan_file_is_empty', () => {
    const error = preflightError(launchable(), allExist, () => '   \n\t ');

    assert.match(String(error), /empty/);
  });

  it('should_fail_preflight_when_the_plan_file_cannot_be_read', () => {
    const error = preflightError(launchable(), allExist, () => {
      throw new Error('EACCES');
    });

    assert.match(String(error), /Could not read/);
  });

  it('should_not_read_the_plan_when_it_does_not_exist', () => {
    let reads = 0;
    preflightError(launchable(), () => false, () => {
      reads++;
      return '';
    });

    assert.equal(reads, 0);
  });
});

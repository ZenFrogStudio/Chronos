import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createPlan,
  duplicatePlan,
  ensureLibrary,
  isInside,
  isScheduledPlan,
  listPlans,
  parseUriList,
  readPlan,
  readPlanAt,
  removePlan,
  renamePlan,
  samePath,
  seedLibrary,
  toPlanFileName,
  uniqueName,
  writePlan,
  writePlanAt
} from '../src/library';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronus-lib-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('toPlanFileName', () => {
  it('should_slug_a_plain_title', () => {
    assert.equal(toPlanFileName('Refactor Auth'), 'refactor-auth.md');
  });

  it('should_collapse_punctuation_and_trim_dashes', () => {
    assert.equal(toPlanFileName('  Fix: the *thing*!  '), 'fix-the-thing.md');
  });

  it('should_not_double_the_extension', () => {
    assert.equal(toPlanFileName('notes.md'), 'notes.md');
  });

  it('should_strip_path_separators_from_a_title', () => {
    // A title is a label; no label needs to address the filesystem.
    assert.equal(toPlanFileName('../../etc/passwd'), 'etc-passwd.md');
    assert.equal(toPlanFileName('C:\\Windows\\System32'), 'c-windows-system32.md');
  });

  it('should_survive_a_title_with_nothing_usable_in_it', () => {
    assert.equal(toPlanFileName('///'), 'plan-untitled.md');
    assert.equal(toPlanFileName(''), 'plan-untitled.md');
  });

  it('should_escape_names_windows_reserves', () => {
    assert.equal(toPlanFileName('CON'), 'plan-con.md');
    assert.equal(toPlanFileName('lpt1'), 'plan-lpt1.md');
  });

  it('should_cap_an_absurdly_long_title', () => {
    const name = toPlanFileName('a'.repeat(500));

    assert.ok(name.length <= 63);
  });
});

describe('uniqueName', () => {
  it('should_leave_a_free_name_alone', () => {
    assert.equal(uniqueName(['other.md'], 'plan.md'), 'plan.md');
  });

  it('should_append_a_counter_when_taken', () => {
    assert.equal(uniqueName(['plan.md'], 'plan.md'), 'plan-2.md');
    assert.equal(uniqueName(['plan.md', 'plan-2.md'], 'plan.md'), 'plan-3.md');
  });

  it('should_treat_names_case_insensitively', () => {
    // Windows and macOS filesystems do; assuming otherwise overwrites files.
    assert.equal(uniqueName(['Plan.md'], 'plan.md'), 'plan-2.md');
  });
});

describe('isInside', () => {
  it('should_accept_a_direct_child', () => {
    assert.equal(isInside('/library', '/library/plan.md'), true);
  });

  it('should_reject_traversal_out_of_the_library', () => {
    assert.equal(isInside('/library', '/library/../secrets.md'), false);
    assert.equal(isInside('/library', '/elsewhere/plan.md'), false);
  });

  it('should_reject_the_library_directory_itself', () => {
    assert.equal(isInside('/library', '/library'), false);
  });

  it('should_reject_a_sibling_with_a_shared_prefix', () => {
    assert.equal(isInside('/library', '/library-other/plan.md'), false);
  });
});

describe('parseUriList', () => {
  it('should_split_on_crlf', () => {
    assert.deepEqual(parseUriList('file:///c:/plans/a.md\r\nfile:///c:/plans/b.md'), [
      'file:///c:/plans/a.md',
      'file:///c:/plans/b.md'
    ]);
  });

  it('should_split_on_bare_lf', () => {
    assert.deepEqual(parseUriList('file:///plans/a.md\nfile:///plans/b.md'), [
      'file:///plans/a.md',
      'file:///plans/b.md'
    ]);
  });

  it('should_skip_comment_lines', () => {
    assert.deepEqual(parseUriList('# a comment\nfile:///plans/a.md'), ['file:///plans/a.md']);
  });

  it('should_skip_blank_and_whitespace_only_lines', () => {
    assert.deepEqual(parseUriList('\nfile:///plans/a.md\n   \n\n'), ['file:///plans/a.md']);
  });

  it('should_return_nothing_for_empty_input', () => {
    assert.deepEqual(parseUriList(''), []);
  });
});

describe('samePath', () => {
  it('should_match_a_path_against_itself', () => {
    assert.equal(samePath('/plans/nightly.md', '/plans/nightly.md'), true);
  });

  it('should_see_through_traversal_segments_to_the_same_file', () => {
    // Resolution happens before comparison, so `..` cannot smuggle a path past
    // a caller that already checked the plain form.
    assert.equal(samePath('/plans/sub/../nightly.md', '/plans/nightly.md'), true);
  });

  it('should_fold_case_when_told_the_filesystem_does', () => {
    assert.equal(samePath('/plans/Nightly.md', '/plans/nightly.md', true), true);
  });

  it('should_keep_case_significant_when_the_filesystem_does', () => {
    // On Linux these are two different files. Folding them would let a caller
    // write to a file it never named.
    assert.equal(samePath('/plans/Nightly.md', '/plans/nightly.md', false), false);
  });

  it('should_reject_a_different_file_in_the_same_folder', () => {
    assert.equal(samePath('/plans/nightly.md', '/plans/weekly.md'), false);
  });

  it('should_reject_the_same_basename_in_a_different_folder', () => {
    assert.equal(samePath('/plans/nightly.md', '/other/nightly.md'), false);
  });

  it('should_reject_a_name_that_merely_starts_with_the_scheduled_one', () => {
    assert.equal(samePath('/plans/nightly.md', '/plans/nightly.md.bak'), false);
  });

  // Separator equivalence is a Windows filesystem property. On Linux a
  // backslash is an ordinary character in a filename, and pretending otherwise
  // would widen the guard on exactly the platform that needs it narrow.
  it(
    'should_treat_mixed_separators_as_one_path_on_windows',
    { skip: process.platform !== 'win32' },
    () => {
      assert.equal(samePath('/plans/nightly.md', '\\plans\\nightly.md'), true);
    }
  );
});

describe('isScheduledPlan', () => {
  const schedule = ['/plans/nightly.md', '/elsewhere/weekly.md'];

  it('should_allow_a_path_that_is_in_the_schedule', () => {
    assert.equal(isScheduledPlan(schedule, '/elsewhere/weekly.md'), true);
  });

  it('should_allow_a_scheduled_path_reached_through_traversal', () => {
    assert.equal(isScheduledPlan(schedule, '/plans/sub/../nightly.md'), true);
  });

  it('should_refuse_an_unscheduled_neighbour_of_a_scheduled_plan', () => {
    // The whole point of the guard: savePlan must not write to a path the
    // webview named that Chronus was never asked to run.
    assert.equal(isScheduledPlan(schedule, '/plans/secrets.md'), false);
  });

  it('should_refuse_a_scheduled_basename_in_an_unscheduled_folder', () => {
    assert.equal(isScheduledPlan(schedule, '/tmp/nightly.md'), false);
  });

  it('should_refuse_a_path_that_only_shares_a_prefix', () => {
    assert.equal(isScheduledPlan(schedule, '/plans/nightly.md.bak'), false);
  });

  it('should_refuse_everything_when_nothing_is_scheduled', () => {
    assert.equal(isScheduledPlan([], '/plans/nightly.md'), false);
  });

  it('should_refuse_a_case_variant_where_case_is_significant', () => {
    assert.equal(isScheduledPlan(schedule, '/plans/Nightly.md', false), false);
  });

  it('should_allow_a_case_variant_where_case_is_not', () => {
    assert.equal(isScheduledPlan(schedule, '/plans/Nightly.md', true), true);
  });
});

describe('library CRUD', () => {
  it('should_create_a_plan_with_starter_content', () => {
    const plan = createPlan(dir, 'Refactor Auth');

    assert.equal(plan.name, 'refactor-auth.md');
    assert.match(readPlan(dir, plan.name), /^# refactor-auth/);
    assert.ok(fs.existsSync(plan.filePath));
  });

  it('should_deduplicate_a_repeated_title', () => {
    createPlan(dir, 'Nightly');
    const second = createPlan(dir, 'Nightly');

    assert.equal(second.name, 'nightly-2.md');
    assert.equal(listPlans(dir).length, 2);
  });

  it('should_round_trip_written_text', () => {
    const plan = createPlan(dir, 'Notes');
    writePlan(dir, plan.name, '# Edited\n');

    assert.equal(readPlan(dir, plan.name), '# Edited\n');
  });

  it('should_list_only_markdown_newest_first', () => {
    const old = createPlan(dir, 'Older');
    fs.utimesSync(old.filePath, new Date(0), new Date(0));
    createPlan(dir, 'Newer');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const plans = listPlans(dir);

    assert.deepEqual(plans.map((p) => p.name), ['newer.md', 'older.md']);
  });

  it('should_return_an_empty_list_for_a_missing_directory', () => {
    assert.deepEqual(listPlans(path.join(dir, 'nope')), []);
  });

  it('should_rename_a_plan_and_keep_its_content', () => {
    const plan = createPlan(dir, 'Before');
    writePlan(dir, plan.name, 'body');

    const renamed = renamePlan(dir, plan.name, 'After');

    assert.equal(renamed.name, 'after.md');
    assert.equal(readPlan(dir, 'after.md'), 'body');
    assert.equal(fs.existsSync(plan.filePath), false);
  });

  it('should_be_a_no_op_when_renaming_to_the_same_title', () => {
    const plan = createPlan(dir, 'Same');

    const renamed = renamePlan(dir, plan.name, 'Same');

    assert.equal(renamed.name, plan.name);
    assert.equal(listPlans(dir).length, 1);
  });

  it('should_not_clobber_an_existing_plan_when_renaming_onto_it', () => {
    createPlan(dir, 'Taken');
    const other = createPlan(dir, 'Other');

    const renamed = renamePlan(dir, other.name, 'Taken');

    assert.equal(renamed.name, 'taken-2.md');
    assert.equal(listPlans(dir).length, 2);
  });

  it('should_duplicate_a_plan_with_its_content', () => {
    const plan = createPlan(dir, 'Source');
    writePlan(dir, plan.name, 'original');

    const copy = duplicatePlan(dir, plan.name);

    assert.equal(copy.name, 'source-copy.md');
    assert.equal(readPlan(dir, copy.name), 'original');
  });

  it('should_deduplicate_repeated_duplication', () => {
    const plan = createPlan(dir, 'Source');
    duplicatePlan(dir, plan.name);

    assert.equal(duplicatePlan(dir, plan.name).name, 'source-copy-2.md');
  });

  it('should_remove_a_plan', () => {
    const plan = createPlan(dir, 'Doomed');

    removePlan(dir, plan.name);

    assert.deepEqual(listPlans(dir), []);
  });
});

describe('ensureLibrary and seeding', () => {
  it('should_report_creation_only_the_first_time', () => {
    const fresh = path.join(dir, 'library');

    assert.equal(ensureLibrary(fresh), true);
    assert.equal(ensureLibrary(fresh), false, 'a second call must not look like a first run');
  });

  it('should_seed_a_single_safe_starter_plan', () => {
    seedLibrary(dir);
    const plans = listPlans(dir);

    assert.equal(plans.length, 1);
    assert.match(readPlan(dir, plans[0].name), /Do not create, edit, move or delete any files/);
  });
});

describe('external plans by absolute path', () => {
  it('should_round_trip_a_plan_by_absolute_path', () => {
    const filePath = path.join(dir, 'external.md');

    writePlanAt(filePath, '# External\n');

    assert.equal(readPlanAt(filePath), '# External\n');
  });

  it('should_operate_on_paths_outside_a_library_by_design', () => {
    // An external plan the user explicitly scheduled lives outside the library.
    // These helpers address it by its own absolute path; the name-derived guard
    // does not — and must not — apply, because the runner already executes it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chronus-ext-'));
    const filePath = path.join(outside, 'elsewhere.md');

    try {
      writePlanAt(filePath, 'body');

      assert.equal(readPlanAt(filePath), 'body');
      assert.ok(!isInside(dir, filePath), 'the file is genuinely outside the library');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('should_not_weaken_the_name_derived_guard', () => {
    // Adding absolute-path helpers must not let a *name* escape the library:
    // `writePlan` still routes through `resolveInLibrary`, which strips traversal.
    const escaped = path.join(dir, '..', 'escaped.md');

    try {
      writePlan(dir, '../escaped.md', 'pwned');
    } catch {
      // Refusing or failing to resolve is fine; escaping the library is not.
    }

    assert.equal(fs.existsSync(escaped), false, 'the name-derived guard let a write escape');
  });
});

describe('library — path traversal', () => {
  const escapes = ['../outside.md', '..\\outside.md', 'sub/../../outside.md'];

  it('should_refuse_to_read_outside_the_library', () => {
    for (const bad of escapes) {
      assert.throws(() => readPlan(dir, bad), /outside the plan library|ENOENT/);
    }
  });

  it('should_refuse_to_write_outside_the_library', () => {
    const outside = path.join(dir, '..', 'escaped.md');

    for (const bad of escapes) {
      try {
        writePlan(dir, bad, 'pwned');
      } catch {
        // Either refusing or failing to resolve is acceptable; writing is not.
      }
    }

    assert.equal(fs.existsSync(outside), false, 'a write escaped the library');
  });

  it('should_refuse_a_non_markdown_target', () => {
    assert.throws(() => writePlan(dir, 'config.json', '{}'), /outside the plan library/);
  });

  it('should_refuse_to_delete_outside_the_library', () => {
    const outside = path.join(dir, '..', `sibling-${Date.now()}.md`);
    fs.writeFileSync(outside, 'keep me');

    try {
      assert.throws(() => removePlan(dir, `../${path.basename(outside)}`));
      assert.equal(fs.existsSync(outside), true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

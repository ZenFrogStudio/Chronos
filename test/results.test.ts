import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { planFolderName, resultPathFor, transcriptFileName, withStatus } from '../src/results';

const ROOT = path.resolve('C:', 'plans', 'results');
const STARTED = new Date(2026, 6, 26, 21, 30, 45);

describe('transcriptFileName', () => {
  it('should_be_sortable_by_name_because_the_folder_is_browsed_by_date', () => {
    const early = transcriptFileName(new Date(2026, 6, 26, 9, 5, 1));
    const late = transcriptFileName(new Date(2026, 6, 26, 21, 30, 45));

    assert.equal(early, '2026-07-26-090501.md');
    assert.ok(early < late);
  });

  it('should_separate_two_runs_in_the_same_minute', () => {
    // A retry can land seconds after the attempt it replaces.
    const first = transcriptFileName(new Date(2026, 6, 26, 21, 30, 10));
    const second = transcriptFileName(new Date(2026, 6, 26, 21, 30, 40));

    assert.notEqual(first, second);
  });
});

describe('planFolderName', () => {
  it('should_drop_the_extension_and_slugify_the_plan_name', () => {
    assert.equal(planFolderName('Nightly Audit.md'), 'nightly-audit');
  });

  it('should_strip_path_separators_from_a_plan_name', () => {
    // A folder name is a label; nothing about it should address the filesystem.
    const folder = planFolderName('..\\..\\etc\\passwd.md');

    assert.ok(!folder.includes('..'));
    assert.ok(!folder.includes('\\'));
    assert.ok(!folder.includes('/'));
  });

  it('should_still_produce_a_usable_folder_for_a_name_with_no_safe_characters', () => {
    assert.ok(planFolderName('***.md').length > 0);
  });
});

describe('resultPathFor', () => {
  it('should_place_a_run_under_a_folder_named_for_its_plan', () => {
    const result = resultPathFor(ROOT, 'nightly-audit.md', STARTED);

    assert.equal(result, path.join(ROOT, 'nightly-audit', '2026-07-26-213045.md'));
  });

  it('should_keep_a_traversal_attempt_inside_the_results_root', () => {
    const result = resultPathFor(ROOT, '..\\..\\escape.md', STARTED);

    assert.ok(result.startsWith(ROOT + path.sep), result);
  });
});

describe('withStatus', () => {
  it('should_append_the_outcome_so_the_folder_reads_at_a_glance', () => {
    const named = withStatus(path.join(ROOT, 'a', '2026-07-26-213045.md'), 'completed');

    assert.equal(path.basename(named), '2026-07-26-213045-completed.md');
  });

  it('should_keep_the_file_in_place_when_renaming', () => {
    const source = path.join(ROOT, 'a', '2026-07-26-213045.md');

    assert.equal(path.dirname(withStatus(source, 'failed')), path.dirname(source));
  });
});

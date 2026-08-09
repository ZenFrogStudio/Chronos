import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ensureRoot, pathsFor, ROOT_DIR } from '../src/roots';

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-root-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('pathsFor', () => {
  it('should_place_every_artefact_under_a_dot_chronos_root', () => {
    const paths = pathsFor(folder);

    const root = path.join(folder, ROOT_DIR);
    assert.equal(paths.folder, folder);
    assert.equal(paths.root, root);
    assert.equal(paths.state, path.join(root, 'state.json'));
    assert.equal(paths.lock, path.join(root, 'scheduler.lock'));
    assert.equal(paths.plans, path.join(root, 'plans'));
    assert.equal(paths.tasks, path.join(root, 'tasks'));
    assert.equal(paths.pending, path.join(root, '.pending'));
    assert.equal(paths.results, path.join(root, 'results'));
    assert.equal(paths.logs, path.join(root, 'logs'));
    assert.equal(paths.archive, path.join(root, 'archive'));
    assert.equal(paths.archivedPlans, path.join(root, 'archive', 'plans'));
    assert.equal(paths.archivedTasks, path.join(root, 'archive', 'tasks'));
  });

  it('should_keep_two_folders_data_apart', () => {
    // The whole point of the layout: nothing is shared between projects.
    const a = pathsFor(path.join(folder, 'project-a'));
    const b = pathsFor(path.join(folder, 'project-b'));

    assert.notEqual(a.state, b.state);
    assert.notEqual(a.plans, b.plans);
    assert.notEqual(a.lock, b.lock);
  });
});

describe('ensureRoot', () => {
  it('should_create_every_directory_it_promises', () => {
    const paths = pathsFor(folder);

    ensureRoot(paths);

    for (const dir of [paths.root, paths.plans, paths.tasks, paths.results, paths.logs]) {
      assert.ok(fs.statSync(dir).isDirectory(), `${dir} was not created`);
    }
  });

  it('should_not_create_the_archive_until_something_is_archived', () => {
    // The archive is made on demand, by the first archive and by the reveal
    // button. An empty `archive/` in every folder Chronos has ever opened is
    // clutter for a feature most folders never use.
    const paths = pathsFor(folder);

    ensureRoot(paths);

    assert.equal(fs.existsSync(paths.archive), false, 'ensureRoot created the archive');
  });

  it('should_report_true_only_the_first_time', () => {
    const paths = pathsFor(folder);

    const first = ensureRoot(paths);
    const second = ensureRoot(paths);

    assert.equal(first, true);
    assert.equal(second, false);
  });

  it('should_write_a_gitignore_covering_the_whole_root', () => {
    const paths = pathsFor(folder);

    ensureRoot(paths);

    assert.equal(fs.readFileSync(path.join(paths.root, '.gitignore'), 'utf8'), '*\n');
  });

  it('should_not_overwrite_a_gitignore_the_user_has_edited', () => {
    // Someone who decides to track their plans edits this file. Rewriting it on
    // every activation would silently undo that decision.
    const paths = pathsFor(folder);
    ensureRoot(paths);
    const ignore = path.join(paths.root, '.gitignore');
    fs.writeFileSync(ignore, 'state.json\nlogs/\n', 'utf8');

    ensureRoot(paths);

    assert.equal(fs.readFileSync(ignore, 'utf8'), 'state.json\nlogs/\n');
  });
});

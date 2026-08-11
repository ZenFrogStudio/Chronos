import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Rules about the source itself, for properties no unit test can observe.
 *
 * The CSP nonce is the case that prompted this: its only worthwhile property is
 * that an attacker cannot guess it, and nothing about a returned string proves
 * that. A test asserting two nonces differ passes for `randomBytes`, for a
 * counter and for `Math.random` alike — it cannot fail until after the bug is
 * back. Reading the source can.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const MEDIA = path.join(ROOT, 'media');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('source guards', () => {
  it('should_find_the_source_tree_it_is_meant_to_be_checking', () => {
    // Without this the greps below pass vacuously the day the layout moves.
    const files = sourceFiles(SRC);

    assert.ok(files.length > 10, `expected the src tree at ${SRC}, found ${files.length} files`);
  });

  it('should_never_call_Math_random_anywhere_in_src', () => {
    // The CSP nonce is the only guarantee that a <script> in the manager came
    // from us. Seeded from Math.random it is predictable, and the guarantee is
    // worth nothing. Nothing else in Chronos needs randomness either, so the
    // rule is a flat ban rather than a carve-out for one file.
    //
    // The call form specifically, so prose may still name it — `manager.ts`
    // carries a comment saying why the nonce does not use it. Aliasing the
    // function to evade this would defeat it; the guard is a tripwire for the
    // easy mistake, not a proof.
    const offenders = sourceFiles(SRC)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('Math.random('))
      .map((file) => path.relative(SRC, file));

    assert.deepEqual(offenders, [], `use crypto.randomBytes instead: ${offenders.join(', ')}`);
  });

  it('should_replace_every_placeholder_manager_html_contains', () => {
    // render() needs a live vscode.Webview, so no unit test can watch it work.
    // An unreplaced {{name}} does not throw either — it reaches the browser as a
    // literal, and a stylesheet or script simply never loads. Reading both sides
    // catches it the moment a placeholder is added without its replaceAll.
    const html = fs.readFileSync(path.join(MEDIA, 'manager.html'), 'utf8');
    const manager = fs.readFileSync(path.join(SRC, 'manager.ts'), 'utf8');

    const missing = [...new Set(html.match(/\{\{\w+\}\}/g) ?? [])].filter(
      (token) => !manager.includes(`replaceAll('${token}'`)
    );

    assert.deepEqual(missing, [], `manager.ts never replaces: ${missing.join(', ')}`);
  });

  it('should_replace_every_placeholder_tasks_html_contains', () => {
    // The task view is rendered the same way and fails the same silently: an
    // unreplaced {{styleUri}} leaves the inbox unstyled with nothing in the log.
    const html = fs.readFileSync(path.join(MEDIA, 'tasks.html'), 'utf8');
    const tasks = fs.readFileSync(path.join(SRC, 'tasks.ts'), 'utf8');

    const missing = [...new Set(html.match(/\{\{\w+\}\}/g) ?? [])].filter(
      (token) => !tasks.includes(`replaceAll('${token}'`)
    );

    assert.deepEqual(missing, [], `tasks.ts never replaces: ${missing.join(', ')}`);
  });

  it('should_keep_the_task_view_listening_for_its_planning_terminal_closing', () => {
    // `tasks.ts` imports `vscode` and cannot load in the plain Node runner, so
    // nothing else here can watch a session end. Losing this listener fails
    // completely silently: a session backed out of holds its row amber and its
    // Generate button disabled for the life of the window, with nothing in the
    // log to say why.
    const tasks = fs.readFileSync(path.join(SRC, 'tasks.ts'), 'utf8');

    assert.ok(
      tasks.includes('onDidCloseTerminal'),
      'src/tasks.ts no longer listens for the planning terminal closing'
    );
  });

  it('should_ship_the_codicons_the_task_view_asks_for', () => {
    // Both files, because the inbox names glyphs in two places: the rows are
    // built in JS, the Generate button is in the HTML.
    const css = fs.readFileSync(path.join(MEDIA, 'codicon.css'), 'utf8');
    const markup = ['tasks.html', 'tasks.js']
      .map((file) => fs.readFileSync(path.join(MEDIA, file), 'utf8'))
      .join('\n');

    for (const name of markup.match(/codicon-[\w-]+/g) ?? []) {
      assert.ok(css.includes(`.${name}:before`), `${name} is not in media/codicon.css`);
    }
  });

  it('should_ship_the_codicon_font_the_manager_asks_for', () => {
    // The webview may only load from media/, and the .vsix excludes
    // node_modules/, so these two are vendored rather than built. If either goes
    // missing the footer buttons render as empty rectangles and nothing errors.
    for (const asset of ['codicon.css', 'codicon.ttf']) {
      assert.ok(fs.existsSync(path.join(MEDIA, asset)), `media/${asset} is missing`);
    }

    const css = fs.readFileSync(path.join(MEDIA, 'codicon.css'), 'utf8');
    // Both files, as with the task view: the footer buttons are in the HTML,
    // while the plan rows, the calendar and the run spinner are built in JS.
    const markup = ['manager.html', 'manager.js']
      .map((file) => fs.readFileSync(path.join(MEDIA, file), 'utf8'))
      .join('\n');

    // Codicon names change between releases, and a renamed one is invisible in
    // the same way — a blank glyph, no error. `codicon-modifier-*` is skipped:
    // those are behaviour classes like the spin animation, with no glyph and so
    // no `:before` rule of their own.
    for (const name of markup.match(/codicon-[\w-]+/g) ?? []) {
      if (name.startsWith('codicon-modifier-')) continue;
      assert.ok(css.includes(`.${name}:before`), `${name} is not in media/codicon.css`);
    }
  });

  it('should_keep_the_sash_defaults_in_step_with_the_stylesheet', () => {
    // The default pane sizes are written twice: as the custom-property fallback
    // the browser uses before anything is dragged, and as a constant in the
    // clamp maths. Let them drift and the panel jumps the first time you touch
    // its divider, with nothing in the log to say why.
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');
    const css = fs.readFileSync(path.join(MEDIA, 'manager.css'), 'utf8');

    const constant = (name: string) => js.match(new RegExp(`${name}\\s*=\\s*(\\d+)`))?.[1];
    const fallback = (prop: string) => css.match(new RegExp(`var\\(${prop},\\s*(\\d+)px\\)`))?.[1];

    assert.equal(constant('LIBRARY_DEFAULT'), fallback('--library-width'));
    assert.equal(constant('ACTIVITY_DEFAULT'), fallback('--activity-height'));
    // Both sides matching `undefined` would pass the two above vacuously.
    assert.equal(constant('LIBRARY_DEFAULT'), '260');
    assert.equal(constant('ACTIVITY_DEFAULT'), '220');
  });

  it('should_keep_a_script_that_installs_the_build_into_vs_code', () => {
    // `package` stops at a .vsix on disk. With no step past it, a run that edits
    // this extension can typecheck, test, compile and package, and the editor
    // carries on running whatever it loaded at startup — completed work that
    // looks like it did nothing. Lose this script and that returns silently.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    assert.ok(fs.existsSync(path.join(ROOT, 'reinstall.js')), 'reinstall.js is missing');
    assert.match(manifest.scripts.reinstall ?? '', /node reinstall\.js/);
  });

  it('should_never_name_the_install_script_after_an_npm_lifecycle_hook', () => {
    // npm runs `install`, `preinstall` and `postinstall` itself during
    // `npm install`. Renaming `reinstall` to the obvious `install` would package
    // the extension and push it into VS Code every time a dependency was added.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    for (const hook of ['install', 'preinstall', 'postinstall']) {
      assert.ok(!(hook in manifest.scripts), `"${hook}" is an npm lifecycle hook — use "reinstall"`);
    }
  });

  it('should_name_the_vsix_from_the_manifest_rather_than_a_literal', () => {
    // The filename carries the version, so a hardcoded one installs an older
    // .vsix still sitting in the folder — the exact staleness this script is
    // here to prevent, and invisible, because the install still reports success.
    const script = fs.readFileSync(path.join(ROOT, 'reinstall.js'), 'utf8');

    assert.ok(script.includes('package.json'), 'reinstall.js must read the version');
    assert.doesNotMatch(script, /chronos-\d+\.\d+\.\d+/, 'reinstall.js hardcodes a version');
  });

  it('should_install_into_the_editor_this_project_is_developed_in', () => {
    // VSCodium and Microsoft's build keep separate extension folders, and the
    // `code` CLI on PATH is the latter. Installing with it succeeds, says so,
    // and leaves VSCodium on the version it already had — which is how a whole
    // evening of finished work stayed invisible. Drop codium from the list and
    // that returns, still reporting success.
    const script = fs.readFileSync(path.join(ROOT, 'reinstall.js'), 'utf8');

    assert.match(script, /'codium'/, 'reinstall.js must try the codium CLI');
  });

  it('should_wire_every_key_the_manager_documents', () => {
    // The manager's key map is written twice by necessity: once as the handlers
    // that implement it, once as the table the Settings page prints. There is no
    // DOM harness here to press a key in, so this reads both sides instead —
    // otherwise the table can silently drop off the page while the keys keep
    // working, or outlive a key that no longer does anything.
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    const keys = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Enter',
      'Escape',
      'F6'
    ];
    for (const key of keys) {
      assert.ok(js.includes(`'${key}'`), `media/manager.js never handles ${key}`);
    }

    assert.match(js, /const SHORTCUTS = \[/, 'media/manager.js has no SHORTCUTS table');

    // The call site, not merely the definition: a table nothing renders is the
    // half of this the key names above cannot catch.
    const page = js.slice(js.indexOf('function settingsPage()'));
    assert.ok(
      page.slice(0, page.indexOf('\n  }')).includes('${shortcutsSection()}'),
      'settingsPage never renders the shortcuts table'
    );
  });

  it('should_never_let_the_manager_destroy_a_series_and_its_run_history', () => {
    // Unscheduling switches a series off; it does not delete it. `removeSeries`
    // takes every run record with it (store.ts), so a webview that can still send
    // it turns one click on the main toggle into a silent loss of history.
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    assert.ok(!js.includes('removeSeries'), 'media/manager.js can still remove a series');
  });

  it('should_ship_a_sash_element_for_every_sash_rule', () => {
    // The dividers are found by id, styled by class and never rendered by JS, so
    // a renamed id leaves the CSS styling nothing and the drag silently dead.
    const html = fs.readFileSync(path.join(MEDIA, 'manager.html'), 'utf8');
    const js = fs.readFileSync(path.join(MEDIA, 'manager.js'), 'utf8');

    for (const id of ['library-sash', 'activity-sash']) {
      assert.ok(html.includes(`id="${id}"`), `media/manager.html has no #${id}`);
      assert.ok(js.includes(`'${id}'`), `media/manager.js never looks up #${id}`);
    }
  });
});

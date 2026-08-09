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

const SRC = path.resolve(__dirname, '..', '..', 'src');
const MEDIA = path.resolve(__dirname, '..', '..', 'media');

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
    const html = fs.readFileSync(path.join(MEDIA, 'manager.html'), 'utf8');

    // Codicon names change between releases, and a renamed one is invisible in
    // the same way — a blank glyph, no error.
    for (const name of html.match(/codicon-[\w-]+/g) ?? []) {
      assert.ok(css.includes(`.${name}:before`), `${name} is not in media/codicon.css`);
    }
  });
});

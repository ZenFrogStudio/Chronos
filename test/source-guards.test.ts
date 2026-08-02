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
    // worth nothing. Nothing else in Chronus needs randomness either, so the
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
});

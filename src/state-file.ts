import * as fs from 'fs';
import { migrate } from './migrate';
import { ChronosState, SCHEMA_VERSION } from './types';

/**
 * The schedule on disk.
 *
 * State used to live in `globalState`, which is one bucket for the whole
 * machine — the reason Chronos could not tell one project's work from
 * another's. A file per folder replaces it, and the read half is written here
 * rather than in `store.ts` so it can be exercised by the plain Node test
 * runner: no `vscode` import, same rule as `consolidate.ts` and `remote.ts`.
 */

export function emptyState(): ChronosState {
  return { schemaVersion: SCHEMA_VERSION, series: [], runs: [] };
}

export interface ReadResult {
  state: ChronosState;
  /** Where unrecognisable content was set aside, if it was. */
  backedUpTo?: string;
  /** The version read, when it was older than the current one. */
  migratedFrom?: number;
}

/**
 * Loads a folder's state, upgrading a known older schema through `migrate()`.
 *
 * A missing file is an empty schedule, not an error: it is what every folder
 * looks like before Chronos has run in it. Only a genuinely unrecognisable
 * shape is set aside, and even then it is copied rather than dropped — losing
 * somebody's schedule to a parse error is not a recovery.
 */
export function readState(file: string): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: emptyState() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptyState(), backedUpTo: setAside(file, raw) };
  }

  const migrated = migrate(parsed);
  if (!migrated) {
    return { state: emptyState(), backedUpTo: setAside(file, raw) };
  }

  const from = (parsed as Partial<ChronosState>).schemaVersion;
  if (from !== SCHEMA_VERSION) {
    writeState(file, migrated);
    return { state: migrated, migratedFrom: from };
  }

  return { state: migrated };
}

/**
 * Writes through a temp file and a rename. A rename is atomic on both NTFS and
 * ext4, so a crash mid-write leaves either the old schedule or the new one —
 * never a truncated file that reads as "every task has been deleted".
 */
export function writeState(file: string, state: ChronosState): void {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
  fs.renameSync(temp, file);
}

/** Keeps a copy of content we could not read, so it is recoverable by hand. */
function setAside(file: string, raw: string): string | undefined {
  const backup = `${file}.bak`;
  try {
    fs.writeFileSync(backup, raw, 'utf8');
    return backup;
  } catch {
    return undefined;
  }
}

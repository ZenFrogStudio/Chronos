import * as fs from 'fs';
import * as path from 'path';

/**
 * The plan library: a folder of `.md` files. There is deliberately no index,
 * manifest or id table — an index is a second source of truth that drifts from
 * the filesystem the moment someone edits a file outside Chronus. The directory
 * *is* the database.
 *
 * No `vscode` import, so every rule here is testable against a temp directory.
 */

export interface PlanFile {
  /** File name including extension, e.g. "refactor-auth.md". Identity. */
  name: string;
  /** Absolute path. */
  filePath: string;
  /** Display title — the name without its extension. */
  title: string;
  modifiedMs: number;
  sizeBytes: number;
}

const EXTENSION = '.md';

/** Reserved on Windows regardless of extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Turns a user-typed title into a safe file name.
 *
 * Path separators and traversal segments are stripped rather than escaped: a
 * title is a label, and no label needs to address the filesystem. `isInside`
 * still checks the result, because defence in depth is cheap here and a written
 * file in the wrong place is not recoverable.
 */
export function toPlanFileName(title: string): string {
  const base = title
    .trim()
    .replace(new RegExp(`\\${EXTENSION}$`, 'i'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  const safe = !base || RESERVED.has(base) ? `plan-${base || 'untitled'}` : base;
  return `${safe}${EXTENSION}`;
}

/** Appends -2, -3 … until the name is free. */
export function uniqueName(existing: readonly string[], desired: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) {
    return desired;
  }

  const stem = desired.slice(0, -EXTENSION.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${EXTENSION}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

/** Whether `target` resolves to somewhere inside `dir`. */
export function isInside(dir: string, target: string): boolean {
  const root = path.resolve(dir);
  const resolved = path.resolve(target);
  if (resolved === root) {
    return false;
  }
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isPlanFile(name: string): boolean {
  return path.extname(name).toLowerCase() === EXTENSION;
}

/**
 * Whether two paths address the same file. Resolved first, so `..` segments and
 * mixed separators do not defeat the comparison.
 *
 * Case is folded only where the filesystem folds it. On Linux `Plan.md` and
 * `plan.md` are two different files, and treating them as one would let a caller
 * write to a file it did not name — the opposite of what the callers below want.
 * `ignoreCase` is a parameter rather than a bare `process.platform` check so both
 * branches are reachable from a test on either platform.
 */
export function samePath(a: string, b: string, ignoreCase = process.platform === 'win32'): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Whether an absolute path is one of the plans Chronus is scheduled to run.
 *
 * External plans bypass `resolveInLibrary` deliberately — that guard governs
 * name-derived paths, and an absolute path the user explicitly scheduled is
 * already trusted at a higher level, since the runner reads and executes it.
 * That reasoning only holds for paths actually *in* the schedule, so this is the
 * check that makes it true. Without it, `savePlan` would write arbitrary text to
 * any path the webview named.
 */
export function isScheduledPlan(
  scheduledPaths: readonly string[],
  candidate: string,
  ignoreCase = process.platform === 'win32'
): boolean {
  return scheduledPaths.some((scheduled) => samePath(scheduled, candidate, ignoreCase));
}

export const titleOf = (name: string): string => name.slice(0, -path.extname(name).length);

/**
 * Resolves a name inside the library, refusing anything that escapes it. Every
 * write path goes through here.
 */
function resolveInLibrary(dir: string, name: string): string {
  const candidate = path.join(dir, path.basename(name));
  if (!isInside(dir, candidate) || !isPlanFile(candidate)) {
    throw new Error(`Refusing to touch a path outside the plan library: ${name}`);
  }
  return candidate;
}

/** Returns true when the library folder did not exist and was just created. */
export function ensureLibrary(dir: string): boolean {
  const created = fs.mkdirSync(dir, { recursive: true });
  return created !== undefined;
}

/**
 * A first-run plan, so the manager opens with something to look at and a safe
 * thing to try. Only ever written when the library is first created — deleting
 * it must not bring it back.
 */
export function seedLibrary(dir: string): void {
  createPlan(
    dir,
    'Hello Chronus',
    [
      '# Hello Chronus',
      '',
      'Reply with exactly the word `OK` and then stop.',
      '',
      'Do not create, edit, move or delete any files. Do not run any shell',
      'commands. This plan exists so you can confirm scheduling works before',
      'trusting Chronus with something real.',
      ''
    ].join('\n')
  );
}

/** Newest first. Unreadable entries are skipped rather than failing the list. */
export function listPlans(dir: string): PlanFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const plans: PlanFile[] = [];
  for (const name of names) {
    if (!isPlanFile(name)) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      plans.push({
        name,
        filePath,
        title: titleOf(name),
        modifiedMs: stat.mtimeMs,
        sizeBytes: stat.size
      });
    } catch {
      // A file removed mid-listing is not worth failing the whole view for.
    }
  }

  return plans.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function describe(dir: string, name: string): PlanFile {
  const filePath = resolveInLibrary(dir, name);
  const stat = fs.statSync(filePath);
  return {
    name,
    filePath,
    title: titleOf(name),
    modifiedMs: stat.mtimeMs,
    sizeBytes: stat.size
  };
}

export function createPlan(dir: string, title: string, body?: string): PlanFile {
  ensureLibrary(dir);
  const name = uniqueName(
    listPlans(dir).map((p) => p.name),
    toPlanFileName(title)
  );
  const filePath = resolveInLibrary(dir, name);
  fs.writeFileSync(filePath, body ?? starterBody(titleOf(name)), 'utf8');
  return describe(dir, name);
}

export function readPlan(dir: string, name: string): string {
  return fs.readFileSync(resolveInLibrary(dir, name), 'utf8');
}

export function writePlan(dir: string, name: string, text: string): void {
  fs.writeFileSync(resolveInLibrary(dir, name), text, 'utf8');
}

/**
 * Reads and writes a plan by its own absolute path, for external plans the user
 * explicitly scheduled from elsewhere on disk. These bypass `resolveInLibrary`
 * deliberately: that guard governs *name-derived* paths so a typed title cannot
 * escape the library. An absolute path already in the schedule is trusted at a
 * strictly higher level — the runner reads and executes it — so editing it grants
 * nothing new. `resolveInLibrary` is unchanged and still guards every library write.
 */
export function readPlanAt(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

export function writePlanAt(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, 'utf8');
}

/** Returns the plan under its new name, which may have been deduplicated. */
export function renamePlan(dir: string, name: string, newTitle: string): PlanFile {
  const from = resolveInLibrary(dir, name);
  const desired = toPlanFileName(newTitle);

  if (desired.toLowerCase() === name.toLowerCase()) {
    return describe(dir, name);
  }

  const to = uniqueName(
    listPlans(dir).map((p) => p.name),
    desired
  );
  fs.renameSync(from, resolveInLibrary(dir, to));
  return describe(dir, to);
}

export function duplicatePlan(dir: string, name: string): PlanFile {
  const copy = uniqueName(
    listPlans(dir).map((p) => p.name),
    `${titleOf(name)}-copy${EXTENSION}`
  );
  fs.copyFileSync(resolveInLibrary(dir, name), resolveInLibrary(dir, copy));
  return describe(dir, copy);
}

export function removePlan(dir: string, name: string): void {
  fs.unlinkSync(resolveInLibrary(dir, name));
}

function starterBody(title: string): string {
  return `# ${title}\n\nDescribe what Claude should do when this plan runs.\n`;
}

import { TaskSeries } from './types';

/**
 * How a run is started, minus the starting. Pure — no `vscode` import — so the
 * argument construction and the pre-flight rules are directly testable.
 */

/** The fields of a series that actually shape a launch. */
type Launchable = Pick<TaskSeries, 'filePath' | 'cwd' | 'permissionMode' | 'model'>;

export function buildArgs(series: Pick<TaskSeries, 'permissionMode' | 'model'>): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    series.permissionMode
  ];

  // bypassPermissions is only honoured when the CLI is separately told to allow
  // it; the flag makes the capability available rather than applying it.
  if (series.permissionMode === 'bypassPermissions') {
    args.push('--allow-dangerously-skip-permissions');
  }
  if (series.model) {
    args.push('--model', series.model);
  }
  return args;
}

/**
 * Why this run cannot start, or undefined if it can. Every one of these is a
 * permanent condition — the same missing file would fail identically an hour
 * later — so the caller must not retry on any of them.
 *
 * `exists` and `readFile` are injected so the rules can be tested without
 * touching a real filesystem.
 */
export function preflightError(
  series: Launchable,
  exists: (path: string) => boolean,
  readFile: (path: string) => string
): string | undefined {
  if (!exists(series.filePath)) {
    return `Plan file no longer exists: ${series.filePath}`;
  }
  if (!exists(series.cwd)) {
    return `Working directory no longer exists: ${series.cwd}`;
  }

  let prompt: string;
  try {
    prompt = readFile(series.filePath);
  } catch (err) {
    return `Could not read plan file: ${String(err)}`;
  }
  if (!prompt.trim()) {
    return 'Plan file is empty.';
  }

  return undefined;
}

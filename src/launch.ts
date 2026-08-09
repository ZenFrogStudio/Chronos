import { PermissionMode, TaskSeries } from './types';

/**
 * How a run is started, minus the starting. Pure — no `vscode` import — so the
 * argument construction and the pre-flight rules are directly testable.
 *
 * The prompt is absent from every argv below: it travels on stdin for both
 * engines, so there is no length limit and nothing to escape.
 */

/** The fields of a series that actually shape a launch. */
type Launchable = Pick<TaskSeries, 'filePath' | 'cwd' | 'permissionMode' | 'model'>;

type Runnable = Pick<TaskSeries, 'permissionMode' | 'model' | 'agent' | 'cwd'>;

/**
 * The permission modes that mean "do not stop and ask". opencode has one
 * approval control where Claude has six, so these all collapse onto `--auto`.
 */
const OPENCODE_AUTO_MODES: readonly PermissionMode[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'dontAsk'
];

export function buildArgs(series: Runnable): string[] {
  return series.agent === 'opencode' ? opencodeArgs(series) : claudeArgs(series);
}

function claudeArgs(series: Runnable): string[] {
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

function opencodeArgs(series: Runnable): string[] {
  // `--dir` is not belt and braces. opencode runs its tools through a local
  // server of its own that resolves the project root independently, so it does
  // *not* inherit the spawned process's working directory — verified against
  // 1.18.5, where a run spawned with cwd set to one folder edited another. A
  // task pointed at one repo would otherwise quietly edit whichever repo
  // opencode felt like, with permissions wide open.
  const args = ['run', '--format', 'json', '--dir', series.cwd];

  // Without this an unattended run blocks on an approval prompt nobody is awake
  // to answer, and the watchdog eventually kills it for idling.
  if (OPENCODE_AUTO_MODES.includes(series.permissionMode)) {
    args.push('--auto');
  }
  if (series.model) {
    args.push('-m', series.model);
  }
  return args;
}

/** The three argument-quoting rules that exist among the shells VS Code opens. */
export type Shell = 'powershell' | 'cmd' | 'posix';

/**
 * Classifies `vscode.env.shell`. Defaults to PowerShell on Windows because that
 * is VS Code's own default profile there.
 */
export function shellKind(shellPath: string, platform: NodeJS.Platform): Shell {
  if (platform !== 'win32') {
    return 'posix';
  }
  const name = shellPath.toLowerCase();
  if (/powershell|pwsh/.test(name)) {
    return 'powershell';
  }
  // Git Bash and WSL, both of which run on Windows but quote like POSIX.
  if (/bash|zsh|wsl/.test(name)) {
    return 'posix';
  }
  if (name.includes('cmd.exe')) {
    return 'cmd';
  }
  return 'powershell';
}

/**
 * There is no quoting form that works in all three: single quotes are literal in
 * PowerShell and POSIX but mean nothing in cmd, and double quotes work in cmd
 * but expand `$` in PowerShell.
 */
function quote(shell: Shell, value: string): string {
  if (shell === 'powershell') {
    // PowerShell single quotes are literal; '' escapes one.
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (shell === 'cmd') {
    // cmd has no escape character inside quotes, and a Windows path cannot
    // contain a double quote, so stripping one is a guard rather than a loss.
    return `"${value.replace(/"/g, '')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface GenerateOptions {
  exe: string;
  /** The file Claude reads the request from — a library plan, or a sidebar task. */
  sourcePath: string;
  /**
   * A folder the approved plan is saved into, under a file name Claude chooses.
   * Omitted means overwrite `sourcePath`, which is what the manager's own button
   * does; the task view passes a folder so a one-line task is never the thing
   * that gets overwritten, and so the plan arrives named after the change it
   * makes rather than after the request that asked for it.
   */
  destDir?: string;
  /** Granted with --add-dir. Must contain both paths above, since the working
   *  directory is the repo and neither file usually sits inside it. */
  allowDir: string;
  model?: string;
  shell: Shell;
}

/**
 * The command line that opens an interactive planning session on a file.
 *
 * The source text is deliberately absent: it is named, not pasted. A plan body is
 * multi-line and can be tens of kilobytes, cmd.exe caps a command line at 8191
 * characters, and newlines cannot survive a shell prompt at all. A path is one
 * line and quotes cleanly, and Claude reads the file itself.
 *
 * Always `--permission-mode plan`, whatever the series is set to run as — this
 * writes a plan, it does not carry one out.
 */
export function generateCommand(options: GenerateOptions): string {
  const { exe, sourcePath, destDir, allowDir, model, shell } = options;
  const q = (value: string) => quote(shell, value);

  // No `!`, `$`, backtick or quote of its own: interactive bash expands `!` and
  // PowerShell expands `$`, so the only thing `quote` has to survive is a path.
  const destination = destDir
    ? `save the approved plan as a new .md file in ${destDir}`
    : 'overwrite that same file with the approved plan';

  const naming =
    ' Name that file with a short summary of the change the plan makes, in ' +
    'lower case with hyphens instead of spaces, ending in .md, for example ' +
    'add-monthly-repeat-option.md. Do not just repeat the words of the request.';

  const instruction =
    `Read the file at ${sourcePath}. Treat what it says as the request, ` +
    'work out how to carry it out, and write an implementation plan for it. ' +
    `Ask me anything you need to first. When I approve the plan, ${destination}, ` +
    'written as instructions for an agent that will carry it out later with ' +
    'nobody watching, and change nothing else.' +
    (destDir ? naming : '');

  // PowerShell reads a quoted string at the start of a line as a value, not a
  // command; & is what makes it run.
  const command = shell === 'powershell' ? `& ${q(exe)}` : q(exe);

  const args = ['--permission-mode', 'plan', '--add-dir', q(allowDir)];
  if (model) {
    args.push('--model', model);
  }
  args.push(q(instruction));

  return `${command} ${args.join(' ')}`;
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

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildArgs, preflightError } from './launch';
import { log } from './log';
import { KillReason, Outcome, resolveOutcome, watchdogVerdict } from './outcome';
import { resultPathFor, withStatus } from './results';
import { Store } from './store';
import { nowUtc, truncate, truncateError } from './time';
import { parseLine, toAnsi, toMarkdown, transcriptFooter, transcriptHeader } from './transcript';
import { RESULT_MAX_CHARS, TaskRun, TaskSeries } from './types';

export interface RunFinished {
  runId: string;
  seriesId: string;
  outcome: Outcome;
}

interface ActiveRun {
  runId: string;
  seriesId: string;
  child: ChildProcess;
  startedAtMs: number;
  lastOutputAtMs: number;
  /**
   * Only the newest `type: "result"` line, not the whole stream. The full
   * transcript is already going to disk twice over; holding a megabyte of it in
   * memory to read one line back out at the end is pure waste.
   */
  lastResultLine: string;
  pending: string;
  logStream: fs.WriteStream;
  /** Absent when the results folder could not be written to. */
  resultStream?: fs.WriteStream;
  resultPath?: string;
  killReason?: KillReason;
  writer: vscode.EventEmitter<string>;
  closer: vscode.EventEmitter<number>;
}

export class Runner implements vscode.Disposable {
  private readonly active = new Map<string, ActiveRun>();
  private readonly finished = new vscode.EventEmitter<RunFinished>();
  readonly onDidFinish = this.finished.event;

  constructor(
    private readonly store: Store,
    private readonly logDir: string,
    /** Resolved per run: the setting can change without an editor restart. */
    private readonly resultsDir: () => string
  ) {
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  dispose(): void {
    for (const run of this.active.values()) {
      run.killReason = 'shutdown';
      run.child.kill();
    }
    this.finished.dispose();
    // The streams are deliberately left open. Ending them here would race
    // `settle`, which still runs whenever the child's `close` event arrives —
    // and it does whenever the extension is deactivated without the host
    // exiting, as on a window reload. `settle` would then be writing a footer to
    // an ended stream, lose both the footer and the rename, and mark the run
    // `failed` so that `finaliseInterrupted` skips it on the next launch too.
    // Letting `settle` finish the job when it can, and finalising on the next
    // launch when it cannot, covers both without the race.
  }

  /**
   * Closes out a transcript abandoned by a window that died mid-run.
   *
   * The footer and the `-failed` rename normally happen in `settle()`, which a
   * killed extension host never reaches. Left alone, those transcripts keep
   * their un-suffixed name — so the results folder stops answering "which nights
   * went wrong" for precisely the runs that went most wrong. Called from
   * `Scheduler.reconcile()` on the next launch, where there is time to do it.
   */
  finaliseInterrupted(
    resultPath: string | undefined,
    error: string,
    durationMs: number
  ): string | undefined {
    if (!resultPath || !fs.existsSync(resultPath)) {
      return resultPath;
    }

    try {
      const outcome: Outcome = { ok: false, error, denials: 0, retryable: true };
      fs.appendFileSync(resultPath, transcriptFooter(outcome, durationMs), 'utf8');
      const target = withStatus(resultPath, 'failed');
      fs.renameSync(resultPath, target);
      return target;
    } catch (err) {
      log.warn(`could not finalise an interrupted transcript: ${String(err)}`);
      return resultPath;
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  isSeriesRunning(seriesId: string): boolean {
    for (const run of this.active.values()) {
      if (run.seriesId === seriesId) {
        return true;
      }
    }
    return false;
  }

  /** Remaining concurrency. Parallel agents in one repo collide, hence the cap. */
  freeSlots(): number {
    const max = config().get<number>('maxConcurrent', 1);
    return Math.max(0, max - this.active.size);
  }

  cancel(runId: string, reason: KillReason = 'cancelled'): void {
    const run = this.active.get(runId);
    if (!run) {
      return;
    }
    run.killReason = reason;
    run.child.kill();
  }

  /** Applies `watchdogVerdict` to every live run. The rules themselves are pure. */
  checkWatchdogs(): void {
    const idleMs = config().get<number>('idleTimeoutMinutes', 15) * 60_000;
    const maxMs = config().get<number>('maxRuntimeMinutes', 60) * 60_000;
    const now = Date.now();

    for (const run of this.active.values()) {
      const verdict = watchdogVerdict(run, now, idleMs, maxMs);
      if (verdict) {
        this.cancel(run.runId, verdict);
      }
    }
  }

  async begin(series: TaskSeries, run: TaskRun): Promise<void> {
    const failFast = async (error: string) => {
      await this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: nowUtc(),
        lastError: error
      });
      this.finished.fire({
        runId: run.id,
        seriesId: series.id,
        outcome: { ok: false, error, denials: 0, retryable: false }
      });
    };

    // Pre-flight. These failures are not retryable — the same missing file
    // would fail identically an hour later.
    const readFile = (p: string) => fs.readFileSync(p, 'utf8');
    const problem = preflightError(series, fs.existsSync, readFile);
    if (problem) {
      return failFast(problem);
    }

    const prompt = readFile(series.filePath);
    const startedAt = new Date();
    const logPath = path.join(this.logDir, `${run.id}.log`);
    const resultPath = this.prepareResultPath(series, startedAt);

    await this.store.updateRun(run.id, {
      status: 'running',
      startedAt: nowUtc(),
      logPath,
      resultPath
    });

    this.spawnRun(series, run, prompt, logPath, resultPath, startedAt);
  }

  /**
   * Creates the plan's results folder and returns where this run's transcript
   * goes. A results folder that cannot be written to must not stop the run —
   * the work matters more than the record of it — so this degrades to
   * undefined and says so in the log.
   */
  private prepareResultPath(series: TaskSeries, startedAt: Date): string | undefined {
    try {
      const target = resultPathFor(this.resultsDir(), series.fileName, startedAt);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return target;
    } catch (err) {
      log.warn(`could not prepare a results folder: ${String(err)}`);
      return undefined;
    }
  }

  private spawnRun(
    series: TaskSeries,
    run: TaskRun,
    prompt: string,
    logPath: string,
    resultPath: string | undefined,
    startedAt: Date
  ): void {
    const args = buildArgs(series);
    const exe = config().get<string>('claudePath', 'claude');

    log.info(`run ${run.id}: ${exe} ${args.join(' ')} (cwd ${series.cwd})`);

    let child: ChildProcess;
    try {
      child = spawnClaude(exe, args, series.cwd);
    } catch (err) {
      void this.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: nowUtc(),
        lastError: truncateError(`Could not start claude: ${String(err)}`)
      });
      this.finished.fire({
        runId: run.id,
        seriesId: series.id,
        outcome: { ok: false, error: 'Could not start claude.', denials: 0, retryable: true }
      });
      return;
    }

    const now = Date.now();
    const active: ActiveRun = {
      runId: run.id,
      seriesId: series.id,
      child,
      startedAtMs: now,
      lastOutputAtMs: now,
      lastResultLine: '',
      pending: '',
      logStream: fs.createWriteStream(logPath, { flags: 'a' }),
      resultPath,
      resultStream: openTranscript(resultPath, series, run, startedAt),
      writer: new vscode.EventEmitter<string>(),
      closer: new vscode.EventEmitter<number>()
    };
    this.active.set(run.id, active);

    this.openTerminal(series, active);

    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(active, chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => {
      active.lastOutputAtMs = Date.now();
      active.logStream.write(chunk);
      this.write(active, chunk.toString());
    });

    child.on('error', (err) => {
      active.logStream.write(`\n[chronus] spawn error: ${String(err)}\n`);
    });

    child.on('close', (code) => {
      void this.settle(active, code);
    });

    // Prompt goes over stdin: no argv length limit, no shell escaping, and the
    // path having spaces stops mattering.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt);
  }

  private openTerminal(series: TaskSeries, active: ActiveRun): void {
    const pty: vscode.Pseudoterminal = {
      onDidWrite: active.writer.event,
      onDidClose: active.closer.event,
      open: () => {
        active.writer.fire(`\x1b[2mChronus — ${series.fileName}\x1b[0m\r\n`);
        active.writer.fire(`\x1b[2m${series.cwd}\x1b[0m\r\n\r\n`);
      },
      // Closing the tab of a live run cancels it; closing a finished one is a
      // no-op, since it is no longer in `active`.
      close: () => this.cancel(active.runId, 'cancelled')
    };

    const terminal = vscode.window.createTerminal({
      name: `Chronus: ${series.fileName}`,
      pty
    });

    // Reveal without stealing focus. A run you never see is indistinguishable
    // from one that never happened; taking the cursor mid-typing is worse.
    if (config().get<boolean>('showTerminalOnRun', true)) {
      terminal.show(true);
    }
  }

  private write(active: ActiveRun, text: string): void {
    active.writer.fire(text.replace(/\r?\n/g, '\r\n'));
  }

  /**
   * Buffers NDJSON by line, then renders each event twice from one parse: ANSI
   * into the live terminal, Markdown into the transcript. The raw stream goes
   * to the log verbatim.
   */
  private onStdout(active: ActiveRun, chunk: string): void {
    active.lastOutputAtMs = Date.now();
    active.logStream.write(chunk);

    active.pending += chunk;
    const lines = active.pending.split('\n');
    active.pending = lines.pop() ?? '';

    for (const line of lines) {
      const { events, isResult } = parseLine(line);
      if (isResult) {
        active.lastResultLine = line;
      }

      for (const event of events) {
        const ansi = toAnsi(event);
        if (ansi) {
          this.write(active, `${ansi}\n`);
        }
        const markdown = toMarkdown(event);
        if (markdown) {
          active.resultStream?.write(`${markdown}\n\n`);
        }
      }
    }
  }

  /**
   * Closes the transcript and renames it to carry the outcome, so the results
   * folder answers "which nights failed" without opening anything.
   *
   * The rename waits for `close` rather than `finish`: Windows refuses to
   * rename a file whose handle is still open, and `finish` fires before the
   * descriptor is released.
   */
  private finishTranscript(active: ActiveRun, outcome: Outcome): Promise<string | undefined> {
    const stream = active.resultStream;
    const source = active.resultPath;
    if (!stream || !source) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const rename = () => {
        const target = withStatus(source, outcome.ok ? 'completed' : 'failed');
        try {
          fs.renameSync(source, target);
          resolve(target);
        } catch (err) {
          log.warn(`could not rename transcript: ${String(err)}`);
          resolve(source);
        }
      };

      stream.once('close', rename);
      stream.once('error', (err) => {
        log.warn(`transcript write failed: ${String(err)}`);
        resolve(source);
      });
      stream.end(transcriptFooter(outcome, Date.now() - active.startedAtMs));
    });
  }

  private async settle(active: ActiveRun, exitCode: number | null): Promise<void> {
    this.active.delete(active.runId);
    active.logStream.end();

    const outcome = resolveOutcome({
      exitCode,
      stdout: active.lastResultLine,
      killReason: active.killReason
    });

    const resultPath = await this.finishTranscript(active, outcome);

    this.write(
      active,
      `\r\n${outcome.ok ? '\x1b[32m✓ completed\x1b[0m' : `\x1b[31m✗ ${outcome.error ?? 'failed'}\x1b[0m`}\r\n` +
        '\x1b[2mRun finished. Close this tab when you are done reading it.\x1b[0m\r\n'
    );

    // Deliberately NOT firing `closer` here. Firing onDidClose tells VS Code the
    // pty exited and it disposes the tab — which, on a run lasting seconds, made
    // the terminal vanish before it could be read. The transcript stays on
    // screen until dismissed; the same text is on disk either way.

    await this.store.updateRun(active.runId, {
      status: outcome.ok ? 'completed' : 'failed',
      finishedAt: nowUtc(),
      exitCode: exitCode ?? undefined,
      sessionId: outcome.sessionId,
      costUsd: outcome.costUsd,
      denials: outcome.denials || undefined,
      authFailure: outcome.authFailure,
      result: outcome.resultText ? truncate(outcome.resultText, RESULT_MAX_CHARS) : undefined,
      resultPath,
      lastError: outcome.error ? truncateError(outcome.error) : undefined
    });

    log.info(
      `run ${active.runId} ${outcome.ok ? 'completed' : 'failed'}` +
        (outcome.denials ? ` with ${outcome.denials} permission denial(s)` : '')
    );

    this.finished.fire({ runId: active.runId, seriesId: active.seriesId, outcome });
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('chronus');
}

/**
 * Confirms the CLI is reachable before a task depends on it. Deliberately not
 * awaited during activation: a bad `claudePath` should surface as a setup
 * notice when you install, not as a failed run at 2am, and neither should cost
 * anyone a slow editor start.
 */
export function probeClaude(exe: string, timeoutMs = 5_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnClaude(exe, ['--version'], process.cwd());
    } catch (err) {
      resolve(`Could not start "${exe}": ${String(err)}`);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      resolve(`"${exe}" did not respond to --version within ${timeoutMs / 1000}s.`);
    }, timeoutMs);

    const settle = (problem: string | undefined) => {
      clearTimeout(timer);
      resolve(problem);
    };

    child.on('error', () => settle(`Could not run "${exe}". Check chronus.claudePath.`));
    child.on('close', (code) =>
      settle(code === 0 ? undefined : `"${exe} --version" exited with code ${code}.`)
    );
  });
}

/**
 * On Windows `claude` is a .cmd shim, which spawn cannot execute without a
 * shell. Under `shell: true` Node does not quote the executable, so a path
 * containing spaces has to be quoted here. Every argv entry is a fixed flag or
 * an enum value — the prompt travels on stdin, never the command line.
 */
function spawnClaude(exe: string, args: string[], cwd: string): ChildProcess {
  const isWindows = process.platform === 'win32';
  return spawn(isWindows ? `"${exe}"` : exe, args, {
    cwd,
    shell: isWindows,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

/**
 * Opens the run's transcript and writes its header. Returns undefined when
 * there is nowhere to write — the run still goes ahead without a record.
 */
function openTranscript(
  resultPath: string | undefined,
  series: TaskSeries,
  run: TaskRun,
  startedAt: Date
): fs.WriteStream | undefined {
  if (!resultPath) {
    return undefined;
  }

  try {
    const stream = fs.createWriteStream(resultPath, { flags: 'a' });
    stream.write(
      transcriptHeader({
        fileName: series.fileName,
        cwd: series.cwd,
        permissionMode: series.permissionMode,
        model: series.model,
        startedAt,
        attempt: run.attempt
      })
    );
    return stream;
  } catch (err) {
    log.warn(`could not open a transcript for run ${run.id}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Pure result interpretation. Deliberately free of any `vscode` import so it
 * can be exercised by a plain Node test runner.
 */

export type KillReason = 'idle' | 'runtime' | 'cancelled' | 'shutdown';

/**
 * What the stream said, folded down as it arrives.
 *
 * The stream used to be parsed twice — once per line for the transcript, then
 * again over a stashed line at the end for the outcome. That stash-one-line
 * trick only works for an engine with a single closing envelope, which Claude
 * has and opencode does not: opencode reports cost and turns once per *step*.
 * Accumulating as we parse works for both, and deletes the second parse.
 */
export interface RunSummary {
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  /** Tools blocked by permission gating. */
  denials: number;
  /** The agent's closing message — the newest one wins. */
  resultText?: string;
  /** A terminal event was seen at all. Exit 0 without one means truncated. */
  sawResult: boolean;
  /** The engine reported the run itself as failed. */
  isError: boolean;
  /** HTTP status of an API error, where the engine reports one. */
  apiErrorStatus?: string;
}

export function emptySummary(): RunSummary {
  return { denials: 0, sawResult: false, isError: false };
}

/**
 * Folds one parsed line into the running total. One merge serves both engines:
 * only cost and turns accumulate, because only opencode splits them across
 * steps — Claude states each once, and adding a single value yields that value.
 * Everything else is the newest statement winning, which is what made the old
 * "last result event wins" rule right and still is.
 */
export function foldSummary(into: RunSummary, add: Partial<RunSummary>): void {
  if (add.costUsd !== undefined) {
    into.costUsd = (into.costUsd ?? 0) + add.costUsd;
  }
  if (add.numTurns !== undefined) {
    into.numTurns = (into.numTurns ?? 0) + add.numTurns;
  }
  if (add.sessionId) {
    into.sessionId = add.sessionId;
  }
  if (add.resultText) {
    into.resultText = add.resultText;
  }
  if (add.denials !== undefined) {
    into.denials = add.denials;
  }
  if (add.isError !== undefined) {
    into.isError = add.isError;
  }
  if (add.apiErrorStatus) {
    into.apiErrorStatus = add.apiErrorStatus;
  }
  // Never unset: a run that produced a terminal event produced one.
  if (add.sawResult) {
    into.sawResult = true;
  }
}

export interface Outcome {
  ok: boolean;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  /** Tools blocked by permission gating. A run can succeed with denials. */
  denials: number;
  /**
   * The agent's closing message, whatever the outcome. On a failure `error`
   * usually carries the same text; on a success this is the only place it
   * survives, and for a task that ran unattended it is the entire point.
   */
  resultText?: string;
  /** False when retrying cannot plausibly help. */
  retryable: boolean;
  /**
   * Credentials, not the plan, are the problem. Reported distinctly because an
   * expired token fails every task identically — three retries an hour apart
   * only delay the discovery by three hours.
   */
  authFailure?: boolean;
}

/**
 * Auth-shaped failures. Matched against the result text because the CLI does
 * not expose a machine-readable auth code on every path.
 *
 * NOTE: these patterns are inferred, not observed — no real auth failure has
 * been captured yet. Kept as a flat list so correcting them against real output
 * is a one-line change. See COMPLETION-PLAN.md Sprint 12 step 22.
 */
const AUTH_PATTERNS = [
  /invalid api key/i,
  /authentication[_ ]error/i,
  /unauthorized/i,
  /oauth token (has )?expired/i,
  /please run [`"']?\/login/i,
  /not logged in/i
];

/** Names the engine, since either one's credentials can be the problem. */
export function authErrorMessage(engine: string): string {
  return `Authentication required — the ${engine} CLI rejected your credentials. Retrying will not help.`;
}

function looksLikeAuthFailure(summary: RunSummary): boolean {
  if (summary.apiErrorStatus === '401' || summary.apiErrorStatus === '403') {
    return true;
  }
  return AUTH_PATTERNS.some((pattern) => pattern.test(summary.resultText ?? ''));
}

/**
 * Whether a running process should be killed, and why. Compares wall-clock
 * timestamps rather than trusting timer fidelity: Windows suspends timers
 * during sleep and fires them on resume, which would otherwise kill a task that
 * had only just woken up.
 */
export function watchdogVerdict(
  run: { startedAtMs: number; lastOutputAtMs: number; killReason?: KillReason },
  now: number,
  idleMs: number,
  maxMs: number
): KillReason | undefined {
  if (run.killReason) {
    return undefined; // Already being killed; do not stack a second reason.
  }
  if (now - run.startedAtMs > maxMs) {
    return 'runtime';
  }
  if (now - run.lastOutputAtMs > idleMs) {
    return 'idle';
  }
  return undefined;
}

const KILL_MESSAGES: Record<KillReason, string> = {
  idle: 'Killed — no output within the idle timeout.',
  runtime: 'Killed — exceeded the maximum runtime.',
  cancelled: 'Cancelled.',
  shutdown: 'Interrupted — VS Code shut down during execution.'
};

/**
 * The verdict on a finished run. The ladder is unchanged from when this read
 * raw stdout — a kill is authoritative, then auth, then the exit code, then a
 * missing result, then a reported error — it just reads fields now instead of
 * re-parsing the stream.
 */
export function resolveOutcome(input: {
  exitCode: number | null;
  summary: RunSummary;
  killReason?: KillReason;
  /** The engine, named in the messages below. */
  engine?: string;
}): Outcome {
  const { summary } = input;
  const engine = input.engine ?? 'claude';
  const base = {
    sessionId: summary.sessionId,
    costUsd: summary.costUsd,
    numTurns: summary.numTurns,
    denials: summary.denials,
    resultText: summary.resultText
  };

  // A kill is authoritative regardless of what the stream contained.
  if (input.killReason) {
    return {
      ...base,
      ok: false,
      error: KILL_MESSAGES[input.killReason],
      retryable: input.killReason !== 'cancelled'
    };
  }

  // Only consult the auth patterns once the run has actually failed. A healthy
  // run whose output merely *discusses* a 401 must not be misread as one.
  const failed = input.exitCode !== 0 || summary.isError;
  if (failed && looksLikeAuthFailure(summary)) {
    return {
      ...base,
      ok: false,
      error: authErrorMessage(engine),
      retryable: false,
      authFailure: true
    };
  }

  if (input.exitCode !== 0) {
    return {
      ...base,
      ok: false,
      error: summary.resultText ?? `${engine} exited with code ${input.exitCode}.`,
      retryable: true
    };
  }

  // Exit 0 with no result event means the contract was not met. Treating this
  // as success would silently mark an unfinished plan complete.
  if (!summary.sawResult) {
    return {
      ...base,
      ok: false,
      error: 'No result event in output — could not confirm the run completed.',
      retryable: true
    };
  }

  if (summary.isError) {
    return {
      ...base,
      ok: false,
      error: summary.resultText ?? 'Run reported an error.',
      retryable: true
    };
  }

  return { ...base, ok: true, retryable: false };
}

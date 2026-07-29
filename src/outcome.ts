/**
 * Pure result interpretation. Deliberately free of any `vscode` import so it
 * can be exercised by a plain Node test runner.
 */

export type KillReason = 'idle' | 'runtime' | 'cancelled' | 'shutdown';

/** The final `type: "result"` event emitted by `--output-format stream-json`. */
export interface ResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
  permission_denials?: unknown[];
  api_error_status?: unknown;
  terminal_reason?: string;
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

export const AUTH_ERROR_MESSAGE =
  'Authentication required — the Claude CLI rejected your credentials. Retrying will not help.';

function looksLikeAuthFailure(envelope: ResultEnvelope | undefined): boolean {
  if (!envelope) {
    return false;
  }
  const status = String(envelope.api_error_status ?? '');
  if (status === '401' || status === '403') {
    return true;
  }
  const text = envelope.result ?? '';
  return AUTH_PATTERNS.some((pattern) => pattern.test(text));
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

/** Last `type: "result"` line wins; earlier lines are progress events. */
export function parseResultEnvelope(stdout: string): ResultEnvelope | undefined {
  let found: ResultEnvelope | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as ResultEnvelope;
      if (parsed.type === 'result') {
        found = parsed;
      }
    } catch {
      // Progress lines can be truncated mid-stream; ignore and keep scanning.
    }
  }
  return found;
}

export function resolveOutcome(input: {
  exitCode: number | null;
  stdout: string;
  killReason?: KillReason;
}): Outcome {
  const envelope = parseResultEnvelope(input.stdout);
  const base = {
    sessionId: envelope?.session_id,
    costUsd: envelope?.total_cost_usd,
    numTurns: envelope?.num_turns,
    denials: envelope?.permission_denials?.length ?? 0,
    resultText: envelope?.result
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
  const failed = input.exitCode !== 0 || envelope?.is_error === true;
  if (failed && looksLikeAuthFailure(envelope)) {
    return {
      ...base,
      ok: false,
      error: AUTH_ERROR_MESSAGE,
      retryable: false,
      authFailure: true
    };
  }

  if (input.exitCode !== 0) {
    return {
      ...base,
      ok: false,
      error: envelope?.result ?? `claude exited with code ${input.exitCode}.`,
      retryable: true
    };
  }

  // Exit 0 with no result event means the contract was not met. Treating this
  // as success would silently mark an unfinished plan complete.
  if (!envelope) {
    return {
      ...base,
      ok: false,
      error: 'No result event in output — could not confirm the run completed.',
      retryable: true
    };
  }

  if (envelope.is_error) {
    return {
      ...base,
      ok: false,
      error: envelope.result ?? `Run reported an error (${envelope.subtype ?? 'unknown'}).`,
      retryable: true
    };
  }

  return { ...base, ok: true, retryable: false };
}

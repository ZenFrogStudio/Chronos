/** Permission modes accepted by the `claude` CLI's --permission-mode flag. */
export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'manual'
  | 'plan';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'missed'
  | 'cancelled';

export type MissedReason = 'sleep' | 'not-running';

/**
 * A recurrence rule. Stored as local wall-clock time on purpose: "every
 * weekday at 09:00" means 09:00 as the clock reads it, on both sides of a DST
 * boundary. Concrete UTC instants are derived from this, never incremented.
 */
export interface Recurrence {
  /** 0 = Sunday .. 6 = Saturday. Daily is simply all seven. */
  daysOfWeek: number[];
  /** "HH:MM", 24-hour, local time. */
  timeLocal: string;
}

/** The definition: what you create when you drop a file. */
export interface TaskSeries {
  id: string;
  filePath: string;
  /** Basename, for display only. */
  fileName: string;
  /** Working directory for the claude process. */
  cwd: string;
  permissionMode: PermissionMode;
  model?: string;
  /** null = one-shot. */
  recurrence: Recurrence | null;
  /** ISO 8601 UTC. The only field the scheduler tick reads. */
  nextRunAt: string;
  /**
   * User-controlled pause. False stops future occurrences *and* any retry
   * already queued — pausing a broken task should stop all of it.
   */
  enabled: boolean;
  /**
   * A one-shot that has already fired or been missed. Distinct from `enabled`
   * on purpose: conflating "spent" with "paused" strands a materialised run
   * that has not found a concurrency slot yet.
   */
  spent?: boolean;
  maxRetries: number;
  createdAt: string;
}

/** One execution attempt. Immutable history once finished. */
export interface TaskRun {
  id: string;
  seriesId: string;
  /** ISO 8601 UTC — the occurrence this run was due for. */
  scheduledAt: string;
  status: RunStatus;
  /** 1 = first try, 2+ = retry. */
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  lastError?: string;
  /** From claude's JSON output; enables --resume later. */
  sessionId?: string;
  costUsd?: number;
  /** Tools blocked by permission gating. A run can succeed with denials. */
  denials?: number;
  logPath?: string;
  /**
   * The agent's closing message, trimmed for display on a card. A scheduled run
   * is read after the fact, so "it completed" is not an answer on its own —
   * this is what it actually said. Full text lives in the transcript.
   */
  result?: string;
  /** Readable Markdown transcript of the run, on disk beside the raw log. */
  resultPath?: string;
  missedAt?: string;
  missedReason?: MissedReason;
  /** Occurrences collapsed into this one missed run. Absent means 1. */
  missedCount?: number;
  /**
   * Created by an explicit "Run now" rather than by the schedule. Manual runs
   * fire on a disabled series; scheduled runs and retries do not.
   */
  manual?: boolean;
  /** Credentials were rejected. Rendered distinctly; never retried. */
  authFailure?: boolean;
}

export interface ChronusState {
  schemaVersion: number;
  series: TaskSeries[];
  runs: TaskRun[];
}

/**
 * Bump only alongside a step in `migrate()`. The store upgrades known older
 * versions; it does not discard them.
 */
export const SCHEMA_VERSION = 3;
export const STORE_KEY = 'chronus.state';

/** Scheduler tick. A gap larger than 3x this means the process was suspended. */
export const TICK_MS = 30_000;

/** Every day of the week — the "daily" recurrence. */
export const DAILY: number[] = [0, 1, 2, 3, 4, 5, 6];

/** Finished runs retained in history. Recurring series would grow unbounded. */
export const MAX_RECENT_RUNS = 50;

/** Error text stored per run. */
export const ERROR_MAX_CHARS = 500;

/**
 * Result text stored per run. Capped because the store lives in `globalState`,
 * which is not the place for a full transcript — that goes on disk.
 */
export const RESULT_MAX_CHARS = 600;

export function isFinished(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

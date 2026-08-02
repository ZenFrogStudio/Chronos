import { TaskRun, TaskSeries } from './types';

/**
 * What leaves the machine, and nothing else.
 *
 * Pure — no `vscode`, no network — so the privacy boundary is a unit test
 * rather than a matter of care. Both mappers below are written out field by
 * field on purpose: a spread of the source object would silently start sending
 * every field added to `TaskSeries` or `TaskRun` from then on, and the first
 * time anyone noticed would be after it had happened.
 */

/** A series as the phone sees it. No local filesystem paths. */
export interface RemoteSeries {
  id: string;
  fileName: string;
  /** Displayed, never remotely writable — changing it is privilege escalation. */
  permissionMode: string;
  model?: string;
  recurrence: TaskSeries['recurrence'];
  nextRunAt: string;
  enabled: boolean;
  spent?: boolean;
  maxRetries: number;
  createdAt: string;
}

/** A run as the phone sees it. Summary only; the transcript is fetched separately. */
export interface RemoteRun {
  id: string;
  seriesId: string;
  scheduledAt: string;
  status: string;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  costUsd?: number;
  denials?: number;
  /** The agent's closing message, already capped at RESULT_MAX_CHARS locally. */
  result?: string;
  lastError?: string;
  missedAt?: string;
  missedReason?: string;
  missedCount?: number;
  authFailure?: boolean;
}

/**
 * `filePath` and `cwd` are absolute paths into the user's filesystem. The phone
 * displays `fileName`, so putting them on the wire would publish the machine's
 * directory layout in exchange for nothing.
 */
export function toRemoteSeries(series: TaskSeries): RemoteSeries {
  return {
    id: series.id,
    fileName: series.fileName,
    permissionMode: series.permissionMode,
    model: series.model,
    recurrence: series.recurrence,
    nextRunAt: series.nextRunAt,
    enabled: series.enabled,
    spent: series.spent,
    maxRetries: series.maxRetries,
    createdAt: series.createdAt
  };
}

/**
 * `logPath` and `resultPath` are local paths; the transcript is fetched by run
 * id instead, and the server resolves the path itself. `sessionId` would let a
 * holder of the response resume the agent's conversation, and `exitCode` means
 * nothing on a phone.
 */
export function toRemoteRun(run: TaskRun): RemoteRun {
  return {
    id: run.id,
    seriesId: run.seriesId,
    scheduledAt: run.scheduledAt,
    status: run.status,
    attempt: run.attempt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    costUsd: run.costUsd,
    denials: run.denials,
    result: run.result,
    lastError: run.lastError,
    missedAt: run.missedAt,
    missedReason: run.missedReason,
    missedCount: run.missedCount,
    authFailure: run.authFailure
  };
}

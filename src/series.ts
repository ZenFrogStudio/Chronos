import * as path from 'path';
import * as vscode from 'vscode';
import { newId } from './store';
import { nowUtc } from './time';
import { PermissionMode, TaskSeries } from './types';

/**
 * `auto` rather than `bypassPermissions`: a new task gets the CLI's own
 * judgement about what is safe to do unattended, instead of a blanket waiver.
 * The old default meant unrestricted tool access on a schedule, and one bad
 * plan on a recurring series repeats that indefinitely.
 *
 * The cost is exactly why it used to be `bypassPermissions`. A mode that can
 * still stop and ask has nobody to ask at 3am, so a run may end having done
 * only part of the job. Reviewing the plan before scheduling it is still the
 * real safety step, and `bypassPermissions` stays one click away per task.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * Working directory for the claude process. Prefers the workspace folder that
 * actually contains the plan file, since a plan may live outside the project
 * it targets.
 */
export function defaultCwd(filePath: string): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return path.dirname(filePath);
  }
  const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  return (owner ?? folders[0]).uri.fsPath;
}

/** One hour out, rounded up to the next quarter hour. */
export function defaultScheduledAt(from: Date = new Date()): string {
  const target = new Date(from.getTime() + 60 * 60_000);
  target.setSeconds(0, 0);
  const minutes = target.getMinutes();
  target.setMinutes(minutes + ((15 - (minutes % 15)) % 15));
  return target.toISOString();
}

export function createSeries(
  filePath: string,
  overrides: Partial<TaskSeries> = {}
): TaskSeries {
  const config = vscode.workspace.getConfiguration('chronos');
  return {
    id: newId(),
    filePath,
    fileName: path.basename(filePath),
    cwd: defaultCwd(filePath),
    permissionMode: DEFAULT_PERMISSION_MODE,
    recurrence: null,
    nextRunAt: defaultScheduledAt(),
    enabled: true,
    maxRetries: config.get<number>('maxRetries', 3),
    createdAt: nowUtc(),
    ...overrides
  };
}

import * as path from 'path';
import * as vscode from 'vscode';
import { newId } from './store';
import { nowUtc } from './time';
import { PermissionMode, TaskSeries } from './types';

/**
 * Full auto, deliberately. Chronus exists to run plans while nobody is at the
 * keyboard, and every gentler mode blocks on a prompt that no one is there to
 * answer — the run then exits 0 having quietly done a fraction of the work.
 * Reviewing the plan before scheduling it is the safety step; a permission
 * dialog fired at 3am is not.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

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
  const config = vscode.workspace.getConfiguration('chronus');
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

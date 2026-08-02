import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Chronus');
  context.subscriptions.push(channel);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function write(level: string, message: string): void {
  channel?.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
}

/**
 * Drops raw run logs past the retention window. Best-effort, and deliberately
 * only the raw stream: the readable Markdown transcripts are the record of what
 * ran unattended, and they are kept indefinitely.
 */
export function pruneLogs(dir: string, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  let removed = 0;

  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        // A log being read or already gone is not worth failing activation for.
      }
    }
  } catch {
    return; // Directory does not exist yet.
  }

  if (removed > 0) {
    write('info', `pruned ${removed} log file(s) older than ${retentionDays} days`);
  }
}

export const log = {
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string, err?: unknown) =>
    write('error', err === undefined ? message : `${message} — ${describe(err)}`),
  show: () => channel?.show(true)
};
